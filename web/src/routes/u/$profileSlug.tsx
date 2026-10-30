import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
    Check,
    ChevronDown,
    CopyPlus,
    Globe2,
    ListOrdered,
    Lock,
    Shield,
    UserCheck,
    UserMinus,
    UserPlus,
    Users,
    X
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { AppHeader } from "@/components/layout/AppHeader";
import { Button } from "@/components/ui/button";
import { CategoryVisibilityBadge } from "@/components/category/CategoryVisibilityBadge";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
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
import { canViewProfile } from "@/lib/follows";
import { hasStoredImage, isNoImageKey } from "@/lib/images";
import { nextMultiSelection } from "@/lib/multiSelect";
import { BULK_OPERATION_CHUNK_SIZE } from "@/lib/operationLimits";
import { orderEntries } from "@/lib/ranking";
import {
    approveFollowRequest,
    cancelFollowRequest,
    copyPublicCategoryToQueue,
    declineFollowRequest,
    followProfile,
    loadPublicProfile,
    removeFollow
} from "@/server/profiles";
import { loadViewer } from "@/server/viewer";
import type { CategoryWithEntries, Entry, FollowRelationState, PublicProfileData } from "@/lib/types";

const POSTER_CLASS =
    "aspect-[4/5] bg-[image:linear-gradient(135deg,var(--poster-start),var(--poster-end))] text-center text-muted-foreground";
type CopyMode = "new" | "merge";

function chunks<T>(items: T[], size: number) {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        result.push(items.slice(index, index + size));
    }
    return result;
}

export const Route = createFileRoute("/u/$profileSlug")({
    loader: async ({ params }) => {
        const [data, viewer] = await Promise.all([
            loadPublicProfile({ data: { profileSlug: params.profileSlug } }),
            loadViewer()
        ]);
        if (!data) {
            throw notFound();
        }

        return { data, viewer };
    },
    component: PublicProfileRoute,
    notFoundComponent: ProfileNotFound
});

function ProfileNotFound() {
    return (
        <main className="mx-auto grid min-h-screen w-full max-w-7xl content-start gap-8 bg-background px-[clamp(1rem,4vw,3.75rem)] text-foreground">
            <AppHeader viewer={{ signedIn: false }} />
            <section className="grid max-w-md gap-2 rounded-xl border border-dashed border-border bg-muted p-6">
                <Lock aria-hidden="true" className="size-6 text-primary" />
                <h1 className="m-0 text-2xl">Profile Not Found</h1>
                <p className="m-0 text-muted-foreground">This profile is private or does not exist.</p>
            </section>
        </main>
    );
}

