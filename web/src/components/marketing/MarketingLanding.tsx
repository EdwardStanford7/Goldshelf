import { Link } from "@tanstack/react-router";
import { ArrowRight, ExternalLink, ListOrdered, Swords, Users } from "lucide-react";
import { GildedBackground } from "./GildedBackground";
import { hasStoredImage } from "@/lib/images";
import type { ExploreProfile } from "@/lib/types";
import "./marketing.css";

const FEATURES = [
    {
        icon: Swords,
        title: "Rank by comparing",
        body: "Skip the impossible 1 to 10 score. Pick a winner one matchup at a time and a sorted list falls out."
    },
    {
        icon: ListOrdered,
        title: "A shelf for anything",
        body: "Movies, books, games, restaurants. Keep a ranked shelf for every taste worth keeping."
    },
    {
        icon: Users,
        title: "Share your shelf",
        body: "Make a ranking public, follow friends, and see how your favorites line up against theirs."
    }
] as const;

const CATEGORIES = ["Films", "Albums", "Books", "Games", "Restaurants", "Anything"] as const;
const GITHUB_URL = "https://github.com/EdwardStanford7/Goldshelf";

export function MarketingLanding({ trendingProfiles }: { trendingProfiles: ExploreProfile[] }) {
    return (
        <main className="relative min-h-screen overflow-hidden text-foreground">
            <div className="gs-field" aria-hidden="true" />
            <GildedBackground />
            <div className="gs-grain" aria-hidden="true" />

            <div className="gs-content mx-auto flex min-h-screen w-full max-w-352 flex-col px-[clamp(1.25rem,5vw,4.5rem)] pb-16 pt-7">
                <header className="gs-rise flex flex-wrap items-center justify-between gap-3" style={{ animationDelay: "0ms" }}>
                    <span className="inline-flex min-w-0 items-center gap-3 text-[1.55rem] font-bold tracking-tight sm:text-[2rem]">
                        <img alt="" aria-hidden="true" className="h-8 w-8 sm:h-9 sm:w-9" src="/favicon.svg" />
                        <span className="gs-gold font-display">Goldshelf</span>
                    </span>
                    <div className="flex flex-wrap items-center justify-end gap-2.5">
                        <Link
                            to="/about"
                            className="gs-ghost inline-flex h-10 items-center rounded-full px-4 text-sm font-medium sm:px-5"
                        >
                            About
                        </Link>
                        <Link
                            to="/signin"
                            className="gs-ghost inline-flex h-10 items-center rounded-full px-4 text-sm font-medium sm:px-5"
                        >
                            Sign in
                        </Link>
                        <Link
                            to="/signup"
                            className="gs-cta inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold sm:px-5"
                        >
                            Start your shelf
                            <ArrowRight className="size-4" aria-hidden="true" />
                        </Link>
                    </div>
                </header>

                {/* Hero: top-anchored poster, one cohesive block ------------ */}
                <section className="grid content-center gap-10 py-16 lg:gap-12 lg:py-24">
                    <div className="grid max-w-5xl gap-5">
                        <h1
                            className="gs-rise font-display text-balance text-[clamp(2.75rem,8.5vw,7.25rem)] font-medium leading-[0.94]"
                            style={{ animationDelay: "120ms" }}
                        >
                            Rank everything you <span className="gs-gold italic">love</span>.
                        </h1>
                        <p
                            className="gs-rise max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl"
                            style={{ animationDelay: "240ms" }}
                        >
                            Stop agonizing over star ratings. Pick a winner between two things at a time, and Goldshelf turns those choices into a clean, ordered list you can share.
                        </p>
                    </div>

                    <div className="gs-rise flex flex-wrap items-center gap-3" style={{ animationDelay: "360ms" }}>
                        <Link
                            to="/signup"
                            className="gs-cta inline-flex h-12 items-center gap-2 rounded-full px-6 text-base font-semibold"
                        >
                            Start your shelf
                            <ArrowRight className="size-4" aria-hidden="true" />
                        </Link>
                        <Link
                            to="/"
                            hash="discover"
                            className="gs-ghost inline-flex h-12 items-center rounded-full px-6 text-base font-medium"
                        >
                            Browse public shelves
                        </Link>
                    </div>

                    <div className="gs-rise grid gap-3 pt-2" style={{ animationDelay: "460ms" }}>
                        <span className="gs-kicker text-xs font-semibold uppercase">What people rank</span>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-base font-medium text-muted-foreground">
                            {CATEGORIES.map((category, index) => (
                                <span key={category} className="inline-flex items-center gap-4">
                                    {index > 0 ? <span className="text-gold/50" aria-hidden="true">&middot;</span> : null}
                                    {category}
                                </span>
                            ))}
                        </div>
                    </div>
                </section>

                {trendingProfiles.length > 0 ? (
                    <section className="gs-rise grid gap-4 pb-4" id="discover" style={{ animationDelay: "430ms" }}>
                        <div className="flex flex-wrap items-end justify-between gap-3">
                            <div className="grid gap-1">
                                <span className="gs-kicker text-xs font-semibold uppercase">Discover</span>
                                <h2 className="font-display text-3xl font-medium sm:text-4xl">Trending public shelves</h2>
                                <p className="m-0 max-w-xl text-sm text-muted-foreground">Profiles rise with public shelves, community follows, and recently shared activity.</p>
                            </div>
                            <Link className="gs-ghost inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium" to="/signin">
                                Join the community <ArrowRight className="size-4" />
                            </Link>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            {trendingProfiles.slice(0, 4).map((profile) => <TrendingProfileCard key={profile.userId} profile={profile} />)}
                        </div>
                    </section>
                ) : null}

                {/* Features ------------------------------------------------- */}
                <section className="grid gap-4 sm:grid-cols-3 lg:gap-6">
                    {FEATURES.map((feature, index) => (
                        <article
                            key={feature.title}
                            className="gs-panel gs-glass grid content-start gap-5 overflow-hidden rounded-2xl p-7 lg:min-h-60 lg:p-8"
                        >
                            <div className="flex items-center justify-between">
                                <feature.icon className="size-7 text-gold" aria-hidden="true" />
                                <span className="gs-numeral text-4xl font-medium lg:text-5xl">
                                    {String(index + 1).padStart(2, "0")}
                                </span>
                            </div>
                            <div className="grid gap-2.5">
                                <h2 className="font-display text-xl font-medium">{feature.title}</h2>
                                <p className="text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
                            </div>
                        </article>
                    ))}
                </section>

                <footer className="gs-rule mt-16 flex flex-wrap items-center justify-between gap-3 border-t pt-6 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                        <img alt="" aria-hidden="true" className="h-4 w-4" src="/favicon.svg" />
                        <span className="gs-gold font-display font-medium">Goldshelf</span>
                    </span>
                    <nav className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2" aria-label="Goldshelf information">
                        <Link className="text-muted-foreground no-underline hover:text-accent-strong" to="/about">
                            Created by Edward Stanford
                        </Link>
                        <a
                            className="inline-flex items-center gap-1.5 text-muted-foreground no-underline hover:text-accent-strong"
                            href={GITHUB_URL}
                            rel="noreferrer"
                            target="_blank"
                        >
                            <ExternalLink className="size-4" aria-hidden="true" />
                            GitHub
                        </a>
                    </nav>
                </footer>
            </div>
        </main>
    );
}

function TrendingProfileCard({ profile }: { profile: ExploreProfile }) {
    const avatarSrc = hasStoredImage(profile.imageKey)
        ? `/api/public-profile-image/${encodeURIComponent(profile.userId)}?v=${encodeURIComponent(profile.imageKey)}`
        : null;
    return (
        <Link
            className="gs-panel gs-glass grid min-w-0 gap-3 rounded-2xl p-4 text-foreground no-underline transition-transform hover:-translate-y-0.5"
            params={{ profileSlug: profile.slug }}
            to="/u/$profileSlug"
        >
            <div className="flex items-center gap-3">
                <div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-full bg-gold/15 text-sm font-semibold text-gold">
                    {avatarSrc ? <img alt="" className="size-full object-cover" src={avatarSrc} /> : profile.name.trim().charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                    <strong className="block truncate font-display text-lg font-medium">{profile.name}</strong>
                    <span className="block truncate text-sm text-muted-foreground">@{profile.slug}</span>
                </div>
            </div>
            <span className="text-sm text-muted-foreground">{profile.publicCategoryCount} {profile.publicCategoryCount === 1 ? "public shelf" : "public shelves"}</span>
        </Link>
    );
}
