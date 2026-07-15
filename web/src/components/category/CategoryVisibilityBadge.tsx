import { Globe2, Lock } from "lucide-react";

export function CategoryVisibilityBadge({
    isPublic,
    className = ""
}: {
    isPublic: boolean;
    className?: string;
}) {
    return (
        <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-[0.15rem] text-[0.68rem] font-bold leading-none uppercase tracking-normal ${
                isPublic
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border bg-muted text-muted-foreground"
            } ${className}`.trim()}
            title={isPublic ? "Shown on profile" : "Private list"}
        >
            {isPublic ? <Globe2 className="size-3" /> : <Lock className="size-3" />}
            <span>{isPublic ? "Public" : "Private"}</span>
        </span>
    );
}
