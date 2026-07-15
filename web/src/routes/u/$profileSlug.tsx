import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { CopyPlus, ListOrdered } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { BrandLink } from "@/components/ui/BrandLink";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectTrigger,
    SelectValue
} from "@/components/ui/select";
import { showToast } from "@/lib/toast";
import { redirectIfUnauthorized } from "@/lib/errors";
import { followButtonLabel, followRelationLabel } from "@/lib/follows";
import { hasStoredImage, isNoImageKey } from "@/lib/images";
import { nextMultiSelection } from "@/lib/multiSelect";
import { orderEntries } from "@/lib/ranking";
import {
    approveFollowRequest,
    cancelFollowRequest,
    copyPublicCategoryToQueue,
    followProfile,
    loadPublicProfile,
    removeFollow
} from "@/server/profiles";
import type { CategoryWithEntries, Entry, PublicProfileData } from "@/lib/types";

const POSTER_CLASS =
    "aspect-[4/5] bg-[image:linear-gradient(135deg,var(--poster-start),var(--poster-end))] text-center text-muted-foreground";
type CopyMode = "new" | "merge";

export const Route = createFileRoute("/u/$profileSlug")({
    loader: async ({ params }) => {
        const data = await loadPublicProfile({ data: { profileSlug: params.profileSlug } });
        if (!data) {
            throw notFound();
        }

        return data;
    },
    component: PublicProfileRoute,
    notFoundComponent: ProfileNotFound
});

function ProfileNotFound() {
    return (
        <main className="grid min-h-screen content-start gap-4 bg-background px-[clamp(1rem,3vw,2.25rem)] py-5 text-foreground">
            <PublicProfileTopbar signedIn={false} />
            <Card className="grid w-[min(100%,34rem)] gap-4 px-4 shadow-panel">
                <h1 className="text-2xl font-bold">Profile Not Found</h1>
                <p className="text-muted-foreground">This profile is private or does not exist.</p>
            </Card>
        </main>
    );
}

