import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Compass, Search, Sparkles, UserPlus, Users } from "lucide-react";
import { AppHeader } from "@/components/layout/AppHeader";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { hasStoredImage, isNoImageKey } from "@/lib/images";
import { formatDate } from "@/lib/format";
import { redirectIfUnauthorized } from "@/lib/errors";
import { showToast } from "@/lib/toast";
import type { ExploreProfile, FollowRelationState, FollowSearchResult, RecentActivityItem } from "@/lib/types";
import { getSession } from "@/server/session";
import { loadExplore } from "@/server/explore";
import { followProfile, searchPublicProfiles } from "@/server/profiles";
import { loadViewer } from "@/server/viewer";

const SEARCH_DELAY_MS = 250;
type Feed = "following" | "everyone";

export const Route = createFileRoute("/explore")({
    loader: async () => {
        const session = await getSession();
        if (!session?.user) {
            throw redirect({ to: "/signin" });
        }

        const [data, viewer] = await Promise.all([loadExplore(), loadViewer()]);
        return { data, viewer };
    },
    component: ExploreRoute
});

function ExploreRoute() {
    const { data, viewer } = Route.useLoaderData();
    const { followingEntries, recentPublicEntries, publicProfiles } = data;
    const [feed, setFeed] = useState<Feed>(followingEntries.length > 0 ? "following" : "everyone");
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<FollowSearchResult[]>([]);
    const [searching, setSearching] = useState(false);

    useEffect(() => {
        const cleanQuery = query.trim();
        if (cleanQuery.length < 2) {
            setResults([]);
            setSearching(false);
            return;
        }

        let cancelled = false;
        setSearching(true);
        const timer = window.setTimeout(() => {
            searchPublicProfiles({ data: { query: cleanQuery } })
                .then((next) => {
                    if (!cancelled) {
                        setResults(next);
                    }
                })
                .catch((error) => {
                    if (!cancelled && !redirectIfUnauthorized(error)) {
                        setResults([]);
                    }
                })
                .finally(() => {
                    if (!cancelled) {
                        setSearching(false);
                    }
                });
        }, SEARCH_DELAY_MS);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [query]);

    const activeItems = feed === "following" ? followingEntries : recentPublicEntries;
    const searchActive = query.trim().length >= 2;

    return (
        <main className="mx-auto grid min-h-screen w-full max-w-7xl content-start gap-8 bg-background px-[clamp(1rem,4vw,3.75rem)] pb-16 text-foreground">
            <AppHeader viewer={viewer} />

            <section className="grid gap-5 pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] lg:items-end">
                <div className="grid gap-2">
                    <p className="m-0 text-xs font-semibold tracking-[0.14em] text-accent-strong uppercase">Community</p>
                    <h1 className="m-0 text-[clamp(2.35rem,5vw,4rem)] leading-none">Explore</h1>
                    <p className="m-0 max-w-xl text-muted-foreground">
                        See what people are adding to their shelves and find profiles worth following.
                    </p>
                </div>
                <label className="relative block">
                    <span className="sr-only">Search profiles</span>
                    <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        autoComplete="off"
                        className="h-11 pl-9"
                        placeholder="Search people by name or @handle"
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
            </section>

            {searchActive ? (
                <section className="grid gap-4" aria-live="polite">
                    <div className="flex items-baseline justify-between gap-3">
                        <h2 className="m-0 text-2xl">People</h2>
                        <span className="text-sm text-muted-foreground">
                            {searching ? "Searching..." : `${results.length} ${results.length === 1 ? "match" : "matches"}`}
                        </span>
                    </div>
                    {results.length > 0 ? (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                            {results.map((profile) => <SearchResultCard key={profile.userId} profile={profile} />)}
                        </div>
                    ) : !searching ? (
                        <EmptyState compact icon={Users} title="No public profiles match">
                            Only public profiles are searchable. If you know someone's exact handle, you can still send them a request from Settings.
                        </EmptyState>
                    ) : null}
                </section>
            ) : (
                <>
                    <section className="grid gap-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="inline-flex rounded-full border border-border bg-muted p-1" role="tablist" aria-label="Activity feed">
                                <FeedTab active={feed === "following"} count={followingEntries.length} label="Following" onSelect={() => setFeed("following")} />
                                <FeedTab active={feed === "everyone"} count={recentPublicEntries.length} label="Everyone" onSelect={() => setFeed("everyone")} />
                            </div>
                            <span className="text-sm text-muted-foreground">Newest additions first</span>
                        </div>
                        {activeItems.length > 0 ? (
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-3">
                                {activeItems.map((item) => <ActivityCard item={item} key={`${feed}-${item.entryId}`} />)}
                            </div>
                        ) : feed === "following" ? (
                            <EmptyState icon={UserPlus} title="Your feed is quiet">
                                Follow a few people and their new additions will show up here. Try the Everyone tab or search for someone above.
                            </EmptyState>
                        ) : (
                            <EmptyState icon={Compass} title="Nothing shared yet">
                                Activity appears here when people choose to share their recent additions publicly.
                            </EmptyState>
                        )}
                    </section>

                    <section className="grid gap-4">
                        <div className="flex items-baseline justify-between gap-3">
                            <h2 className="m-0 flex items-center gap-2 text-2xl">
                                <Sparkles aria-hidden="true" className="size-5 text-gold" />
                                Recently active people
                            </h2>
                            <span className="text-sm text-muted-foreground">{publicProfiles.length} shown</span>
                        </div>
                        {publicProfiles.length > 0 ? (
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
                                {publicProfiles.map((profile) => <ExploreProfileCard key={profile.userId} profile={profile} />)}
                            </div>
                        ) : (
                            <EmptyState compact icon={Users} title="No public profiles yet">
                                Public profiles will appear here as people begin sharing rankings.
                            </EmptyState>
                        )}
                    </section>
                </>
            )}
        </main>
    );
}

function FeedTab({ active, count, label, onSelect }: { active: boolean; count: number; label: string; onSelect: () => void }) {
    return (
        <button
            aria-selected={active}
            className={`inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-sm font-medium transition-colors ${active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
            role="tab"
            type="button"
            onClick={onSelect}
        >
            {label}
            <span className={`rounded-full px-1.5 text-[0.68rem] tabular-nums ${active ? "bg-accent text-accent-foreground" : "bg-transparent"}`}>{count}</span>
        </button>
    );
}

function ActivityCard({ item }: { item: RecentActivityItem }) {
    const imageSrc = hasStoredImage(item.entryImageKey)
        ? `/api/public-images/${encodeURIComponent(item.entryId)}?v=${encodeURIComponent(item.entryImageKey)}`
        : null;

    return (
        <article className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-3 rounded-xl border border-border bg-card p-3 shadow-panel transition-[border-color,box-shadow] hover:border-primary/35 hover:shadow-floating">
            <div className="aspect-4/5 overflow-hidden rounded-lg bg-[image:linear-gradient(135deg,var(--poster-start),var(--poster-end))]">
                {imageSrc ? (
                    <img alt="" className="block size-full object-cover" decoding="async" loading="lazy" src={imageSrc} />
                ) : (
                    <span className="grid size-full place-items-center p-1 text-center text-[0.7rem] leading-tight text-muted-foreground">
                        {isNoImageKey(item.entryImageKey) ? "No image" : item.entryName}
                    </span>
                )}
            </div>
            <div className="grid min-w-0 content-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                    <Link className="truncate font-[family-name:var(--app-font-display)] text-lg leading-tight text-foreground no-underline hover:text-accent-strong" to="/u/$profileSlug" params={{ profileSlug: item.profile.slug }}>
                        {item.entryName}
                    </Link>
                    <p className="m-0 truncate text-sm text-muted-foreground">
                        added to <span className="text-foreground">{item.categoryName}</span>
                    </p>
                </div>
                <Link className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground no-underline hover:text-foreground" to="/u/$profileSlug" params={{ profileSlug: item.profile.slug }}>
                    <ProfileAvatar imageKey={item.profile.imageKey} name={item.profile.name} userId={item.profile.userId} />
                    <span className="truncate">{item.profile.name}</span>
                    <span aria-hidden="true">·</span>
                    <time className="shrink-0" dateTime={new Date(item.createdAt).toISOString()}>{formatDate(item.createdAt)}</time>
                </Link>
            </div>
        </article>
    );
}

function ExploreProfileCard({ profile }: { profile: ExploreProfile }) {
    return (
        <Link
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl border border-border bg-card p-4 text-foreground no-underline shadow-panel transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-floating"
            to="/u/$profileSlug"
            params={{ profileSlug: profile.slug }}
        >
            <ProfileAvatar imageKey={profile.imageKey} name={profile.name} userId={profile.userId} large />
            <span className="min-w-0">
                <strong className="block truncate font-[family-name:var(--app-font-display)] text-lg font-normal">{profile.name}</strong>
                <small className="block truncate text-muted-foreground">
                    @{profile.slug} · {profile.publicCategoryCount} {profile.publicCategoryCount === 1 ? "shelf" : "shelves"}
                </small>
            </span>
        </Link>
    );
}

function SearchResultCard({ profile }: { profile: FollowSearchResult }) {
    const [relation, setRelation] = useState<FollowRelationState>(profile.relationState);
    const [saving, setSaving] = useState(false);
    const canFollow = relation === "none" || relation === "follows_you";

    async function handleFollow() {
        setSaving(true);
        try {
            const result = await followProfile({ data: { profileUserId: profile.userId } });
            setRelation(result.relationState);
            showToast(result.relationState === "requested" ? "Follow request sent." : `Now following ${profile.name}.`, "success");
        } catch (error) {
            if (!redirectIfUnauthorized(error)) {
                showToast(error instanceof Error ? error.message : String(error), "danger");
            }
        } finally {
            setSaving(false);
        }
    }

    return (
        <article className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-panel">
            <Link to="/u/$profileSlug" params={{ profileSlug: profile.slug }} aria-label={`View ${profile.name}`}>
                <ProfileAvatar imageKey={profile.imageKey} name={profile.name} userId={profile.userId} large />
            </Link>
            <span className="min-w-0">
                <Link className="block truncate font-[family-name:var(--app-font-display)] text-lg text-foreground no-underline hover:text-accent-strong" to="/u/$profileSlug" params={{ profileSlug: profile.slug }}>
                    {profile.name}
                </Link>
                <small className="block truncate text-muted-foreground">
                    @{profile.slug} · {profile.publicCategoryCount} {profile.publicCategoryCount === 1 ? "shelf" : "shelves"}
                </small>
            </span>
            {canFollow ? (
                <Button disabled={saving} size="sm" type="button" onClick={() => void handleFollow()}>
                    {saving ? "Saving..." : relation === "follows_you" ? "Follow back" : "Follow"}
                </Button>
            ) : (
                <span className="text-xs font-medium text-muted-foreground">
                    {relation === "requested" ? "Requested" : relation === "incoming_request" ? "Wants to follow you" : "Following"}
                </span>
            )}
        </article>
    );
}

function ProfileAvatar({
    imageKey,
    large = false,
    name,
    userId
}: {
    imageKey: string | null;
    large?: boolean;
    name: string;
    userId: string;
}) {
    const src = hasStoredImage(imageKey)
        ? `/api/public-profile-image/${encodeURIComponent(userId)}?v=${encodeURIComponent(imageKey)}`
        : null;

    return (
        <Avatar className={large ? "size-11 border border-border" : "size-5"}>
            {src ? <AvatarImage alt="" decoding="async" src={src} /> : null}
            <AvatarFallback className={`bg-avatar text-avatar-ink ${large ? "text-base font-semibold" : "text-[0.6rem] font-semibold"}`}>
                {name.trim().charAt(0).toUpperCase() || "?"}
            </AvatarFallback>
        </Avatar>
    );
}
