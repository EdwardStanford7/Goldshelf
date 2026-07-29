import { Globe2, Lock, Users } from "lucide-react";

export function CategoryVisibilityBadge({
    isPublic,
    profileIsPublic,
    className = ""
}: {
    isPublic: boolean;
    profileIsPublic?: boolean;
    className?: string;
}) {
    const visibility = !isPublic
        ? "private"
        : profileIsPublic === false
            ? "followers"
            : "public";
    const label = visibility === "public"
        ? "Public"
        : visibility === "followers"
            ? "Followers"
            : "Private";
    const title = visibility === "public"
        ? "Visible to anyone who can open this public profile"
        : visibility === "followers"
            ? "Shown on a private profile, visible to accepted followers"
            : "Hidden from this profile";
    const Icon = visibility === "public"
        ? Globe2
        : visibility === "followers"
            ? Users
            : Lock;

    return (
        <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-[0.15rem] text-[0.68rem] font-bold leading-none uppercase tracking-normal ${
                visibility === "public"
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : visibility === "followers"
                        ? "border-border bg-secondary text-accent-strong"
                        : "border-border bg-muted text-muted-foreground"
            } ${className}`.trim()}
            title={title}
        >
            <Icon className="size-3" />
            <span>{label}</span>
        </span>
    );
}