function PublicProfileRoute() {
    const { data: loaderData, viewer: headerViewer } = Route.useLoaderData();
    const [profileData, setProfileData] = useState<PublicProfileData | null>(loaderData);
    const [followSaving, setFollowSaving] = useState(false);
    const [copyingCategoryId, setCopyingCategoryId] = useState<string | null>(null);
    const [copyDialogCategory, setCopyDialogCategory] = useState<CategoryWithEntries | null>(null);
    const [copyMode, setCopyMode] = useState<CopyMode>("new");
    const [copyCategoryName, setCopyCategoryName] = useState("");
    const [copyTargetCategoryId, setCopyTargetCategoryId] = useState("");
    const [adminPrivacySaving, setAdminPrivacySaving] = useState(false);
    const entryScrollRef = useRef<HTMLDivElement | null>(null);
    const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
        loaderData?.categories[0]?.id ?? null
    );

    useEffect(() => {
        setProfileData(loaderData);
        setSelectedCategoryId(loaderData?.categories[0]?.id ?? null);
        setCopyDialogCategory(null);
    }, [loaderData]);

    function applyRelation(nextRelation: FollowRelationState, followerDelta: number) {
        if (!profileData) {
            return;
        }

        setProfileData({
            ...profileData,
            profile: {
                ...profileData.profile,
                relationState: nextRelation,
                followerCount: Math.max(0, profileData.profile.followerCount + followerDelta)
            },
            viewer: {
                ...profileData.viewer,
                relationState: nextRelation
            }
        });
    }

    async function runFollowAction(action: () => Promise<{ nextRelation: FollowRelationState; followerDelta: number; message: string }>) {
        if (!profileData || profileData.viewer.isSelf) {
            return;
        }

        setFollowSaving(true);
        try {
            const result = await action();
            applyRelation(result.nextRelation, result.followerDelta);
            showToast(result.message, "success");
        } catch (followError) {
            if (redirectIfUnauthorized(followError)) {
                return;
            }

            showToast(followError instanceof Error ? followError.message : String(followError), "danger");
        } finally {
            setFollowSaving(false);
        }
    }

    function handleFollow() {
        return runFollowAction(async () => {
            const result = await followProfile({ data: { profileUserId: profileData!.profile.userId } });
            return {
                nextRelation: result.relationState,
                followerDelta: 0,
                message: result.relationState === "requested" ? "Follow request sent." : "Profile followed."
            };
        });
    }

    function handleUnfollow() {
        return runFollowAction(async () => {
            const current = profileData!.viewer.relationState;
            await removeFollow({ data: { followedUserId: profileData!.profile.userId } });
            return {
                nextRelation: current === "mutual" ? "follows_you" : "none",
                followerDelta: 0,
                message: "Profile unfollowed."
            };
        });
    }

    function handleCancelRequest() {
        return runFollowAction(async () => {
            await cancelFollowRequest({ data: { followedUserId: profileData!.profile.userId } });
            return { nextRelation: "none", followerDelta: 0, message: "Follow request canceled." };
        });
    }

    function handleAcceptRequest() {
        return runFollowAction(async () => {
            const result = await approveFollowRequest({ data: { followerUserId: profileData!.profile.userId } });
            return { nextRelation: result.relationState, followerDelta: 0, message: "Follow request accepted." };
        });
    }

    function handleDeclineRequest() {
        return runFollowAction(async () => {
            await declineFollowRequest({ data: { followerUserId: profileData!.profile.userId } });
            return { nextRelation: "none", followerDelta: 0, message: "Follow request declined." };
        });
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

    async function setAdminPrivacyOverride(enabled: boolean) {
        if (!profileData || !profileData.viewer.canUseAdminPrivacyOverride) {
            return;
        }

        setAdminPrivacySaving(true);
        try {
            const nextProfileData = await loadPublicProfile({
                data: {
                    profileSlug: profileData.profile.slug,
                    adminViewPrivate: enabled
                }
            });
            if (!nextProfileData) {
                setProfileData(null);
                return;
            }

            const currentSelectedCategoryId = selectedCategoryId;
            const nextSelectedCategoryId = nextProfileData.categories.some((category) => category.id === currentSelectedCategoryId)
                ? currentSelectedCategoryId
                : nextProfileData.categories[0]?.id ?? null;
            setProfileData(nextProfileData);
            setSelectedCategoryId(nextSelectedCategoryId);
            setCopyDialogCategory(null);
            showToast(enabled ? "Admin private lists shown." : "Privacy-respecting view restored.", "default");
        } catch (error) {
            if (redirectIfUnauthorized(error)) {
                return;
            }

            showToast(error instanceof Error ? error.message : String(error), "danger");
        } finally {
            setAdminPrivacySaving(false);
        }
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
            const sourceEntryIdChunks = chunks(sourceEntryIds, BULK_OPERATION_CHUNK_SIZE);
            let targetCategoryId = copyTargetCategoryId;
            let targetCategoryName = copyMode === "new" ? cleanCategoryName : "";
            let copiedCount = 0;
            let skippedCount = 0;

            for (let index = 0; index < sourceEntryIdChunks.length; index += 1) {
                const chunk = sourceEntryIdChunks[index];
                const result = await copyPublicCategoryToQueue({
                    data: copyMode === "new" && index === 0
                        ? {
                            sourceCategoryId: copyDialogCategory.id,
                            mode: "new",
                            categoryName: cleanCategoryName,
                            sourceEntryIds: chunk
                        }
                        : {
                            sourceCategoryId: copyDialogCategory.id,
                            mode: "merge",
                            targetCategoryId,
                            sourceEntryIds: chunk
                        }
                });

                targetCategoryId = result.categoryId;
                targetCategoryName = result.categoryName;
                copiedCount += result.copiedCount;
                skippedCount += result.skippedCount;
            }

            if (copyMode === "new") {
                setProfileData({
                    ...profileData,
                    viewer: {
                        ...profileData.viewer,
                        categories: [
                            ...profileData.viewer.categories,
                            { id: targetCategoryId, name: targetCategoryName }
                        ]
                    }
                });
            }
            setCopyDialogCategory(null);
            const copyMessage = copiedCount > 0
                ? `Copied ${copiedCount} ${copiedCount === 1 ? "entry" : "entries"} to ${targetCategoryName}.`
                : `No new entries copied to ${targetCategoryName}.`;
            const skippedMessage = skippedCount > 0
                ? ` Skipped ${skippedCount} duplicate${skippedCount === 1 ? "" : "s"}.`
                : "";
            showToast(
                `${copyMessage}${skippedMessage}`,
                copiedCount > 0 ? "success" : "default"
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
        return <ProfileNotFound />;
    }

    const { profile, viewer } = profileData;
    const canCopySharedCategories = canViewProfile(profile.isPublic, false, viewer.relationState);
    const showCategoryVisibility = profileData.categories.some((category) => !category.isPublic);
    const totalEntries = profileData.categories.reduce((count, category) => count + category.entries.length, 0);
    const selectedCategory = profileData.categories.find((category) => category.id === selectedCategoryId) ?? null;

    return (
        <main className="mx-auto grid min-h-screen w-full max-w-7xl content-start gap-8 bg-background px-[clamp(1rem,4vw,3.75rem)] pb-16 text-foreground">
            <AppHeader viewer={headerViewer} />

            <section className="grid gap-6 pt-2" aria-labelledby="profile-heading">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-5 sm:gap-7">
                    <PublicProfileAvatar
                        imageKey={profile.imageKey}
                        isSelf={viewer.isSelf}
                        name={profile.name}
                        userId={profile.userId}
                    />
                    <div className="grid min-w-0 gap-3">
                        <div className="grid min-w-0 gap-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                                <h1 className="min-w-0 truncate text-[clamp(1.9rem,4vw,2.9rem)] leading-none" id="profile-heading">
                                    {profile.name}
                                </h1>
                                <ProfileVisibilityBadge isPublic={profile.isPublic} />
                                {viewer.adminPrivacyOverride ? (
                                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[0.68rem] font-bold uppercase tracking-wide text-destructive">
                                        <Shield className="size-3" />
                                        Admin Privacy View
                                    </span>
                                ) : null}
                            </div>
                            <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground">
                                <span className="truncate">@{profile.slug}</span>
                                {!viewer.isSelf && viewer.isSignedIn && (viewer.relationState === "follows_you" || viewer.relationState === "mutual") ? (
                                    <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">Follows you</span>
                                ) : null}
                            </p>
                        </div>

                        <dl className="m-0 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                            <ProfileStat label={profileData.categories.length === 1 ? "shelf" : "shelves"} value={profileData.categories.length} />
                            <ProfileStat label={totalEntries === 1 ? "entry" : "entries"} value={totalEntries} />
                            <ProfileStat label={profile.followerCount === 1 ? "follower" : "followers"} value={profile.followerCount} />
                            <ProfileStat label="following" value={profile.followingCount} />
                        </dl>

                        <div className="flex flex-wrap items-center gap-2 pt-1">
                            <FollowActions
                                relationState={viewer.relationState}
                                saving={followSaving}
                                isSelf={viewer.isSelf}
                                isSignedIn={viewer.isSignedIn}
                                profileIsPublic={profile.isPublic}
                                onAccept={() => void handleAcceptRequest()}
                                onCancelRequest={() => void handleCancelRequest()}
                                onDecline={() => void handleDeclineRequest()}
                                onFollow={() => void handleFollow()}
                                onUnfollow={() => void handleUnfollow()}
                            />
                            {viewer.canUseAdminPrivacyOverride ? (
                                <Button
                                    disabled={adminPrivacySaving}
                                    size="sm"
                                    type="button"
                                    variant={viewer.adminPrivacyOverride ? "default" : "outline"}
                                    onClick={() => void setAdminPrivacyOverride(!viewer.adminPrivacyOverride)}
                                >
                                    <Shield data-icon="inline-start" />
                                    <span>
                                        {adminPrivacySaving
                                            ? "Loading..."
                                            : viewer.adminPrivacyOverride
                                                ? "Respect privacy"
                                                : "Admin: view private lists"}
                                    </span>
                                </Button>
                            ) : null}
                        </div>
                    </div>
                </div>
            </section>

            {profileData.categories.length > 0 ? (
                <div className="grid min-h-0 w-full gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
                    <nav
                        className="flex min-w-0 gap-1 overflow-x-auto pb-1 [scrollbar-width:thin] lg:sticky lg:top-20 lg:grid lg:content-start lg:gap-0.5 lg:overflow-visible lg:pb-0"
                        aria-label="Shared shelves"
                    >
                        <p className="m-0 hidden pb-2 text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase lg:block">Shelves</p>
                        {profileData.categories.map((category) => {
                            const isActive = category.id === selectedCategoryId;
                            return (
                                <button
                                    className={`flex min-w-0 shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors lg:w-full ${isActive
                                        ? "bg-secondary font-semibold text-foreground"
                                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                                        }`}
                                    key={category.id}
                                    type="button"
                                    aria-current={isActive ? "true" : undefined}
                                    onClick={() => selectCategory(category.id)}
                                >
                                    <span className="min-w-0 truncate">{category.name}</span>
                                    <span className="flex shrink-0 items-center gap-1.5">
                                        {showCategoryVisibility ? (
                                            <CategoryVisibilityBadge isPublic={category.isPublic} profileIsPublic={profile.isPublic} />
                                        ) : null}
                                        <span className="text-xs tabular-nums text-muted-foreground">{category.entries.length}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </nav>
                    <div ref={entryScrollRef} className="min-w-0">
                        {selectedCategory ? (
                            <PublicCategory
                                category={selectedCategory}
                                copyDisabled={copyingCategoryId === selectedCategory.id}
                                onCopy={
                                    viewer.isSignedIn && !viewer.isSelf && selectedCategory.isPublic && canCopySharedCategories
                                        ? () => openCopyDialog(selectedCategory)
                                        : undefined
                                }
                                profileIsPublic={profile.isPublic}
                                showVisibility={showCategoryVisibility}
                                usePrivateImages={viewer.isSelf}
                            />
                        ) : null}
                    </div>
                </div>
            ) : (
                <EmptyState className="m-0 w-full" icon={ListOrdered} title={viewer.isSelf ? "Nothing shared yet" : "No shared shelves"}>
                    {viewer.isSelf ? (
                        <>
                            Shelves you mark as shown appear here.{" "}
                            <Link className="font-medium text-accent-strong" to="/profile">Choose what to share</Link>
                        </>
                    ) : (
                        `${profile.name} hasn't shared any shelves yet.`
                    )}
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

function ProfileStat({ label, value }: { label: string; value: number }) {
    return (
        <div className="flex items-baseline gap-1.5">
            <dt className="sr-only">{label}</dt>
            <dd className="m-0 font-semibold tabular-nums text-foreground">{value}</dd>
            <span aria-hidden="true" className="text-muted-foreground">{label}</span>
        </div>
    );
}

/**
 * Every follow state gets a distinct, honest control: the primary button only
 * ever says what it will do (Follow / Accept), and reversible states
 * (Following / Requested) expose their undo in a menu instead of silently
 * toggling on click.
 */
function FollowActions({
    relationState,
    saving,
    isSelf,
    isSignedIn,
    profileIsPublic,
    onAccept,
    onCancelRequest,
    onDecline,
    onFollow,
    onUnfollow
}: {
    relationState: FollowRelationState;
    saving: boolean;
    isSelf: boolean;
    isSignedIn: boolean;
    profileIsPublic: boolean;
    onAccept: () => void;
    onCancelRequest: () => void;
    onDecline: () => void;
    onFollow: () => void;
    onUnfollow: () => void;
}) {
    if (isSelf) {
        return (
            <Button asChild variant="outline">
                <Link to="/profile">Edit Profile</Link>
            </Button>
        );
    }

    if (!isSignedIn) {
        return (
            <Button asChild variant="outline">
                <Link to="/signin">Sign in to follow</Link>
            </Button>
        );
    }

    if (relationState === "incoming_request") {
        return (
            <>
                <Button disabled={saving} type="button" onClick={onAccept}>
                    <Check data-icon="inline-start" />
                    {saving ? "Saving..." : "Accept request"}
                </Button>
                <Button disabled={saving} type="button" variant="outline" onClick={onDecline}>
                    <X data-icon="inline-start" />
                    Decline
                </Button>
            </>
        );
    }

    if (relationState === "requested") {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button disabled={saving} type="button" variant="outline">
                        <UserCheck data-icon="inline-start" />
                        {saving ? "Saving..." : "Requested"}
                        <ChevronDown className="size-4 opacity-60" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={onCancelRequest}>
                        <X />
                        Cancel request
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    if (relationState === "following" || relationState === "mutual") {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button disabled={saving} type="button" variant="outline">
                        <UserCheck data-icon="inline-start" />
                        {saving ? "Saving..." : "Following"}
                        <ChevronDown className="size-4 opacity-60" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    <DropdownMenuItem variant="destructive" onSelect={onUnfollow}>
                        <UserMinus />
                        Unfollow
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <Button disabled={saving} type="button" onClick={onFollow} title={profileIsPublic ? undefined : "This profile is private, so following sends a request."}>
            <UserPlus data-icon="inline-start" />
            {saving ? "Saving..." : relationState === "follows_you" ? "Follow back" : profileIsPublic ? "Follow" : "Request to follow"}
        </Button>
    );
}

function ProfileVisibilityBadge({ isPublic }: { isPublic: boolean }) {
    const Icon = isPublic ? Globe2 : Users;
    return (
        <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[0.68rem] font-bold uppercase tracking-wide ${isPublic
                ? "border-gold/40 bg-gold-soft text-gold-strong"
                : "border-border bg-muted text-muted-foreground"
                }`}
            title={isPublic ? "Searchable and visible to anyone" : "Visible to accepted followers"}
        >
            <Icon className="size-3" />
            {isPublic ? "Public Profile" : "Followers Only"}
        </span>
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
    const allFilteredEntriesSelected = orderedEntryIds.length > 0 &&
        orderedEntryIds.every((entryId) => selectedEntryIds.has(entryId));
    const selectionScopeLabel = searchTerm ? "matches" : "all";
    const selectionToggleLabel = allFilteredEntriesSelected
        ? `Deselect ${selectionScopeLabel}`
        : `Select ${selectionScopeLabel}`;
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
        const nextSelectedIds = new Set(selectedEntryIds);
        for (const entryId of orderedEntryIds) {
            if (nextSelectedIds.has(entryId)) {
                continue;
            }
            nextSelectedIds.add(entryId);
        }
        setSelectedEntryIds(nextSelectedIds);
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

    function toggleFilteredSelection() {
        if (allFilteredEntriesSelected) {
            deselectVisible();
        } else {
            selectVisible();
        }
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
                                onClick={toggleFilteredSelection}
                            >
                                {selectionToggleLabel}
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
    profileIsPublic,
    showVisibility,
    usePrivateImages
}: {
    category: CategoryWithEntries;
    copyDisabled?: boolean;
    onCopy?: () => void;
    profileIsPublic: boolean;
    showVisibility: boolean;
    usePrivateImages: boolean;
}) {
    const entries = useMemo(() => orderEntries(category.entries), [category.entries]);

    return (
        <section className="grid gap-5" aria-labelledby={`shelf-${category.id}`}>
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
                <div className="grid min-w-0 gap-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h2 className="min-w-0 truncate text-[clamp(1.5rem,3vw,2.1rem)] leading-none" id={`shelf-${category.id}`}>{category.name}</h2>
                        {showVisibility ? <CategoryVisibilityBadge isPublic={category.isPublic} profileIsPublic={profileIsPublic} /> : null}
                    </div>
                    <p className="m-0 text-sm text-muted-foreground">
                        {entries.length} {entries.length === 1 ? "entry" : "entries"}, ranked by head-to-head picks
                    </p>
                </div>
                {onCopy ? (
                    <Button
                        disabled={copyDisabled}
                        type="button"
                        variant="outline"
                        onClick={onCopy}
                    >
                        <CopyPlus data-icon="inline-start" />
                        <span>{copyDisabled ? "Copying..." : "Copy List"}</span>
                    </Button>
                ) : null}
            </div>
            {entries.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9.5rem),1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))]">
                    {entries.map((entry) => (
                        <PublicEntryCard
                            entry={entry}
                            key={entry.id}
                            listSize={entries.length}
                            usePrivateImages={usePrivateImages}
                        />
                    ))}
                </div>
            ) : (
                <EmptyState compact icon={ListOrdered} title="Empty shelf">
                    Nothing has been ranked here yet.
                </EmptyState>
            )}
        </section>
    );
}

function PublicEntryCard({
    entry,
    listSize,
    usePrivateImages
}: {
    entry: Entry;
    listSize: number;
    usePrivateImages: boolean;
}) {
    const position = entry.rankPosition + 1;
    const percentileLabel = percentileForPosition(position, listSize);
    const isPodium = position <= 3 && listSize >= 3;

    return (
        <article
            className={`group relative grid min-w-0 overflow-hidden rounded-xl border bg-card shadow-panel transition-[border-color,box-shadow,transform] duration-150 motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-floating ${isPodium ? "border-gold/50" : "border-border"
                }`}
            title={`#${position} of ${listSize} · ${percentileLabel} percentile`}
        >
            <PublicEntryPoster entry={entry} usePrivateImages={usePrivateImages} />
            <span
                aria-hidden="true"
                className={`absolute top-2 left-2 grid min-w-7 place-items-center rounded-md px-1.5 py-0.5 text-xs font-bold tabular-nums shadow-sm ${isPodium
                    ? "bg-gold text-primary-foreground dark:text-primary-foreground"
                    : "bg-overlay-button text-overlay-button-ink"
                    }`}
            >
                {position}
            </span>
            <div className="grid min-w-0 gap-0.5 p-2.5">
                <strong className="block min-w-0 truncate font-[family-name:var(--app-font-display)] text-[0.98rem] leading-tight font-normal">
                    <span className="sr-only">#{position} </span>
                    {entry.name}
                </strong>
                <span className="text-xs text-muted-foreground">{percentileLabel} percentile</span>
            </div>
        </article>
    );
}

function percentileForPosition(position: number, total: number) {
    if (total <= 0) {
        return "100th";
    }

    const percentile = Math.max(1, Math.min(100, Math.ceil(((total - position + 1) / total) * 100)));
    return ordinal(percentile);
}

function ordinal(value: number) {
    const remainder = value % 100;
    if (remainder >= 11 && remainder <= 13) {
        return `${value}th`;
    }

    switch (value % 10) {
        case 1:
            return `${value}st`;
        case 2:
            return `${value}nd`;
        case 3:
            return `${value}rd`;
        default:
            return `${value}th`;
    }
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
            ? `/api/images/${encodeURIComponent(entry.id)}?v=${encodeURIComponent(entry.imageKey)}`
            : `/api/public-images/${encodeURIComponent(entry.id)}?v=${encodeURIComponent(entry.imageKey)}`
        : null;

    if (!src) {
        return (
            <div className={`${POSTER_CLASS} grid w-full content-center place-items-center gap-1 overflow-hidden p-3`}>
                <small className="text-[0.78rem] leading-tight text-muted-foreground">{isNoImageKey(entry.imageKey) ? "No image saved" : "No image"}</small>
            </div>
        );
    }

    return (
        <div className={`${POSTER_CLASS} block w-full overflow-hidden`}>
            <img className="block h-full w-full object-cover" alt="" decoding="async" loading="lazy" src={src} onError={() => setFailed(true)} />
        </div>
    );
}

function PublicProfileAvatar({
    imageKey,
    isSelf,
    name,
    userId
}: {
    imageKey: string | null;
    isSelf: boolean;
    name: string;
    userId: string;
}) {
    const src = hasStoredImage(imageKey)
        ? isSelf
            ? `/api/profile-image?v=${encodeURIComponent(imageKey ?? "")}`
            : `/api/public-profile-image/${encodeURIComponent(userId)}?v=${encodeURIComponent(imageKey)}`
        : null;

    return (
        <Avatar aria-hidden="true" className="size-20 border-2 border-card shadow-panel ring-1 ring-border sm:size-28">
            {src ? <AvatarImage alt="" decoding="async" src={src} /> : null}
            <AvatarFallback className="bg-avatar font-[family-name:var(--app-font-display)] text-3xl text-avatar-ink sm:text-4xl">
                {name.trim().charAt(0).toUpperCase() || "?"}
            </AvatarFallback>
        </Avatar>
    );
}
