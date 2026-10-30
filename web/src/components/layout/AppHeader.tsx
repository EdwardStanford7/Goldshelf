import { Link } from "@tanstack/react-router";
import { Compass, Library, Settings2 } from "lucide-react";
import type { ComponentType } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BrandLink } from "@/components/ui/BrandLink";
import { Button } from "@/components/ui/button";
import { hasStoredImage } from "@/lib/images";

type NavTo = "/" | "/explore" | "/profile";

const NAV_ITEMS: { to: NavTo; label: string; icon: ComponentType<{ className?: string }> }[] = [
    { to: "/", label: "Rankings", icon: Library },
    { to: "/explore", label: "Explore", icon: Compass },
    { to: "/profile", label: "Settings", icon: Settings2 }
];

/**
 * Shared top bar for every signed-in page outside the dashboard (Explore,
 * Settings, public profiles). The dashboard keeps its own sidebar; everything
 * else should look like the same product, with the same nav in the same place.
 */
export function AppHeader({
    viewer
}: {
    viewer: {
        signedIn: boolean;
        name?: string;
        slug?: string;
        imageKey?: string | null;
    };
}) {
    const avatarSrc = viewer.signedIn && hasStoredImage(viewer.imageKey ?? null)
        ? `/api/profile-image?v=${encodeURIComponent(viewer.imageKey ?? "")}`
        : null;

    return (
        <header className="sticky top-0 z-40 -mx-[clamp(1rem,4vw,3.75rem)] border-b border-border bg-background/90 px-[clamp(1rem,4vw,3.75rem)] backdrop-blur">
            <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4">
                <BrandLink />
                {viewer.signedIn ? (
                    <nav className="flex items-center gap-1" aria-label="Primary">
                        {NAV_ITEMS.map((item) => (
                            <Link
                                key={item.to}
                                to={item.to}
                                activeOptions={{ exact: item.to === "/" }}
                                className="inline-flex h-9 items-center gap-2 rounded-full px-3 text-sm font-medium text-muted-foreground no-underline transition-colors hover:bg-secondary hover:text-foreground"
                                activeProps={{ className: "bg-secondary text-foreground" }}
                            >
                                <item.icon className="size-4" />
                                <span className="max-[520px]:sr-only">{item.label}</span>
                            </Link>
                        ))}
                        {viewer.slug ? (
                            <Link
                                aria-label={viewer.name ? `View ${viewer.name}'s profile` : "View your profile"}
                                className="ml-1 rounded-full outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                                params={{ profileSlug: viewer.slug }}
                                title="Your public profile"
                                to="/u/$profileSlug"
                            >
                                <Avatar className="size-9 border border-border transition-shadow hover:shadow-panel">
                                    {avatarSrc ? <AvatarImage alt="" decoding="async" src={avatarSrc} /> : null}
                                    <AvatarFallback className="bg-avatar text-avatar-ink text-sm font-semibold">
                                        {(viewer.name ?? "?").trim().charAt(0).toUpperCase() || "?"}
                                    </AvatarFallback>
                                </Avatar>
                            </Link>
                        ) : null}
                    </nav>
                ) : (
                    <nav className="flex items-center gap-2" aria-label="Primary">
                        <Button asChild size="sm" variant="ghost">
                            <Link to="/signin">Sign in</Link>
                        </Button>
                        <Button asChild size="sm">
                            <Link to="/signup">Start your shelf</Link>
                        </Button>
                    </nav>
                )}
            </div>
        </header>
    );
}
