import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { updateCategoryVisibility } from "@/server/categories";
import {
    approveFollowRequest,
    blockProfile,
    cancelFollowRequest,
    declineFollowRequest,
    followProfile,
    loadProfileSettings,
    removeFollower,
    removeFollow,
    requestFollowByProfileSlug,
    searchPublicProfiles,
    unblockProfile,
    updateUserProfile
} from "@/server/profiles";
import { deleteCurrentUserAccount } from "@/server/account";
import { getSession } from "@/server/session";
import { updateQueueSettings } from "@/server/queue";
import { Ban, ExternalLink, Inbox, ListOrdered, Send, UserPlus, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/layout/AppHeader";
import { BrandLink } from "@/components/ui/BrandLink";
import { CategoryVisibilityBadge } from "@/components/category/CategoryVisibilityBadge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { showToast } from "@/lib/toast";
import { signOut } from "@/lib/auth-client";
import { redirectIfUnauthorized } from "@/lib/errors";
import { canViewProfile, followRelationLabel } from "@/lib/follows";
import { errorMessage, isTransientRequestFailure } from "@/lib/format";
import { hasStoredImage } from "@/lib/images";
import { applyThemeMode, readInitialThemeMode, saveThemeMode, type ThemeMode } from "@/lib/theme";
import { readInitialShowEntryPercentile, saveShowEntryPercentile } from "@/lib/preferences";
import type { ActivityVisibility, CategoryVisibility, FollowProfileSummary, FollowSearchResult, ProfileSettingsData } from "@/lib/types";

const AVATAR_SIZE = 256;
const MAX_LOCAL_IMAGE_BYTES = 12 * 1024 * 1024;
const FOLLOW_SEARCH_DELAY_MS = 250;

interface ProfileImageDraft {
    file: File;
    objectUrl: string;
}

interface CropCenter {
    x: number;
    y: number;
}

type SettingsSection = "profile" | "library" | "social";

export const Route = createFileRoute("/profile")({
    loader: async () => {
        const session = await getSession();
        if (!session?.user) {
            throw redirect({ to: "/signin" });
        }

        return {
            session,
            settings: await loadProfileSettings()
        };
    },
    component: ProfileRoute
});

function ProfileRoute() {
    const loaderData = Route.useLoaderData();
    const [settings, setSettings] = useState<ProfileSettingsData | null>(loaderData.settings);
    const [displayName, setDisplayName] = useState(loaderData.settings?.user.name ?? "");
    const [profileSlug, setProfileSlug] = useState(loaderData.settings?.user.slug ?? "");
    const [profileIsPublic, setProfileIsPublic] = useState(loaderData.settings?.user.isPublic ?? false);
    const [activityVisibility, setActivityVisibility] = useState<ActivityVisibility>(
        loaderData.settings?.user.activityVisibility ?? "off"
    );
    const [followInput, setFollowInput] = useState("");
    const [followSearchResults, setFollowSearchResults] = useState<FollowSearchResult[]>([]);
    const [followSearchLoading, setFollowSearchLoading] = useState(false);
    const [savingProfile, setSavingProfile] = useState(false);
    const [savingProfileImage, setSavingProfileImage] = useState(false);
    const [profileImageDraft, setProfileImageDraft] = useState<ProfileImageDraft | null>(null);
    const [savingCategoryId, setSavingCategoryId] = useState<string | null>(null);
    const [savingFollowId, setSavingFollowId] = useState<string | null>(null);
    const [savingBlockId, setSavingBlockId] = useState<string | null>(null);
    const [deleteConfirmation, setDeleteConfirmation] = useState("");
    const [deletingAccount, setDeletingAccount] = useState(false);
    const [themeMode, setThemeMode] = useState<ThemeMode>(() => readInitialThemeMode());
    const [showEntryPercentile, setShowEntryPercentile] = useState(() => readInitialShowEntryPercentile());
    const [savingQueueSettings, setSavingQueueSettings] = useState(false);
    const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSection>("profile");
    useEffect(() => {
        setSettings(loaderData.settings);
        setDisplayName(loaderData.settings?.user.name ?? "");
        setProfileSlug(loaderData.settings?.user.slug ?? "");
        setProfileIsPublic(loaderData.settings?.user.isPublic ?? false);
        setActivityVisibility(loaderData.settings?.user.activityVisibility ?? "off");
    }, [loaderData.settings]);

    useEffect(() => {
        if (!profileImageDraft) {
            return undefined;
        }

        return () => URL.revokeObjectURL(profileImageDraft.objectUrl);
    }, [profileImageDraft]);

    useEffect(() => {
        const query = followInput.trim();
        if (query.length < 2 || !loaderData.session?.user) {
            setFollowSearchResults([]);
            setFollowSearchLoading(false);
            return;
        }

        let canceled = false;
        setFollowSearchLoading(true);
        const timeoutId = window.setTimeout(() => {
            searchPublicProfiles({ data: { query } })
                .then((results) => {
                    if (!canceled) {
                        setFollowSearchResults(results);
                    }
                })
                .catch((searchError) => {
                    if (!canceled) {
                        if (isTransientRequestFailure(searchError)) {
                            return;
                        }

                        setFollowSearchResults([]);
                        setActionError(searchError);
                    }
                })
                .finally(() => {
                    if (!canceled) {
                        setFollowSearchLoading(false);
                    }
                });
        }, FOLLOW_SEARCH_DELAY_MS);

        return () => {
            canceled = true;
            window.clearTimeout(timeoutId);
        };
    }, [followInput, loaderData.session?.user]);

    function setStatus(message: string | null) {
        showToast(message, "success");
    }

    function setError(message: string | null) {
        showToast(message, "danger");
    }

    function setActionError(error: unknown) {
        if (redirectIfUnauthorized(error)) {
            return;
        }

        setError(errorMessage(error));
    }

    async function refreshSettings() {
        const nextSettings = await loadProfileSettings();
        setSettings(nextSettings);
        setDisplayName(nextSettings.user.name);
        setProfileSlug(nextSettings.user.slug);
        setProfileIsPublic(nextSettings.user.isPublic);
        return nextSettings;
    }

    async function refreshSettingsAfterMutation() {
        try {
            return await refreshSettings();
        } catch (settingsError) {
            if (isTransientRequestFailure(settingsError)) {
                return null;
            }

            throw settingsError;
        }
    }

    async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (settings?.user.isPublic && !profileIsPublic && !window.confirm("Making your profile private removes all current followers. They can request access again.")) {
            return;
        }
        setSavingProfile(true);
        setStatus(null);
        setError(null);

        try {
            await updateUserProfile({
                data: {
                    name: displayName,
                    slug: profileSlug,
                    isPublic: profileIsPublic,
                    activityVisibility
                }
            });
            await refreshSettingsAfterMutation();
            setStatus("Profile saved.");
        } catch (profileError) {
            setActionError(profileError);
        } finally {
            setSavingProfile(false);
        }
    }

    async function handleAccountDeletion(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setDeletingAccount(true);
        setStatus(null);
        setError(null);

        try {
            await deleteCurrentUserAccount({ data: { confirmation: deleteConfirmation } });
            window.location.assign("/signin");
        } catch (accountError) {
            setActionError(accountError);
            setDeletingAccount(false);
        }
    }

    async function handleQueueSettingChange(key: "enabled" | "promptForMissingImages" | "randomizeReadyEntries", value: boolean) {
        if (!settings || savingQueueSettings) {
            return;
        }

        const nextQueueSettings = { ...settings.queueSettings, [key]: value };
        setSavingQueueSettings(true);
        try {
            const savedQueueSettings = await updateQueueSettings({ data: nextQueueSettings });
            setSettings((current) => current ? { ...current, queueSettings: savedQueueSettings } : current);
            setStatus("Queue preferences saved.");
        } catch (queueError) {
            setActionError(queueError);
        } finally {
            setSavingQueueSettings(false);
        }
    }

    async function handleSignOut() {
        await signOut();
        window.location.assign("/");
    }

    async function handleProfileImageInput(event: ChangeEvent<HTMLInputElement>) {
        const file = event.currentTarget.files?.[0] ?? null;
        event.currentTarget.value = "";
        if (!file) {
            return;
        }

        setStatus(null);
        setError(null);

        try {
            if (file.size > MAX_LOCAL_IMAGE_BYTES) {
                throw new Error("Image file is too large");
            }

            setProfileImageDraft({
                file,
                objectUrl: URL.createObjectURL(file)
            });
        } catch (imageError) {
            setActionError(imageError);
        }
    }

    async function handleProfileImageSave(blob: Blob) {
        setSavingProfileImage(true);
        setStatus(null);
        setError(null);

        try {
            const response = await fetch("/api/profile-image", {
                method: "POST",
                headers: {
                    "content-type": blob.type || "image/jpeg"
                },
                body: blob
            });
            const body = await response.json().catch(() => null) as { message?: string } | null;
            if (!response.ok) {
                throw new Error(body?.message ?? "Profile photo upload failed");
            }

            await refreshSettingsAfterMutation();
            setProfileImageDraft(null);
            setStatus("Profile photo updated.");
        } catch (imageError) {
            setActionError(imageError);
        } finally {
            setSavingProfileImage(false);
        }
    }

    async function handleRemoveProfileImage() {
        setSavingProfileImage(true);
        setStatus(null);
        setError(null);

        try {
            const response = await fetch("/api/profile-image", {
                method: "DELETE"
            });
            const body = await response.json().catch(() => null) as { message?: string } | null;
            if (!response.ok) {
                throw new Error(body?.message ?? "Profile photo could not be removed");
            }

            await refreshSettingsAfterMutation();
            setStatus("Profile photo removed.");
        } catch (imageError) {
            setActionError(imageError);
        } finally {
            setSavingProfileImage(false);
        }
    }

    async function handleCategoryVisibility(categoryId: string, visibility: CategoryVisibility) {
        setSavingCategoryId(categoryId);
        setStatus(null);
        setError(null);

        try {
            await updateCategoryVisibility({ data: { categoryId, visibility } });
            await refreshSettingsAfterMutation();
            setStatus("Profile sharing saved.");
        } catch (visibilityError) {
            setActionError(visibilityError);
        } finally {
            setSavingCategoryId(null);
        }
    }

    async function handleRequestFollow(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setSavingFollowId("new");
        setStatus(null);
        setError(null);

        try {
            const result = await requestFollowByProfileSlug({ data: { profileSlugOrUrl: followInput } });
            setFollowInput("");
            setFollowSearchResults([]);
            await refreshSettingsAfterMutation();
            setStatus(result.relationState === "requested" ? "Follow request sent." : "Profile followed.");
        } catch (followError) {
            setActionError(followError);
        } finally {
            setSavingFollowId(null);
        }
    }

    async function handleFollowProfile(profile: FollowProfileSummary) {
        setSavingFollowId(profile.userId);
        setStatus(null);
        setError(null);

        try {
            await followProfile({ data: { profileUserId: profile.userId } });
            await refreshSettingsAfterMutation();
            setStatus("Profile followed.");
        } catch (followError) {
            setActionError(followError);
        } finally {
            setSavingFollowId(null);
        }
    }

    async function handleApproveFollow(profile: FollowProfileSummary) {
        setSavingFollowId(profile.userId);
        setStatus(null);
        setError(null);

        try {
            await approveFollowRequest({ data: { followerUserId: profile.userId } });
            await refreshSettingsAfterMutation();
            setStatus("Follow request accepted.");
        } catch (followError) {
            setActionError(followError);
        } finally {
            setSavingFollowId(null);
        }
    }

    async function handleDeclineFollow(profile: FollowProfileSummary) {
        setSavingFollowId(profile.userId);
        setStatus(null);
        setError(null);

        try {
            await declineFollowRequest({ data: { followerUserId: profile.userId } });
            await refreshSettingsAfterMutation();
            setStatus("Follow request declined.");
        } catch (followError) {
            setActionError(followError);
        } finally {
            setSavingFollowId(null);
        }
    }

    async function handleCancelFollow(profile: FollowProfileSummary) {
        setSavingFollowId(profile.userId);
        setStatus(null);
        setError(null);

        try {
            await cancelFollowRequest({ data: { followedUserId: profile.userId } });
            await refreshSettingsAfterMutation();
            setStatus("Follow request canceled.");
        } catch (followError) {
            setActionError(followError);
        } finally {
            setSavingFollowId(null);
        }
    }

    async function handleRemoveFollow(profile: FollowProfileSummary) {
        setSavingFollowId(profile.userId);
        setStatus(null);
        setError(null);

        try {
            await removeFollow({ data: { followedUserId: profile.userId } });
            await refreshSettingsAfterMutation();
            setStatus("Profile unfollowed.");
        } catch (followError) {
            setActionError(followError);
        } finally {
            setSavingFollowId(null);
        }
    }

    async function handleRemoveFollower(profile: FollowProfileSummary) {
        setSavingFollowId(profile.userId);
        try {
            await removeFollower({ data: { followerUserId: profile.userId } });
            await refreshSettingsAfterMutation();
            setStatus(`Removed ${profile.name} from your followers.`);
        } catch (error) {
            setActionError(error);
        } finally {
            setSavingFollowId(null);
        }
    }

    async function handleBlockProfile(profile: FollowProfileSummary) {
        setSavingBlockId(profile.userId);
        setStatus(null);
        setError(null);

        try {
            await blockProfile({ data: { profileUserId: profile.userId } });
            await refreshSettingsAfterMutation();
            setStatus(`Blocked ${profile.name}.`);
        } catch (blockError) {
            setActionError(blockError);
        } finally {
            setSavingBlockId(null);
        }
    }

    async function handleUnblockProfile(profile: FollowProfileSummary) {
        setSavingBlockId(profile.userId);
        setStatus(null);
        setError(null);

        try {
            await unblockProfile({ data: { profileUserId: profile.userId } });
            await refreshSettingsAfterMutation();
            setStatus(`Unblocked ${profile.name}.`);
        } catch (blockError) {
            setActionError(blockError);
        } finally {
            setSavingBlockId(null);
        }
    }

    async function handleCopyProfileLink() {
        if (!settings) {
            return;
        }

        const url = `${window.location.origin}/u/${settings.user.slug}`;
        await navigator.clipboard.writeText(url);
        setStatus("Profile link copied.");
    }

    function renderBlockButton(profile: FollowProfileSummary) {
        return (
            <Button
                size="sm"
                variant="destructive"
                disabled={savingBlockId === profile.userId || savingFollowId === profile.userId}
                type="button"
                onClick={() => void handleBlockProfile(profile)}
            >
                {savingBlockId === profile.userId ? "Saving..." : "Block"}
            </Button>
        );
    }

    function renderSearchAction(profile: FollowProfileSummary) {
        const disabled = savingFollowId === profile.userId
            || profile.relationState === "requested"
            || profile.relationState === "following"
            || profile.relationState === "mutual";
        if (profile.relationState === "incoming_request") {
            return (
                <Button
                    size="sm"
                    disabled={savingFollowId === profile.userId}
                    type="button"
                    onClick={() => void handleApproveFollow(profile)}
                >
                    {savingFollowId === profile.userId ? "Saving..." : "Accept"}
                </Button>
            );
        }

        return (
            <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                type="button"
                onClick={() => void handleFollowProfile(profile)}
            >
                {savingFollowId === profile.userId
                    ? "Saving..."
                    : profile.relationState === "requested"
                        ? "Requested"
                        : profile.relationState === "following" || profile.relationState === "mutual"
                            ? "Following"
                            : "Follow"}
            </Button>
        );
    }

    function renderFollowerAction(profile: FollowProfileSummary) {
        const blockButton = renderBlockButton(profile);
        let relationAction: ReactNode;

        if (profile.relationState === "mutual") {
            relationAction = <span className="inline-flex min-h-[2.35rem] items-center rounded-full border border-border px-3 text-muted-foreground">Mutual</span>;
        } else if (profile.relationState === "requested") {
            relationAction = <span className="inline-flex min-h-[2.35rem] items-center rounded-full border border-border px-3 text-muted-foreground">Requested</span>;
        } else if (profile.relationState === "following") {
            relationAction = <span className="inline-flex min-h-[2.35rem] items-center rounded-full border border-border px-3 text-muted-foreground">Following</span>;
        } else {
            relationAction = (
                <Button
                    size="sm"
                    disabled={savingFollowId === profile.userId || savingBlockId === profile.userId}
                    type="button"
                    onClick={() => void handleFollowProfile(profile)}
                >
                    {savingFollowId === profile.userId ? "Saving..." : "Follow"}
                </Button>
            );
        }

        return (
            <div className="flex flex-wrap justify-end gap-[0.4rem]">
                {relationAction}
                <Button size="sm" variant="outline" disabled={savingFollowId === profile.userId} type="button" onClick={() => void handleRemoveFollower(profile)}>
                    {savingFollowId === profile.userId ? "Saving..." : "Remove"}
                </Button>
                {blockButton}
            </div>
        );
    }

    if (!loaderData.session?.user || !settings) {
        return (
            <main className="grid min-h-screen place-items-center bg-background p-8 text-foreground">
                <Card className="grid w-[min(100%,34rem)] gap-4 px-4 shadow-panel">
                    <BrandLink />
                    <h1 className="text-2xl font-bold">Profile</h1>
                    <p className="text-muted-foreground">Sign in to edit your profile.</p>
                    <Button asChild className="w-fit">
                        <Link to="/">Sign In</Link>
                    </Button>
                </Card>
            </main>
        );
    }

    return (
        <main className="mx-auto grid min-h-screen w-full max-w-[96rem] content-start gap-6 bg-background px-[clamp(1rem,4vw,3.75rem)] pb-16 text-foreground">
            {profileImageDraft ? (
                <ProfilePhotoEditor
                    file={profileImageDraft.file}
                    objectUrl={profileImageDraft.objectUrl}
                    saving={savingProfileImage}
                    onCancel={() => {
                        if (!savingProfileImage) {
                            setProfileImageDraft(null);
                        }
                    }}
                    onSave={(blob) => handleProfileImageSave(blob)}
                />
            ) : null}
            <AppHeader viewer={{ signedIn: true, name: settings.user.name, slug: settings.user.slug, imageKey: settings.user.imageKey }} />

            <section className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6 pt-2">
                <div className="grid gap-2">
                    <p className="m-0 text-xs font-semibold tracking-[0.14em] text-accent-strong uppercase">Preferences & account</p>
                    <h1 className="m-0 text-[clamp(2.35rem,5vw,4rem)] leading-none">Settings</h1>
                    <p className="m-0 text-muted-foreground">Manage your profile, shelves, ranking preferences, and account controls.</p>
                </div>
                <Button asChild variant="outline">
                    <Link to="/u/$profileSlug" params={{ profileSlug: settings.user.slug }}>
                        <ExternalLink data-icon="inline-start" />
                        View Profile
                    </Link>
                </Button>
            </section>

            <div className="grid w-full items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
                <aside className="flex min-w-0 gap-1 overflow-x-auto border-b border-border pb-3 lg:sticky lg:top-20 lg:grid lg:gap-2 lg:overflow-visible lg:border-b-0 lg:pb-0">
                    <p className="mb-2 text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">Settings</p>
                    <SettingsSectionButton active={activeSettingsSection === "profile"} label="Profile & account" onSelect={() => setActiveSettingsSection("profile")} />
                    <SettingsSectionButton active={activeSettingsSection === "library"} label="Library & ranking" onSelect={() => setActiveSettingsSection("library")} />
                    <SettingsSectionButton active={activeSettingsSection === "social"} badge={settings.incomingFollowRequests.length} label="Privacy & social" onSelect={() => setActiveSettingsSection("social")} />
                </aside>

                <div className={`m-0 min-w-0 rounded-xl border border-border bg-card p-[clamp(1.25rem,3vw,2.25rem)] shadow-panel ${activeSettingsSection === "profile" ? "max-w-[54rem]" : ""}`}>
                <div className={activeSettingsSection === "profile"
                    ? "grid min-w-0 content-start gap-6"
                    : activeSettingsSection === "library"
                        ? "grid min-w-0 content-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]"
                        : "hidden"}>
                    <Card id="profile" className={activeSettingsSection === "profile" ? "scroll-mt-6 min-w-0 gap-4 bg-transparent px-0 py-0 shadow-none ring-0" : "hidden"}>
                        <div className="border-b border-border pb-5">
                            <h2 className="m-0 text-2xl font-normal">Public profile</h2>
                            <p className="mb-0 mt-1 text-sm text-muted-foreground">Control how other people find and recognize you.</p>
                        </div>
                        <div className="mb-4 grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem] xl:items-start">
                            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-[0.8rem] [&_h1]:m-0 [&_h1]:leading-[1.1]">
                                <ProfileAvatar currentUser imageKey={settings.user.imageKey} userId={settings.user.id} />
                                <div>
                                    <h2 className="text-2xl">{settings.user.name}</h2>
                                    <p className="text-muted-foreground">@{settings.user.slug}</p>
                                    <ProfileVisibilityBadge isPublic={settings.user.isPublic} />
                                    <div className="mt-[0.65rem] flex flex-wrap gap-2">
                                        <label className={`w-fit rounded-sm border border-border bg-card px-[0.8rem] py-[0.55rem] text-foreground ${savingProfileImage ? "cursor-not-allowed opacity-55" : "cursor-pointer"}`}>
                                            <span>{savingProfileImage ? "Uploading..." : "Upload Photo"}</span>
                                            <input
                                                accept="image/*"
                                                className="absolute h-px w-px overflow-hidden [clip:rect(0,0,0,0)]"
                                                disabled={savingProfileImage}
                                                type="file"
                                                onChange={(event) => void handleProfileImageInput(event)}
                                            />
                                        </label>
                                        <Button
                                            variant="outline"
                                            disabled={savingProfileImage || !hasStoredImage(settings.user.imageKey)}
                                            type="button"
                                            onClick={() => void handleRemoveProfileImage()}
                                        >
                                            Remove
                                        </Button>
                                    </div>
                                </div>
                            </div>
                            <div className="rounded-lg bg-muted/35 p-4">
                                <h2 className="m-0 text-lg">Appearance</h2>
                                <p className="mb-3 mt-1 text-sm text-muted-foreground">Choose how Goldshelf looks on this device.</p>
                                <div className="grid grid-cols-3 gap-2">
                                    {(["light", "dark", "system"] as ThemeMode[]).map((mode) => (
                                        <Button
                                            key={mode}
                                            type="button"
                                            variant={themeMode === mode ? "secondary" : "outline"}
                                            onClick={() => {
                                                setThemeMode(mode);
                                                saveThemeMode(mode);
                                                applyThemeMode(mode);
                                            }}
                                        >
                                            {mode[0]?.toUpperCase()}{mode.slice(1)}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <form className="grid gap-[0.8rem] sm:grid-cols-2" onSubmit={handleProfileSubmit}>
                            <label className="grid gap-[0.35rem]">
                                <span>Display Name</span>
                                <Input
                                    required
                                    maxLength={80}
                                    value={displayName}
                                    onChange={(event) => setDisplayName(event.target.value)}
                                />
                            </label>
                            <label className="grid gap-[0.35rem]">
                                <span>Public Handle</span>
                                <Input
                                    required
                                    maxLength={40}
                                    value={profileSlug}
                                    onChange={(event) => setProfileSlug(event.target.value)}
                                />
                            </label>
                            <div className="grid gap-1">
                                <label className="inline-flex items-center justify-start gap-[0.4rem] text-[0.86rem] text-muted-foreground">
                                    <input
                                        aria-label="Public profile"
                                        checked={profileIsPublic}
                                        className="w-auto"
                                        type="checkbox"
                                        onChange={(event) => setProfileIsPublic(event.target.checked)}
                                    />
                                    <span>Public profile</span>
                                </label>
                                <p className="m-0 text-sm text-muted-foreground">
                                    Public profiles are searchable and visible to anyone. Private profiles are visible only to you and accepted followers.
                                </p>
                            </div>
                            <label className="grid gap-[0.35rem]">
                                <span>Recent additions</span>
                                <select
                                    aria-label="Recent additions visibility"
                                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                                    value={activityVisibility}
                                    onChange={(event) => setActivityVisibility(event.target.value as ActivityVisibility)}
                                >
                                    <option value="off">Off</option>
                                    <option value="followers">Followers only</option>
                                    <option value="public">Public</option>
                                </select>
                                <p className="m-0 text-sm text-muted-foreground">
                                    Share new entries from shown rankings. This never shares hidden rankings; a private profile still limits activity to accepted followers.
                                </p>
                            </label>
                            <div className="flex flex-wrap gap-2 sm:col-span-2">
                                <Button size="lg" disabled={savingProfile} type="submit">
                                    {savingProfile ? "Saving..." : "Save Profile"}
                                </Button>
                                <Button size="lg" variant="outline" disabled={!settings.user.isPublic} type="button" onClick={handleCopyProfileLink}>
                                    Copy Link
                                </Button>
                            </div>
                        </form>
                    </Card>

                    <Card id="shelves" className={activeSettingsSection === "library" ? "scroll-mt-6 min-w-0 gap-4 bg-transparent px-0 py-0 shadow-none ring-0" : "hidden"}>
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <h2 className="m-0 text-2xl font-normal">Manage shelves</h2>
                                <p className="mb-0 mt-1 text-sm text-muted-foreground">Choose which rankings appear on your profile.</p>
                            </div>
                            <span className="text-muted-foreground">{settings.categories.filter((category) => category.visibility !== "private").length}</span>
                        </div>
                        <p className="m-0 text-sm text-muted-foreground">
                            Choose an audience for each shelf. A private profile caps every shared shelf at accepted followers.
                        </p>
                        {settings.categories.length > 0 ? (
                            <div className="grid gap-[0.65rem]">
                                {settings.categories.map((category) => (
                                    <label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[0.8rem] rounded-md border border-border bg-muted p-3" key={category.id}>
                                        <span className="min-w-0">
                                            <span className="flex min-w-0 flex-wrap items-center gap-2">
                                                <strong className="min-w-0 truncate">{category.name}</strong>
                                                <CategoryVisibilityBadge isPublic={category.isPublic} visibility={category.visibility} profileIsPublic={settings.user.isPublic} />
                                            </span>
                                            <small className="m-0 mt-[0.15rem] block text-muted-foreground">{category.entryCount} entries</small>
                                        </span>
                                        <select
                                            aria-label={`${category.name} visibility`}
                                            className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                                            disabled={savingCategoryId === category.id}
                                            value={category.visibility}
                                            onChange={(event) => void handleCategoryVisibility(category.id, event.target.value as CategoryVisibility)}
                                        >
                                            <option value="private">Private</option>
                                            <option value="followers">Followers</option>
                                            <option value="public">Public</option>
                                        </select>
                                    </label>
                                ))}
                            </div>
                        ) : (
                            <EmptyState compact icon={ListOrdered} title="No Rankings">
                                Create a category before sharing rankings.
                            </EmptyState>
                        )}
                    </Card>
                    {activeSettingsSection === "library" ? (
                        <LibraryPreferences
                            queueSettings={settings.queueSettings}
                            savingQueueSettings={savingQueueSettings}
                            showEntryPercentile={showEntryPercentile}
                            onQueueSettingChange={handleQueueSettingChange}
                            onShowEntryPercentileChange={(nextValue) => {
                                setShowEntryPercentile(nextValue);
                                saveShowEntryPercentile(nextValue);
                            }}
                        />
                    ) : null}
                </div>

                <div className={activeSettingsSection === "social" ? "mt-0 grid min-w-0 content-start gap-6 xl:grid-cols-2" : "hidden"}>
                    <div className="border-b border-border pb-5 xl:col-span-2">
                        <h2 className="m-0 text-2xl font-normal">People</h2>
                        <p className="mb-0 mt-1 text-sm text-muted-foreground">Requests, who you follow, who follows you, and who you have blocked.</p>
                    </div>
                    <Card className="min-w-0 gap-4 bg-transparent px-0 py-0 shadow-none ring-0 xl:order-4">
                        <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Followers</h2><span className="text-muted-foreground">{settings.followers.length}</span></div>
                        {settings.followers.length > 0 ? <FollowProfileList profiles={settings.followers} renderActions={renderFollowerAction} /> : (
                            <EmptyState compact icon={Users} title="No Followers">Accepted followers appear here.</EmptyState>
                        )}
                    </Card>
                    <Card className="min-w-0 gap-4 bg-transparent px-0 py-0 shadow-none ring-0 xl:order-2">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold">Follow Requests</h2>
                            <span className="text-muted-foreground">{settings.incomingFollowRequests.length}</span>
                        </div>
                        {settings.incomingFollowRequests.length > 0 ? (
                            <FollowProfileList
                                profiles={settings.incomingFollowRequests}
                                renderActions={(profile) => (
                                    <div className="flex flex-wrap justify-end gap-[0.4rem]">
                                        <Button
                                            size="sm"
                                            disabled={savingFollowId === profile.userId || savingBlockId === profile.userId}
                                            type="button"
                                            onClick={() => void handleApproveFollow(profile)}
                                        >
                                            Accept
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={savingFollowId === profile.userId || savingBlockId === profile.userId}
                                            type="button"
                                            onClick={() => void handleDeclineFollow(profile)}
                                        >
                                            Decline
                                        </Button>
                                        {renderBlockButton(profile)}
                                    </div>
                                )}
                            />
                        ) : (
                            <EmptyState compact icon={Inbox} title="No Pending Requests">
                                Requests to follow private profiles appear here.
                            </EmptyState>
                        )}
                    </Card>
                    <Card id="social" className="scroll-mt-6 min-w-0 gap-4 bg-transparent px-0 py-0 shadow-none ring-0 xl:order-1">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold">Find Profiles</h2>
                            <span className="text-muted-foreground">{followSearchLoading ? "Searching..." : "Profile search"}</span>
                        </div>
                        <form className="grid grid-cols-[minmax(0,1fr)_auto] gap-[0.8rem]" onSubmit={handleRequestFollow}>
                            <Input
                                aria-label="Profile handle, name, or profile link"
                                placeholder="search shared profiles or paste a private handle"
                                value={followInput}
                                onChange={(event) => setFollowInput(event.target.value)}
                            />
                            <Button disabled={savingFollowId === "new" || !followInput.trim()} type="submit">
                                {savingFollowId === "new" ? "Saving..." : "Follow"}
                            </Button>
                        </form>
                        {followSearchResults.length > 0 ? (
                            <FollowProfileList
                                profiles={followSearchResults}
                                renderActions={renderSearchAction}
                            />
                        ) : followInput.trim().length >= 2 && !followSearchLoading ? (
                            <p className="m-0 text-muted-foreground">No public profiles match that search.</p>
                        ) : (
                            <p className="m-0 text-muted-foreground">
                                Public profiles appear as you type. Exact private handles can still receive follow requests.
                            </p>
                        )}
                    </Card>

                    <Card className="min-w-0 gap-4 bg-transparent px-0 py-0 shadow-none ring-0 xl:order-3">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold">Following</h2>
                            <span className="text-muted-foreground">{settings.following.length}</span>
                        </div>
                        {settings.following.length > 0 ? (
                            <FollowProfileList
                                profiles={settings.following}
                                renderActions={(profile) => (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={savingFollowId === profile.userId}
                                        type="button"
                                        onClick={() => void handleRemoveFollow(profile)}
                                    >
                                        {savingFollowId === profile.userId ? "Saving..." : "Unfollow"}
                                    </Button>
                                )}
                            />
                        ) : (
                            <EmptyState compact icon={UserPlus} title="Not Following Anyone">
                                Profiles you follow appear here.
                            </EmptyState>
                        )}
                    </Card>

                    <Card className="min-w-0 gap-4 bg-transparent px-0 py-0 shadow-none ring-0 xl:order-5">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold">Sent Requests</h2>
                            <span className="text-muted-foreground">{settings.outgoingFollowRequests.length}</span>
                        </div>
                        {settings.outgoingFollowRequests.length > 0 ? (
                            <FollowProfileList
                                profiles={settings.outgoingFollowRequests}
                                renderActions={(profile) => (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={savingFollowId === profile.userId}
                                        type="button"
                                        onClick={() => void handleCancelFollow(profile)}
                                    >
                                        {savingFollowId === profile.userId ? "Saving..." : "Cancel"}
                                    </Button>
                                )}
                            />
                        ) : (
                            <EmptyState compact icon={Send} title="No Sent Requests">
                                Private-profile requests you send appear here.
                            </EmptyState>
                        )}
                    </Card>
                    <Card className="min-w-0 gap-4 bg-transparent px-0 py-0 shadow-none ring-0 xl:order-6">
                        <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Blocked Profiles</h2><span className="text-muted-foreground">{settings.blockedProfiles.length}</span></div>
                        {settings.blockedProfiles.length > 0 ? (
                            <FollowProfileList
                                profiles={settings.blockedProfiles}
                                metaLabel={() => "Blocked"}
                                renderActions={(profile) => <Button size="sm" variant="outline" disabled={savingBlockId === profile.userId} type="button" onClick={() => void handleUnblockProfile(profile)}>{savingBlockId === profile.userId ? "Saving..." : "Unblock"}</Button>}
                            />
                        ) : <EmptyState compact icon={Ban} title="No Blocked Profiles">Blocked profiles cannot follow you or request access.</EmptyState>}
                    </Card>
                </div>

                <div className={activeSettingsSection === "profile" ? "mt-6 grid min-w-0 content-start gap-6" : "hidden"}>

                    <Card id="account" className="scroll-mt-6 min-w-0 gap-3 border-t border-border bg-transparent px-0 pt-6 shadow-none ring-0">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="m-0 text-lg font-semibold">Account</h2>
                                <p className="mb-0 text-sm text-muted-foreground">Sign out or manage permanent account removal.</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button type="button" variant="outline" onClick={() => void handleSignOut()}>
                                    Sign Out
                                </Button>
                                <details className="relative">
                                    <summary className="flex h-9 cursor-pointer list-none items-center rounded-lg border border-destructive/50 px-3 text-sm font-medium text-destructive [&::-webkit-details-marker]:hidden">
                                        Delete account
                                    </summary>
                                    <div className="absolute right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-destructive/40 bg-card p-3 shadow-panel">
                                        <p className="mb-3 mt-0 text-sm text-muted-foreground">Permanently deletes your profile, rankings, follow data, and uploaded images. This cannot be undone.</p>
                                        <form className="grid gap-2" onSubmit={handleAccountDeletion}>
                                            <label className="grid gap-1 text-sm">
                                                <span>Type DELETE to confirm</span>
                                                <Input
                                                    aria-label="Delete account confirmation"
                                                    autoComplete="off"
                                                    disabled={deletingAccount}
                                                    value={deleteConfirmation}
                                                    onChange={(event) => setDeleteConfirmation(event.target.value)}
                                                />
                                            </label>
                                            <Button
                                                disabled={deletingAccount || deleteConfirmation.trim() !== "DELETE"}
                                                type="submit"
                                                variant="destructive"
                                            >
                                                {deletingAccount ? "Deleting..." : "Delete Account Permanently"}
                                            </Button>
                                        </form>
                                    </div>
                                </details>
                            </div>
                        </div>
                    </Card>
                </div>
                </div>
            </div>
        </main>
    );
}

function SettingsSectionButton({ active, badge = 0, label, onSelect }: { active: boolean; badge?: number; label: string; onSelect: () => void }) {
    return (
        <button
            aria-current={active ? "true" : undefined}
            className={`flex shrink-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors lg:w-full ${active
                ? "bg-secondary font-semibold text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                }`}
            type="button"
            onClick={onSelect}
        >
            <span className="truncate">{label}</span>
            {badge > 0 ? (
                <span aria-hidden="true" title={`${badge} pending`} className="rounded-full bg-accent-strong px-1.5 text-[0.68rem] font-semibold tabular-nums text-background">{badge}</span>
            ) : null}
        </button>
    );
}

function LibraryPreferences({
    queueSettings,
    savingQueueSettings,
    showEntryPercentile,
    onQueueSettingChange,
    onShowEntryPercentileChange
}: {
    queueSettings: ProfileSettingsData["queueSettings"];
    savingQueueSettings: boolean;
    showEntryPercentile: boolean;
    onQueueSettingChange: (key: keyof ProfileSettingsData["queueSettings"], enabled: boolean) => Promise<void>;
    onShowEntryPercentileChange: (enabled: boolean) => void;
}) {
    return (
        <div className="grid min-w-0 content-start gap-6 xl:sticky xl:top-20">
            <Card className="min-w-0 gap-4 bg-muted/35 px-5 py-5 shadow-none ring-0">
                <div>
                    <h2 className="m-0 text-xl">Ranking experience</h2>
                    <p className="mb-0 mt-1 text-sm text-muted-foreground">Presentation preferences for this device.</p>
                </div>
                <label className="flex items-center justify-between gap-5">
                    <span className="grid gap-1">
                        <strong>Show percentiles</strong>
                        <span className="text-sm text-muted-foreground">Display an item’s percentile alongside its rank.</span>
                    </span>
                    <input aria-label="Show entry percentiles" checked={showEntryPercentile} className="w-auto" type="checkbox" onChange={(event) => onShowEntryPercentileChange(event.target.checked)} />
                </label>
            </Card>
            <Card className="min-w-0 gap-4 bg-muted/35 px-5 py-5 shadow-none ring-0">
                <div>
                    <h2 className="m-0 text-xl">Queue behavior</h2>
                    <p className="mb-0 mt-1 text-sm text-muted-foreground">Control how entries wait before ranking.</p>
                </div>
                {([
                    ["enabled", "Enable the queue", "Allow new entries to be saved before ranking."],
                    ["promptForMissingImages", "Prompt for missing images", "Offer an image before a new entry begins ranking."],
                    ["randomizeReadyEntries", "Randomize queue runs", "Mix ready entries rather than using their visible order."]
                ] as const).map(([key, title, description]) => (
                    <label className="flex items-center justify-between gap-5 border-t border-border pt-4 first:border-t-0 first:pt-0" key={key}>
                        <span className="grid gap-1"><strong>{title}</strong><span className="text-sm text-muted-foreground">{description}</span></span>
                        <input aria-label={title} checked={queueSettings[key]} className="w-auto" disabled={savingQueueSettings} type="checkbox" onChange={(event) => void onQueueSettingChange(key, event.target.checked)} />
                    </label>
                ))}
            </Card>
        </div>
    );
}

function ProfileVisibilityBadge({ isPublic }: { isPublic: boolean }) {
    return (
        <span className={`mt-2 inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${
            isPublic
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-border bg-muted text-muted-foreground"
        }`}>
            {isPublic ? "Public Profile" : "Private Profile"}
        </span>
    );
}

function FollowProfileList<TProfile extends FollowProfileSummary>({
    profiles,
    metaLabel,
    renderActions
}: {
    profiles: TProfile[];
    metaLabel?: (profile: TProfile) => ReactNode;
    renderActions: (profile: TProfile) => ReactNode;
}) {
    return (
        <div className="grid gap-[0.65rem]">
            {profiles.map((profile) => (
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border bg-card p-3 max-[520px]:grid-cols-[auto_minmax(0,1fr)] max-[520px]:[&>*:last-child]:col-span-2 max-[520px]:[&>*:last-child]:justify-self-start" key={profile.userId}>
                    <ProfileAvatar imageKey={profile.imageKey} userId={profile.userId} />
                    <div>
                        {canViewProfile(profile.isPublic, false, profile.relationState) ? (
                            <Link
                                className="font-bold text-foreground no-underline hover:text-accent-strong"
                                to="/u/$profileSlug"
                                params={{ profileSlug: profile.slug }}
                            >
                                {profile.name}
                            </Link>
                        ) : (
                            <strong className="font-bold text-foreground no-underline">{profile.name}</strong>
                        )}
                        <p className="m-0 mt-0.5 truncate text-sm text-muted-foreground">
                            @{profile.slug} · {profile.publicCategoryCount} {profile.publicCategoryCount === 1 ? "shelf" : "shelves"} ·{" "}
                            {metaLabel ? metaLabel(profile) : followRelationLabel(profile.relationState)}
                        </p>
                    </div>
                    {renderActions(profile)}
                </div>
            ))}
        </div>
    );
}

function ProfileAvatar({
    currentUser = false,
    imageKey,
    userId
}: {
    currentUser?: boolean;
    imageKey: string | null;
    userId: string;
}) {
    const src = hasStoredImage(imageKey)
        ? currentUser
            ? `/api/profile-image?v=${encodeURIComponent(imageKey ?? "")}`
            : `/api/public-profile-image/${encodeURIComponent(userId)}?v=${encodeURIComponent(imageKey)}`
        : null;

    return (
        <Avatar aria-hidden="true" className="size-12">
            {src ? <AvatarImage alt="" decoding="async" src={src} /> : null}
            <AvatarFallback className="border border-avatar-line [background:radial-gradient(circle_at_50%_38%,var(--avatar-ink)_0_21%,transparent_22%),radial-gradient(circle_at_50%_110%,var(--avatar-ink)_0_39%,transparent_40%),var(--avatar-bg)]" />
        </Avatar>
    );
}

function ProfilePhotoEditor({
    file,
    objectUrl,
    saving,
    onCancel,
    onSave
}: {
    file: File;
    objectUrl: string;
    saving: boolean;
    onCancel: () => void;
    onSave: (blob: Blob) => Promise<void>;
}) {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        startCenter: CropCenter;
    } | null>(null);
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [zoom, setZoom] = useState(1);
    const [center, setCenter] = useState<CropCenter>({ x: 0, y: 0 });
    const [viewportSize, setViewportSize] = useState(320);

    useEffect(() => {
        const nextImage = new Image();
        setImage(null);
        setLoadError(null);
        nextImage.onload = () => {
            setImage(nextImage);
            setZoom(1);
            setCenter({
                x: nextImage.naturalWidth / 2,
                y: nextImage.naturalHeight / 2
            });
        };
        nextImage.onerror = () => setLoadError("Image could not be loaded");
        nextImage.src = objectUrl;
    }, [objectUrl]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) {
            return undefined;
        }
        const viewportElement = viewport;

        function updateViewportSize() {
            setViewportSize(Math.max(1, viewportElement.getBoundingClientRect().width));
        }

        updateViewportSize();
        const resizeObserver = new ResizeObserver(updateViewportSize);
        resizeObserver.observe(viewportElement);
        return () => resizeObserver.disconnect();
    }, []);

    const cropSize = image ? Math.min(image.naturalWidth, image.naturalHeight) / zoom : 1;
    const clampedCenter = image ? clampCropCenter(center, image, zoom) : center;
    const imageScale = image ? viewportSize / cropSize : 1;
    const imageStyle = image
        ? {
            height: `${image.naturalHeight * imageScale}px`,
            left: `${viewportSize / 2 - clampedCenter.x * imageScale}px`,
            top: `${viewportSize / 2 - clampedCenter.y * imageScale}px`,
            width: `${image.naturalWidth * imageScale}px`
        }
        : undefined;

    function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
        if (!image || saving) {
            return;
        }

        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startCenter: clampedCenter
        };
    }

    function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
        if (!image || !dragRef.current || dragRef.current.pointerId !== event.pointerId) {
            return;
        }

        const nextCropSize = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
        const sourcePixelsPerScreenPixel = nextCropSize / viewportSize;
        setCenter(clampCropCenter({
            x: dragRef.current.startCenter.x - (event.clientX - dragRef.current.startX) * sourcePixelsPerScreenPixel,
            y: dragRef.current.startCenter.y - (event.clientY - dragRef.current.startY) * sourcePixelsPerScreenPixel
        }, image, zoom));
    }

    function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
        if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
        }
    }

    function handleZoom(nextZoom: number) {
        if (!image) {
            setZoom(nextZoom);
            return;
        }

        setZoom(nextZoom);
        setCenter((currentCenter) => clampCropCenter(currentCenter, image, nextZoom));
    }

    async function handleSave() {
        if (!image || saving) {
            return;
        }

        await onSave(await imageElementToAvatarBlob(image, clampedCenter, zoom));
    }

    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-modal-backdrop p-4" role="dialog" aria-modal="true" aria-labelledby="profile-photo-editor-title">
            <div className="grid w-[min(100%,30rem)] gap-4 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-floating">
                <div className="flex items-center justify-between gap-3">
                    <h2 id="profile-photo-editor-title" className="text-lg font-semibold">Edit Photo</h2>
                    <span className="max-w-[14rem] truncate text-sm text-muted-foreground">{file.name}</span>
                </div>
                <div
                    ref={viewportRef}
                    className="relative mx-auto aspect-square w-[min(100%,22rem)] touch-none select-none overflow-hidden rounded-full border border-border bg-muted"
                    onPointerCancel={handlePointerEnd}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                >
                    {image && imageStyle ? (
                        <img
                            alt=""
                            className="absolute block max-w-none cursor-move"
                            draggable={false}
                            src={objectUrl}
                            style={imageStyle}
                        />
                    ) : (
                        <div className="grid h-full place-items-center text-sm text-muted-foreground">
                            {loadError ?? "Loading..."}
                        </div>
                    )}
                </div>
                <label className="grid gap-[0.35rem]">
                    <span>Zoom</span>
                    <input
                        aria-label="Zoom"
                        disabled={saving || !image}
                        max="3"
                        min="1"
                        step="0.01"
                        type="range"
                        value={zoom}
                        onChange={(event) => handleZoom(Number(event.target.value))}
                    />
                </label>
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" disabled={saving} type="button" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button disabled={saving || !image} type="button" onClick={() => void handleSave()}>
                        {saving ? "Saving..." : "Save Photo"}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function clampCropCenter(center: CropCenter, image: HTMLImageElement, zoom: number): CropCenter {
    const cropSize = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
    const halfCropSize = cropSize / 2;

    return {
        x: Math.min(image.naturalWidth - halfCropSize, Math.max(halfCropSize, center.x)),
        y: Math.min(image.naturalHeight - halfCropSize, Math.max(halfCropSize, center.y))
    };
}