function PublicProfileRoute() {
    const loaderData = Route.useLoaderData();
    const [profileData, setProfileData] = useState<PublicProfileData | null>(loaderData);
    const [followSaving, setFollowSaving] = useState(false);
    const [copyingCategoryId, setCopyingCategoryId] = useState<string | null>(null);
    const [copyDialogCategory, setCopyDialogCategory] = useState<CategoryWithEntries | null>(null);
    const [copyMode, setCopyMode] = useState<CopyMode>("new");
    const [copyCategoryName, setCopyCategoryName] = useState("");
    const [copyTargetCategoryId, setCopyTargetCategoryId] = useState("");
    const entryScrollRef = useRef<HTMLDivElement | null>(null);
    const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
        loaderData?.categories[0]?.id ?? null
    );

    useEffect(() => {
        setProfileData(loaderData);
        setSelectedCategoryId(loaderData?.categories[0]?.id ?? null);
        setCopyDialogCategory(null);
    }, [loaderData]);

    async function handleFollowAction() {
        if (!profileData || profileData.viewer.isSelf) {
            return;
        }

        setFollowSaving(true);

        try {
            const currentRelation = profileData.viewer.relationState;
            let nextRelation = currentRelation;
            let message = "Profile followed.";

            if (currentRelation === "incoming_request") {
                const result = await approveFollowRequest({
                    data: { followerUserId: profileData.profile.userId }
                });
                nextRelation = result.relationState;
                message = "Follow request accepted.";
            } else if (currentRelation === "requested") {
                await cancelFollowRequest({ data: { followedUserId: profileData.profile.userId } });
                nextRelation = "none";
                message = "Follow request canceled.";
            } else if (currentRelation === "following" || currentRelation === "mutual") {
                await removeFollow({ data: { followedUserId: profileData.profile.userId } });
                nextRelation = currentRelation === "mutual" ? "follows_you" : "none";
                message = "Profile unfollowed.";
            } else {
                const result = await followProfile({ data: { profileUserId: profileData.profile.userId } });
                nextRelation = result.relationState;
                message = nextRelation === "requested" ? "Follow request sent." : "Profile followed.";
            }

            setProfileData({
                ...profileData,
                profile: {
                    ...profileData.profile,
                    relationState: nextRelation
                },
                viewer: {
                    ...profileData.viewer,
                    relationState: nextRelation
                }
            });
            showToast(message, "success");
        } catch (followError) {
            if (redirectIfUnauthorized(followError)) {
                return;
            }

            showToast(followError instanceof Error ? followError.message : String(followError), "danger");
        } finally {
            setFollowSaving(false);
        }
    }

    function openCopyDialog(category: CategoryWithEntries) {
        if (!profileData || !profileData.viewer.isSignedIn || profileData.viewer.isSelf) {
            return;
        }

        setCopyDialogCategory(category);
        setCopyMode("new");
        setCopyCategoryName(category.name);
        setCopyTargetCategoryId(profileData.viewer.categories[0]?.id ?? "");
    }

    function selectCategory(categoryId: string) {
        setSelectedCategoryId(categoryId);
        entryScrollRef.current?.scrollTo({ top: 0 });
    }

    async function handleCopyCategory(sourceEntryIds: string[]) {
        if (!profileData || !copyDialogCategory || !profileData.viewer.isSignedIn || profileData.viewer.isSelf) {
            return;
        }

        if (sourceEntryIds.length === 0) {
            showToast("Select at least one entry to copy", "danger");
            return;
        }

        const cleanCategoryName = copyCategoryName.trim();
        if (copyMode === "new") {
            if (!cleanCategoryName) {
                showToast("Category name is required", "danger");
                return;
            }
            if (profileData.viewer.categories.some((category) => category.name === cleanCategoryName)) {
                showToast("That category name already exists", "danger");
                return;
            }
        }

        if (copyMode === "merge" && !copyTargetCategoryId) {
            showToast("Choose a category to merge into", "danger");
            return;
        }

        setCopyingCategoryId(copyDialogCategory.id);

        try {
            const result = await copyPublicCategoryToQueue({
                data: copyMode === "new"
                    ? {
                        sourceCategoryId: copyDialogCategory.id,
                        mode: "new",
                        categoryName: cleanCategoryName,
                        sourceEntryIds
                    }
                    : {
                        sourceCategoryId: copyDialogCategory.id,
                        mode: "merge",
                        targetCategoryId: copyTargetCategoryId,
                        sourceEntryIds
                    }
            });
            if (copyMode === "new") {
                setProfileData({
                    ...profileData,
                    viewer: {
                        ...profileData.viewer,
                        categories: [
                            ...profileData.viewer.categories,
                            { id: result.categoryId, name: result.categoryName }
                        ]
                    }
                });
            }
            setCopyDialogCategory(null);
            const copyMessage = result.copiedCount > 0
                ? `Copied ${result.copiedCount} ${result.copiedCount === 1 ? "entry" : "entries"} to ${result.categoryName}.`
                : `No new entries copied to ${result.categoryName}.`;
            const skippedMessage = result.skippedCount > 0
                ? ` Skipped ${result.skippedCount} duplicate${result.skippedCount === 1 ? "" : "s"}.`
                : "";
            showToast(
                `${copyMessage}${skippedMessage}`,
                result.copiedCount > 0 ? "success" : "default"
            );
        } catch (copyError) {
            if (redirectIfUnauthorized(copyError)) {
                return;
            }

            showToast(copyError instanceof Error ? copyError.message : String(copyError), "danger");
        } finally {
            setCopyingCategoryId(null);
        }
    }

    if (!profileData) {
        return (
            <main className="grid min-h-screen content-start gap-4 bg-background px-[clamp(1rem,3vw,2.25rem)] py-5 text-foreground">
                <PublicProfileTopbar signedIn={false} />
                <Card className="grid w-[min(100%,34rem)] gap-4 px-4 shadow-panel">
                    <h1 className="text-2xl font-bold">Profile Not Found</h1>
                    <p className="text-muted-foreground">This profile is private or does not exist.</p>
                </Card>
            </main>
        );
    }

    const { profile, viewer } = profileData;

    return (
        <main className="grid h-dvh min-h-screen grid-rows-[auto_auto_minmax(0,1fr)] gap-4 overflow-hidden bg-background px-[clamp(1rem,3vw,2.25rem)] py-5 text-foreground max-[720px]:h-auto max-[720px]:grid-rows-none max-[720px]:overflow-visible">
            <PublicProfileTopbar signedIn={viewer.isSignedIn} />

            <Card className="min-w-0 flex-row items-center justify-end gap-[0.8rem] px-4 shadow-panel">
                <PublicProfileAvatar
                    imageKey={profile.imageKey}
                    isSelf={viewer.isSelf}
                    userId={profile.userId}
                />
                <div>
                    <h1 className="text-2xl font-bold">{profile.name}</h1>
                    <p className="text-muted-foreground">
                        @{profile.slug}
                        {!viewer.isSelf && viewer.isSignedIn
                            ? ` · ${followRelationLabel(viewer.relationState)}`
                            : null}
                    </p>
                </div>
                <div className="flex justify-end">
                    {viewer.isSelf ? (
                        <Button asChild variant="outline">
                            <Link to="/profile">Edit Profile</Link>
                        </Button>
                    ) : viewer.isSignedIn ? (
                        <Button
                            disabled={followSaving}
                            type="button"
                            onClick={() => void handleFollowAction()}
                        >
                            {followSaving ? "Saving..." : followButtonLabel(viewer.relationState)}
                        </Button>
                    ) : (
                        <Button asChild variant="outline">
                            <Link to="/">Sign In</Link>
                        </Button>
                    )}
                </div>
            </Card>

            {profileData.categories.length > 0 ? (
                <div className="m-0 grid min-h-0 w-full grid-cols-[220px_minmax(0,1fr)] items-stretch overflow-hidden rounded-md border border-border bg-card shadow-panel max-[720px]:grid-cols-1 max-[720px]:overflow-visible">
                    <nav className="grid min-h-0 content-start gap-0.5 overflow-y-auto border-r border-border bg-sidebar p-[0.65rem] max-[720px]:flex max-[720px]:max-h-none max-[720px]:flex-row max-[720px]:flex-nowrap max-[720px]:gap-1 max-[720px]:overflow-x-auto max-[720px]:overflow-y-hidden max-[720px]:border-r-0 max-[720px]:border-b max-[720px]:p-2" aria-label="Categories">
                        {profileData.categories.map((category) => {
                            const isActive = category.id === selectedCategoryId;
                            return (
                                <button
                                    className={`w-full rounded-sm border px-[0.65rem] py-2 text-left shadow-none enabled:hover:border-border enabled:hover:bg-secondary max-[720px]:w-auto max-[720px]:flex-none ${isActive
                                        ? "border-primary bg-accent font-bold text-accent-strong"
                                        : "border-transparent bg-transparent"
                                        }`}
                                    key={category.id}
                                    type="button"
                                    aria-current={isActive ? "true" : undefined}
                                    onClick={() => selectCategory(category.id)}
                                >
                                    <span className="block min-w-0 truncate text-[0.92rem]">{category.name}</span>
                                </button>
                            );
                        })}
                    </nav>
                    <div ref={entryScrollRef} className="min-h-0 min-w-0 overflow-y-auto p-4 max-[720px]:overflow-visible">
                        {(() => {
                            const category = profileData.categories.find(
                                (c) => c.id === selectedCategoryId
                            );
                            if (!category) return null;
                            return (
                                <PublicCategory
                                    category={category}
                                    copyDisabled={copyingCategoryId === category.id}
                                    onCopy={
                                        viewer.isSignedIn && !viewer.isSelf
                                            ? () => openCopyDialog(category)
                                            : undefined
                                    }
                                    usePrivateImages={viewer.isSelf}
                                />
                            );
                        })()}
                    </div>
                </div>
            ) : (
                <EmptyState className="m-0 w-full" icon={ListOrdered} title="No Shared Rankings">
                    Shared lists will appear here.
                </EmptyState>
            )}

            <CopyCategoryDialog
                category={copyDialogCategory}
                categoryName={copyCategoryName}
                mode={copyMode}
                saving={Boolean(copyingCategoryId)}
                targetCategories={viewer.categories}
                targetCategoryId={copyTargetCategoryId}
                onCancel={() => setCopyDialogCategory(null)}
                onCategoryNameChange={setCopyCategoryName}
                onModeChange={(mode) => {
                    setCopyMode(mode);
                    if (mode === "merge" && !copyTargetCategoryId) {
                        setCopyTargetCategoryId(viewer.categories[0]?.id ?? "");
                    }
                }}
                onSubmit={(sourceEntryIds) => void handleCopyCategory(sourceEntryIds)}
                onTargetCategoryIdChange={setCopyTargetCategoryId}
            />
        </main>
    );
}

