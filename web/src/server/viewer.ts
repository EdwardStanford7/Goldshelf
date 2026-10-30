import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth, requestHasSessionCookie } from "@/server/lib/auth";
import { ensureUserProfile } from "./stores/profileStore";

export interface ViewerSummary {
    signedIn: boolean;
    name?: string;
    slug?: string;
    imageKey?: string | null;
}

/**
 * Minimal signed-in identity for the shared AppHeader (name, slug, avatar).
 * Cheap enough to call from any page loader; returns `{ signedIn: false }` for
 * anonymous requests without touching the database.
 */
export const loadViewer = createServerFn({ method: "GET" }).handler(async (): Promise<ViewerSummary> => {
    const headers = getRequestHeaders();
    if (!requestHasSessionCookie(headers)) {
        return { signedIn: false };
    }

    const session = await auth.api.getSession({ headers });
    if (!session?.user) {
        return { signedIn: false };
    }

    const profile = await ensureUserProfile(session.user.id);
    return {
        signedIn: true,
        name: session.user.name,
        slug: profile.slug,
        imageKey: session.user.image ?? null
    };
});
