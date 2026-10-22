import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { hasAdminRole } from "@/lib/admin";
import type { DashboardData, DashboardFreshness } from "@/lib/types";
import { auth, requestHasSessionCookie } from "@/server/lib/auth";
import { authMiddleware } from "@/server/middleware/auth";
import { buildDashboard, getDashboardRevision } from "@/server/engine/dashboard";

export const loadDashboard = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .handler(({ context }): Promise<DashboardData> => buildDashboard(context.user.id));

export const loadDashboardFreshness = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .handler(async ({ context }): Promise<DashboardFreshness> => ({
        revision: await getDashboardRevision(context.user.id)
    }));

export interface HomeData {
    dashboard: DashboardData | null;
    user: { name: string; image: string | null; isAdmin: boolean } | null;
}

/**
 * Resolves the `/` route in a single pass. Logged-out visitors (no session
 * cookie) short-circuit before touching the database so the marketing page
 * stays cheap and cacheable; logged-in visitors get their dashboard built
 * from the same session lookup (no second round-trip through the auth
 * middleware).
 */
export const loadHome = createServerFn({ method: "GET" }).handler(async (): Promise<HomeData> => {
    const headers = getRequestHeaders();
    if (!requestHasSessionCookie(headers)) {
        return { dashboard: null, user: null };
    }

    const session = await auth.api.getSession({ headers });
    if (!session?.user) {
        return { dashboard: null, user: null };
    }

    return {
        dashboard: await buildDashboard(session.user.id),
        user: {
            name: session.user.name,
            image: session.user.image ?? null,
            isAdmin: hasAdminRole(session.user)
        }
    };
});