function PublicProfileTopbar({ signedIn }: { signedIn: boolean }) {
    return (
        <header className="m-0 flex w-full flex-wrap items-center justify-between gap-3">
            <BrandLink />
            <nav className="flex flex-wrap items-center justify-end gap-[0.8rem]" aria-label="Profile navigation">
                {signedIn ? (
                    <>
                        <Link className="text-foreground no-underline hover:text-accent-strong" to="/">Rankings</Link>
                        <Link className="text-foreground no-underline hover:text-accent-strong" to="/profile">Profile</Link>
                    </>
                ) : (
                    <Link className="text-foreground no-underline hover:text-accent-strong" to="/">Sign In</Link>
                )}
            </nav>
        </header>
    );
}

function CopyCategoryDialog({
    category,
    categoryName,
    mode,
    saving,
    targetCategories,
    targetCategoryId,
    onCancel,
    onCategoryNameChange,
    onModeChange,
    onSubmit,
    onTargetCategoryIdChange
}: {
    category: CategoryWithEntries | null;
    categoryName: string;
    mode: CopyMode;
    saving: boolean;
    targetCategories: PublicProfileData["viewer"]["categories"];
    targetCategoryId: string;
    onCancel: () => void;
    onCategoryNameChange: (name: string) => void;
    onModeChange: (mode: CopyMode) => void;
    onSubmit: (sourceEntryIds: string[]) => void;
    onTargetCategoryIdChange: (categoryId: string) => void;
}) {
    const orderedEntries = useMemo(
        () => category ? orderEntries(category.entries) : [],
        [category]
    );
    const [entrySearch, setEntrySearch] = useState("");
    const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
    const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);

    useEffect(() => {
        if (!category) {
            return;
        }

        const nextEntries = orderEntries(category.entries);
        setEntrySearch("");
        setSelectedEntryIds(new Set(nextEntries.map((entry) => entry.id)));
        setSelectionAnchorId(null);
    }, [category]);

    if (!category) {
        return null;
    }

    const cleanCategoryName = categoryName.trim();
    const duplicateCategoryName = targetCategories.some(
        (targetCategory) => targetCategory.name === cleanCategoryName
    );
    const searchTerm = entrySearch.trim().toLowerCase();
    const visibleEntries = searchTerm
        ? orderedEntries.filter((entry) => entry.name.toLowerCase().includes(searchTerm))
        : orderedEntries;
    const orderedEntryIds = visibleEntries.map((entry) => entry.id);
    const selectedOrderedEntryIds = orderedEntries
        .filter((entry) => selectedEntryIds.has(entry.id))
        .map((entry) => entry.id);
    const entryPositionById = new Map(orderedEntries.map((entry, index) => [entry.id, index + 1]));
    const submitDisabled = saving ||
        (mode === "new" && (!cleanCategoryName || duplicateCategoryName)) ||
        (mode === "merge" && !targetCategoryId) ||
        selectedOrderedEntryIds.length === 0;

    function handleSelectEntry(entryId: string, event: MouseEvent) {
        if (saving) {
            return;
        }

        const nextSelection = nextMultiSelection({
            anchorId: selectionAnchorId,
            clickedId: entryId,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            orderedIds: orderedEntryIds,
            plainBehavior: "toggle",
            selectedIds: selectedEntryIds,
            shiftKey: event.shiftKey
        });
        setSelectedEntryIds(nextSelection.selectedIds);
        setSelectionAnchorId(nextSelection.anchorId);
    }

    function selectVisible() {
        setSelectedEntryIds((currentSelectedIds) => new Set([
            ...currentSelectedIds,
            ...orderedEntryIds
        ]));
        setSelectionAnchorId(orderedEntryIds.at(-1) ?? selectionAnchorId);
    }

    function deselectVisible() {
        setSelectedEntryIds((currentSelectedIds) => {
            const nextSelectedIds = new Set(currentSelectedIds);
            for (const id of orderedEntryIds) {
                nextSelectedIds.delete(id);
            }
            return nextSelectedIds;
        });
        setSelectionAnchorId(orderedEntryIds.at(-1) ?? selectionAnchorId);
    }

    return (
        <AlertDialog
            open
            onOpenChange={(open) => {
                if (!open && !saving) {
                    onCancel();
                }
            }}
        >
            <AlertDialogContent className="max-w-[min(calc(100vw-2rem),44rem)] sm:max-w-[44rem]">
                <AlertDialogHeader>
                    <AlertDialogTitle>Copy {category.name}</AlertDialogTitle>
                    <AlertDialogDescription>
                        Queue these entries for your own ranking.
                    </AlertDialogDescription>
                </AlertDialogHeader>

                <div className="grid gap-4">
                    <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted p-1">
                        <button
                            className={`rounded-sm px-3 py-2 text-sm font-semibold transition-colors ${mode === "new"
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                                }`}
                            type="button"
                            aria-pressed={mode === "new"}
                            onClick={() => onModeChange("new")}
                        >
                            New category
                        </button>
                        <button
                            className={`rounded-sm px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${mode === "merge"
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                                }`}
                            type="button"
                            aria-pressed={mode === "merge"}
                            disabled={targetCategories.length === 0}
                            onClick={() => onModeChange("merge")}
                        >
                            Merge
                        </button>
                    </div>

                    {mode === "new" ? (
                        <label className="grid gap-1.5 text-sm font-semibold">
                            Category name
                            <Input
                                aria-invalid={duplicateCategoryName || !cleanCategoryName}
                                autoFocus
                                value={categoryName}
                                onChange={(event) => onCategoryNameChange(event.currentTarget.value)}
                            />
                            {duplicateCategoryName ? (
                                <span className="text-xs font-medium text-destructive">
                                    You already have a category with that name.
                                </span>
                            ) : null}
                        </label>
                    ) : (
                        <label className="grid gap-1.5 text-sm font-semibold">
                            Existing category
                            <Select
                                value={targetCategoryId}
                                onValueChange={onTargetCategoryIdChange}
                            >
                                <SelectTrigger aria-label="Existing category" className="w-full">
                                    <SelectValue placeholder="Choose category" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        {targetCategories.map((targetCategory) => (
                                            <SelectItem key={targetCategory.id} value={targetCategory.id}>
                                                {targetCategory.name}
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </label>
                    )}

                    <section className="grid gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <strong className="text-sm">Entries</strong>
                            <span className="text-sm text-muted-foreground">
                                {selectedOrderedEntryIds.length} of {orderedEntries.length} selected
                            </span>
                        </div>
                        <Input
                            aria-label="Search entries to copy"
                            disabled={saving}
                            placeholder="Search entries"
                            value={entrySearch}
                            onChange={(event) => setEntrySearch(event.currentTarget.value)}
                        />
                        <div className="flex flex-wrap gap-2">
                            <Button
                                disabled={saving || visibleEntries.length === 0}
                                size="sm"
                                type="button"
                                variant="outline"
                                onClick={selectVisible}
                            >
                                Select visible
                            </Button>
                            <Button
                                disabled={saving || visibleEntries.length === 0}
                                size="sm"
                                type="button"
                                variant="outline"
                                onClick={deselectVisible}
                            >
                                Deselect visible
                            </Button>
                        </div>
                        <div className="grid max-h-[min(42vh,22rem)] min-h-0 gap-1 overflow-y-auto rounded-md border border-border bg-background p-1">
                            {visibleEntries.map((entry) => {
                                const selected = selectedEntryIds.has(entry.id);
                                return (
                                    <button
                                        aria-checked={selected}
                                        aria-label={`Select ${entry.name}`}
                                        className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-sm border px-2 py-2 text-left text-sm ${selected
                                            ? "border-primary bg-accent text-accent-strong"
                                            : "border-transparent hover:border-border hover:bg-muted"
                                            }`}
                                        disabled={saving}
                                        key={entry.id}
                                        role="checkbox"
                                        type="button"
                                        onClick={(event) => handleSelectEntry(entry.id, event)}
                                    >
                                        <input
                                            aria-hidden
                                            checked={selected}
                                            className="w-auto"
                                            readOnly
                                            tabIndex={-1}
                                            type="checkbox"
                                        />
                                        <span className="min-w-0 truncate">
                                            #{entryPositionById.get(entry.id)} {entry.name}
                                        </span>
                                    </button>
                                );
                            })}
                            {visibleEntries.length === 0 ? (
                                <p className="m-0 px-2 py-3 text-sm text-muted-foreground">No matching entries.</p>
                            ) : null}
                        </div>
                    </section>
                </div>

                <AlertDialogFooter>
                    <Button disabled={saving} variant="outline" type="button" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        disabled={submitDisabled}
                        type="button"
                        onClick={() => onSubmit(selectedOrderedEntryIds)}
                    >
                        {saving ? "Copying..." : "Copy List"}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

function PublicCategory({
    category,
    copyDisabled,
    onCopy,
    usePrivateImages
}: {
    category: CategoryWithEntries;
    copyDisabled?: boolean;
    onCopy?: () => void;
    usePrivateImages: boolean;
}) {
    const entries = useMemo(() => orderEntries(category.entries), [category.entries]);

    return (
        <section className="grid gap-[0.8rem]">
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">{category.name}</h2>
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-muted-foreground">{entries.length} {entries.length === 1 ? "entry" : "entries"}</span>
                    {onCopy ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={copyDisabled}
                            type="button"
                            onClick={onCopy}
                        >
                            <CopyPlus data-icon="inline-start" />
                            <span>{copyDisabled ? "Copying..." : "Copy List"}</span>
                        </Button>
                    ) : null}
                </div>
            </div>
            <div className="grid gap-[0.65rem]">
                {entries.map((entry) => (
                    <PublicEntryRow
                        entry={entry}
                        key={entry.id}
                        usePrivateImages={usePrivateImages}
                    />
                ))}
            </div>
        </section>
    );
}

function PublicEntryRow({
    entry,
    usePrivateImages
}: {
    entry: Entry;
    usePrivateImages: boolean;
}) {
    return (
        <article className="grid grid-cols-[3.2rem_5rem_minmax(0,1fr)] items-center gap-[0.65rem] rounded-md border border-border bg-muted px-[0.55rem] py-[0.65rem]">
            <span className="font-extrabold text-muted-foreground">#{entry.rankPosition + 1}</span>
            <PublicEntryPoster entry={entry} usePrivateImages={usePrivateImages} />
            <div>
                <strong>{entry.name}</strong>
            </div>
        </article>
    );
}

function PublicEntryPoster({
    entry,
    usePrivateImages
}: {
    entry: Entry;
    usePrivateImages: boolean;
}) {
    const [failed, setFailed] = useState(false);
    const src = hasStoredImage(entry.imageKey) && !failed
        ? usePrivateImages
            ? `/api/images/${encodeURIComponent(entry.id)}`
            : `/api/public-images/${encodeURIComponent(entry.id)}`
        : null;

    if (!src) {
        return (
            <span className={`${POSTER_CLASS} grid w-20 content-center place-items-center gap-[0.35rem] overflow-hidden rounded-sm border border-border p-1`}>
                <small className="text-[0.95rem] leading-tight text-muted-foreground">{isNoImageKey(entry.imageKey) ? "No image saved" : "No image"}</small>
            </span>
        );
    }

    return (
        <span className={`${POSTER_CLASS} block w-20 overflow-hidden rounded-sm border border-border`}>
            <img className="block h-full w-full object-cover" alt="" decoding="async" loading="lazy" src={src} onError={() => setFailed(true)} />
        </span>
    );
}

function PublicProfileAvatar({
    imageKey,
    isSelf,
    userId
}: {
    imageKey: string | null;
    isSelf: boolean;
    userId: string;
}) {
    const src = hasStoredImage(imageKey)
        ? isSelf
            ? `/api/profile-image?v=${encodeURIComponent(imageKey ?? "")}`
            : `/api/public-profile-image/${encodeURIComponent(userId)}`
        : null;

    return (
        <Avatar aria-hidden="true" className="size-16">
            {src ? <AvatarImage alt="" decoding="async" src={src} /> : null}
            <AvatarFallback className="border border-avatar-line [background:radial-gradient(circle_at_50%_38%,var(--avatar-ink)_0_21%,transparent_22%),radial-gradient(circle_at_50%_110%,var(--avatar-ink)_0_39%,transparent_40%),var(--avatar-bg)]" />
        </Avatar>
    );
}
