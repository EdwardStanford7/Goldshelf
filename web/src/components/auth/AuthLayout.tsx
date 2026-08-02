import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/*
 * The branded two-column shell shared by the sign-in and sign-up pages: the
 * Goldshelf hero panel on the left and a content column on the right whose
 * heading block (eyebrow / title / description) and body are supplied by the
 * page rendering it.
 */
export function AuthLayout({
    eyebrow,
    title,
    description,
    children,
}: {
    eyebrow: string;
    title: string;
    description: string;
    children: ReactNode;
}) {
    return (
        <main className="grid min-h-screen w-full max-w-full min-w-0 place-items-center bg-background bg-[radial-gradient(circle_at_18%_12%,color-mix(in_srgb,var(--primary)_22%,transparent),transparent_34rem)] p-[clamp(1rem,4vw,2rem)] max-[720px]:items-stretch max-[720px]:p-0">
            <div className="grid w-[min(1060px,100%)] min-h-[min(720px,calc(100vh-2rem))] grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] overflow-hidden rounded-2xl border border-border bg-card shadow-floating max-[720px]:min-h-screen max-[720px]:grid-cols-1 max-[720px]:rounded-none max-[720px]:border-0">
                <section
                    aria-label="Goldshelf"
                    className="relative isolate grid min-h-168 content-between overflow-hidden bg-[linear-gradient(180deg,rgba(39,25,8,0.02),rgba(39,25,8,0.58)),url(/auth-hero.svg)] bg-cover bg-center bg-no-repeat p-[clamp(1.5rem,4vw,3rem)] text-white after:absolute after:inset-0 after:-z-10 after:bg-[linear-gradient(135deg,rgba(183,121,23,0.14),rgba(40,27,10,0.7))] after:content-[''] max-[720px]:min-h-88"
                >
                    <h1 className="m-0 self-start text-[clamp(3.25rem,8vw,6.8rem)] leading-[0.9] tracking-normal [text-shadow:0_10px_30px_rgba(0,0,0,0.32)]">
                        <Link
                            className="rounded-sm text-gold-strong no-underline outline-offset-4 transition-colors hover:text-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold"
                            to="/"
                        >
                            Goldshelf
                        </Link>
                    </h1>
                    <p className="m-0 max-w-md self-end text-[clamp(1.45rem,3vw,2.1rem)] leading-[1.14] font-bold text-[rgba(255,255,255,0.88)]">
                        Rank your taste, one choice at a time.
                    </p>
                </section>

                <section
                    aria-labelledby="auth-heading"
                    className="grid max-w-full min-w-0 content-center gap-[1.3rem] bg-card p-[clamp(1.5rem,4vw,3rem)]"
                >
                    <div className="grid gap-2">
                        <p className="m-0 text-[0.82rem] font-extrabold tracking-normal uppercase text-gold">
                            {eyebrow}
                        </p>
                        <h2
                            className="m-0 text-[clamp(2.25rem,5vw,3.7rem)] leading-[0.98] tracking-normal"
                            id="auth-heading"
                        >
                            {title}
                        </h2>
                        <p className="m-0 text-muted-foreground">{description}</p>
                    </div>

                    {children}
                </section>
            </div>
        </main>
    );
}
