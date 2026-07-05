import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { updateCategoryVisibility } from "@/server/categories";
import {
    approveFollowRequest,
    cancelFollowRequest,
    declineFollowRequest,
    followProfile,
    loadProfileSettings,
    removeFollow,
    requestFollowByProfileSlug,
    searchPublicProfiles,
    updateUserProfile
} from "@/server/profiles";
import { getSession } from "@/server/session";
import { Inbox, ListOrdered, Send, UserPlus, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { BrandLink } from "@/components/ui/BrandLink";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { showToast } from "@/lib/toast";
import { redirectIfUnauthorized } from "@/lib/errors";
import { canViewProfile, followRelationLabel } from "@/lib/follows";
import { errorMessage, isTransientRequestFailure } from "@/lib/format";
import { hasStoredImage } from "@/lib/images";
import type { FollowProfileSummary, FollowSearchResult, ProfileSettingsData } from "@/lib/types";

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
    const [followInput, setFollowInput] = useState("");
    const [followSearchResults, setFollowSearchResults] = useState<FollowSearchResult[]>([]);
    const [followSearchLoading, setFollowSearchLoading] = useState(false);
    const [savingProfile, setSavingProfile] = useState(false);
    const [savingProfileImage, setSavingProfileImage] = useState(false);
    const [profileImageDraft, setProfileImageDraft] = useState<ProfileImageDraft | null>(null);
    const [savingCategoryId, setSavingCategoryId] = useState<string | null>(null);
    const [savingFollowId, setSavingFollowId] = useState<string | null>(null);
    useEffect(() => {
        setSettings(loaderData.settings);
        setDisplayName(loaderData.settings?.user.name ?? "");
        setProfileSlug(loaderData.settings?.user.slug ?? "");
        setProfileIsPublic(loaderData.settings?.user.isPublic ?? false);
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
        setSavingProfile(true);
        setStatus(null);
        setError(null);

        try {
            await updateUserProfile({
                data: {
                    name: displayName,
                    slug: profileSlug,
                    isPublic: profileIsPublic
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

    async function handleCategoryVisibility(categoryId: string, isPublic: boolean) {
        setSavingCategoryId(categoryId);
        setStatus(null);
        setError(null);

        try {
            await updateCategoryVisibility({ data: { categoryId, isPublic } });
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

    async function handleFollowSearchResult(profile: FollowSearchResult) {
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

    async function handleCopyProfileLink() {
        if (!settings) {
            return;
        }

        const url = `${window.location.origin}/u/${settings.user.slug}`;
        await navigator.clipboard.writeText(url);
        setStatus("Profile link copied.");
    }

    function renderSearchAction(profile: FollowSearchResult) {
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
                onClick={() => void handleFollowSearchResult(profile)}
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
        if (profile.relationState === "mutual") {
            return <span className="inline-flex min-h-[2.35rem] items-center rounded-full border border-border px-3 text-muted-foreground">Mutual</span>;
        }

        if (profile.relationState === "requested") {
            return <span className="inline-flex min-h-[2.35rem] items-center rounded-full border border-border px-3 text-muted-foreground">Requested</span>;
        }

        if (profile.relationState === "following") {
            return <span className="inline-flex min-h-[2.35rem] items-center rounded-full border border-border px-3 text-muted-foreground">Following</span>;
        }

        return (
            <Button
                size="sm"
                disabled={savingFollowId === profile.userId}
                type="button"
                onClick={() => void handleFollowSearchResult({ ...profile, matchKind: "public_profile" })}
            >
                {savingFollowId === profile.userId ? "Saving..." : "Follow"}
            </Button>
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
        <main className="grid min-h-screen content-start gap-4 bg-background px-[clamp(1rem,3vw,2.25rem)] py-5 text-foreground">
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
            <header className="m-0 flex w-full flex-wrap items-center justify-between gap-3">
                <BrandLink />
                <nav className="flex flex-wrap items-center justify-end gap-[0.8rem]" aria-label="Profile navigation">
                    <Link className="text-foreground no-underline hover:text-accent-strong" to="/">Rankings</Link>
                    <Link className="text-foreground no-underline hover:text-accent-strong" to="/u/$profileSlug" params={{ profileSlug: settings.user.slug }}>View Profile</Link>
                </nav>
            </header>

            <div className="m-0 grid w-full grid-cols-[minmax(18rem,0.8fr)_minmax(24rem,1fr)_minmax(18rem,0.82fr)] items-start gap-4 max-[1100px]:grid-cols-[minmax(18rem,0.85fr)_minmax(24rem,1fr)] max-[720px]:grid-cols-1">
                <div className="grid min-w-0 content-start gap-4">
                    <Card className="min-w-0 gap-4 px-4 shadow-panel">
                        <div className="mb-4 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-[0.8rem] [&_h1]:m-0 [&_h1]:leading-[1.1]">
                            <ProfileAvatar currentUser imageKey={settings.user.imageKey} userId={settings.user.id} />
                            <div>
                                <h1 className="text-2xl font-bold">{settings.user.name}</h1>
                                <p className="text-muted-foreground">@{settings.user.slug}</p>
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

                        <form className="grid gap-[0.8rem]" onSubmit={handleProfileSubmit}>
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
                            <label className="inline-flex items-center justify-start gap-[0.4rem] text-[0.86rem] text-muted-foreground">
                                <input
                                    checked={profileIsPublic}
                                    className="w-auto"
                                    type="checkbox"
                                    onChange={(event) => setProfileIsPublic(event.target.checked)}
                                />
                                <span>Public profile</span>
                            </label>
                            <div className="flex flex-wrap gap-2">
                                <Button size="lg" disabled={savingProfile} type="submit">
                                    {savingProfile ? "Saving..." : "Save Profile"}
                                </Button>
                                <Button size="lg" variant="outline" disabled={!settings.user.isPublic} type="button" onClick={handleCopyProfileLink}>
                                    Copy Link
                                </Button>
                            </div>
                        </form>
                    </Card>
                </div>

                <div className="grid min-w-0 content-start gap-4">
                    <Card className="min-w-0 gap-4 px-4 shadow-panel">
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

                    <Card className="min-w-0 gap-4 px-4 shadow-panel">
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

                    <Card className="min-w-0 gap-4 px-4 shadow-panel">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold">Followers</h2>
                            <span className="text-muted-foreground">{settings.followers.length}</span>
                        </div>
                        {settings.followers.length > 0 ? (
                            <FollowProfileList
                                profiles={settings.followers}
                                renderActions={renderFollowerAction}
                            />
                        ) : (
                            <EmptyState compact icon={Users} title="No Followers">
                                Accepted followers appear here.
                            </EmptyState>
                        )}
                    </Card>

                    <Card className="min-w-0 gap-4 px-4 shadow-panel">
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
                                            disabled={savingFollowId === profile.userId}
                                            type="button"
                                            onClick={() => void handleApproveFollow(profile)}
                                        >
                                            Accept
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={savingFollowId === profile.userId}
                                            type="button"
                                            onClick={() => void handleDeclineFollow(profile)}
                                        >
                                            Decline
                                        </Button>
                                    </div>
                                )}
                            />
                        ) : (
                            <EmptyState compact icon={Inbox} title="No Pending Requests">
                                Requests to follow private profiles appear here.
                            </EmptyState>
                        )}
                    </Card>

                    <Card className="min-w-0 gap-4 px-4 shadow-panel">
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
                </div>

                <div className="grid min-w-0 content-start gap-4 max-[1100px]:col-span-full max-[720px]:col-span-auto">
                    <Card className="min-w-0 gap-4 px-4 shadow-panel">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-lg font-semibold">Shared Rankings</h2>
                            <span className="text-muted-foreground">{settings.categories.filter((category) => category.isPublic).length}</span>
                        </div>
                        {settings.categories.length > 0 ? (
                            <div className="grid gap-[0.65rem]">
                                {settings.categories.map((category) => (
                                    <label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[0.8rem] rounded-md border border-border bg-muted p-3" key={category.id}>
                                        <span>
                                            <strong>{category.name}</strong>
                                            <small className="m-0 mt-[0.15rem] block text-muted-foreground">{category.entryCount} entries</small>
                                        </span>
                                        <input
                                            checked={category.isPublic}
                                            className="w-auto"
                                            disabled={savingCategoryId === category.id}
                                            type="checkbox"
                                            onChange={(event) => void handleCategoryVisibility(category.id, event.target.checked)}
                                        />
                                    </label>
                                ))}
                            </div>
                        ) : (
                            <EmptyState compact icon={ListOrdered} title="No Rankings">
                                Create a category before sharing rankings.
                            </EmptyState>
                        )}
                    </Card>
                </div>
            </div>
        </main>
    );
}

function FollowProfileList<TProfile extends FollowProfileSummary>({
    profiles,
    renderActions
}: {
    profiles: TProfile[];
    renderActions: (profile: TProfile) => ReactNode;
}) {
    return (
        <div className="grid gap-[0.65rem]">
            {profiles.map((profile) => (
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[0.8rem] rounded-md border border-border bg-muted p-[0.65rem]" key={profile.userId}>
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
                        <p className="m-0 mt-[0.15rem] text-muted-foreground">
                            @{profile.slug} · {profile.publicCategoryCount} shared rankings ·{" "}
                            {followRelationLabel(profile.relationState)}
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
            : `/api/public-profile-image/${encodeURIComponent(userId)}`
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
