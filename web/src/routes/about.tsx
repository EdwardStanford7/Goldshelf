import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, ExternalLink } from "lucide-react";
import { BrandLink } from "@/components/ui/BrandLink";
import { Card } from "@/components/ui/card";
import "@/components/marketing/marketing.css";

const ABOUT_DESCRIPTION = "Goldshelf is an independent matchup-based ranking app created by Edward Stanford.";
const GITHUB_URL = "https://github.com/EdwardStanford7/Goldshelf";

export const Route = createFileRoute("/about")({
    head: () => ({
        meta: [
            { title: "About Goldshelf" },
            { name: "description", content: ABOUT_DESCRIPTION },
            { property: "og:title", content: "About Goldshelf" },
            { property: "og:description", content: ABOUT_DESCRIPTION },
            { property: "og:url", content: "https://goldshelf.net/about" },
            { name: "twitter:title", content: "About Goldshelf" },
            { name: "twitter:description", content: ABOUT_DESCRIPTION }
        ],
        links: [
            { rel: "canonical", href: "https://goldshelf.net/about" }
        ]
    }),
    component: AboutRoute
});

function AboutRoute() {
    return (
        <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
            <div className="gs-field" aria-hidden="true" />
            <div className="gs-grain" aria-hidden="true" />

            <div className="gs-content mx-auto grid min-h-screen w-full max-w-300 content-start gap-8 px-[clamp(1.25rem,5vw,4rem)] py-7">
                <header className="flex flex-wrap items-center justify-between gap-3">
                    <BrandLink />
                    <nav className="flex flex-wrap items-center justify-end gap-2.5" aria-label="About navigation">
                        <Link
                            to="/signin"
                            className="gs-ghost inline-flex h-10 items-center rounded-full px-4 text-sm font-medium"
                        >
                            Sign in
                        </Link>
                        <Link
                            to="/signup"
                            className="gs-cta inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold"
                        >
                            Start your shelf
                            <ArrowRight className="size-4" aria-hidden="true" />
                        </Link>
                    </nav>
                </header>

                <section className="grid gap-6 py-[clamp(2rem,8vw,5rem)]">
                    <div className="grid max-w-210 gap-4">
                        <p className="gs-kicker text-xs font-semibold uppercase">About Goldshelf</p>
                        <h1 className="font-display text-balance text-[clamp(2.5rem,7vw,5.75rem)] font-medium leading-[0.96]">
                            A small app for making ranked lists feel less arbitrary.
                        </h1>
                        <p className="max-w-165 text-lg leading-relaxed text-muted-foreground">
                            Goldshelf turns head-to-head choices into ordered lists for books, movies, games, restaurants, and anything else worth sorting.
                        </p>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
                        <Card className="gs-glass grid content-start gap-4 rounded-2xl px-6 py-6 shadow-panel">
                            <h2 className="font-display text-2xl font-medium">Why it exists</h2>
                            <div className="grid gap-3 text-sm leading-relaxed text-muted-foreground">
                                <p>
                                    Ratings are useful, but they often make you invent a score before you know what you mean. Goldshelf asks the simpler question: which of these two would you rank higher?
                                </p>
                                <p>
                                    The app is built around that idea. Add entries, compare matchups, repair odd placements, and share the lists you want other people to see.
                                </p>
                            </div>
                        </Card>

                        <Card className="gs-glass grid content-start gap-4 rounded-2xl px-6 py-6 shadow-panel">
                            <h2 className="font-display text-2xl font-medium">Creator</h2>
                            <div className="grid gap-3 text-sm leading-relaxed text-muted-foreground">
                                <p>
                                    Goldshelf is an independent project created by Edward Stanford.
                                </p>
                                <div className="flex flex-wrap gap-2 pt-1">
                                    <a
                                        className="gs-ghost inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium no-underline"
                                        href={GITHUB_URL}
                                        rel="noreferrer"
                                        target="_blank"
                                    >
                                        <ExternalLink className="size-4" aria-hidden="true" />
                                        GitHub
                                    </a>
                                </div>
                            </div>
                        </Card>
                    </div>
                </section>

                <footer className="gs-rule mt-auto flex flex-wrap items-center justify-between gap-3 border-t pt-6 text-sm text-muted-foreground">
                    <span>Goldshelf is built and maintained by Edward Stanford.</span>
                    <Link className="text-foreground no-underline hover:text-accent-strong" to="/">
                        Back to Goldshelf
                    </Link>
                </footer>
            </div>
        </main>
    );
}