function imageElementToAvatarBlob(image: HTMLImageElement, center: CropCenter, zoom: number) {
    return new Promise<Blob>((resolve, reject) => {
        try {
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (!context) {
                throw new Error("Image processing is unavailable");
            }

            const sourceWidth = image.naturalWidth;
            const sourceHeight = image.naturalHeight;
            if (sourceWidth === 0 || sourceHeight === 0) {
                throw new Error("Image has no dimensions");
            }

            const cropSize = Math.min(sourceWidth, sourceHeight) / zoom;
            const cropCenter = clampCropCenter(center, image, zoom);
            const cropX = cropCenter.x - cropSize / 2;
            const cropY = cropCenter.y - cropSize / 2;

            canvas.width = AVATAR_SIZE;
            canvas.height = AVATAR_SIZE;
            context.drawImage(
                image,
                cropX,
                cropY,
                cropSize,
                cropSize,
                0,
                0,
                AVATAR_SIZE,
                AVATAR_SIZE
            );

            canvas.toBlob(
                (avatarBlob) => {
                    if (!avatarBlob) {
                        reject(new Error("Profile photo could not be saved"));
                        return;
                    }

                    resolve(avatarBlob);
                },
                "image/jpeg",
                0.88
            );
        } catch (error) {
            reject(error);
        }
    });
}
