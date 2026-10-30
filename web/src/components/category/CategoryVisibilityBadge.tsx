import { Globe2, Lock, Users } from "lucide-react";
import type { CategoryVisibility } from "@/lib/types";

export function CategoryVisibilityBadge({
    isPublic,
    visibility,
    profileIsPublic,
    className = ""
}: {
    isPublic: boolean;
    visibility?: CategoryVisibility;
    profileIsPublic?: boolean;
    className?: string;
}) {
    const resolvedVisibility = visibility ?? (!isPublic
        ? "private"
        : profileIsPublic === false
            ? "followers"
            : "public");
    const label = resolvedVisibility === "public"
        ? "Public"
        : resolvedVisibility === "followers"
            ? "Followers"
            : "Private";
    const title = resolvedVisibility === "public"
        ? "Visible to anyone who can open this public profile"
        : resolvedVisibility === "followers"
            ? "Shown on a private profile, visible to accepted followers"
            : "Hidden from this profile";
    const Icon = resolvedVisibility === "public"
        ? Globe2
        : resolvedVisibility === "followers"
            ? Users
            : Lock;

    return (
        <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-[0.15rem] text-[0.68rem] font-bold leading-none uppercase tracking-normal ${
                resolvedVisibility === "public"
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : resolvedVisibility === "followers"
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
