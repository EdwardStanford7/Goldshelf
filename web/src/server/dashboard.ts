import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { hasAdminRole } from "@/lib/admin";
import type { DashboardData, DashboardFreshness } from "@/lib/types";
import { auth, requestHasSessionCookie } from "@/server/lib/auth";
import { authMiddleware } from "@/server/middleware/auth";
import { buildDashboard, getDashboardRevision } from "@/server/engine/dashboard";
import { getDb } from "@/server/lib/db";
import { mapEntry, type EntryRow } from "@/server/stores/entryStore";
import { withVersionedDb } from "@/server/lib/versionedDb";
import { env } from "cloudflare:workers";

export const loadCategoryEntries = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .validator((data: { categoryId: string }) => data)
    .handler(async ({ context, data }) => {
        const db = getDb();
        const [metadata, entries] = await db.batch([
            db.prepare(`SELECT data_revision, (SELECT COUNT(*) FROM entries WHERE category_id = categories.id
              AND user_id = ? AND status = 'active') AS entry_count
              FROM categories WHERE id = ? AND user_id = ?`).bind(context.user.id, data.categoryId, context.user.id),
            db.prepare(`SELECT id, category_id, name, rank_position, image_key, created_at FROM entries
              WHERE user_id = ? AND category_id = ? AND status = 'active' ORDER BY rank_position`).bind(context.user.id, data.categoryId)
        ]);
        const category = metadata.results[0] as { data_revision: string; entry_count: number } | undefined;
        if (!category) throw new Error("Category not found");
        return { categoryId: data.categoryId, revision: category.data_revision, entryCount: category.entry_count,
            entries: (entries.results as unknown as EntryRow[]).map(mapEntry) };
    });

export const loadDashboard = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .validator((data: { categoryId?: string; includeAllEntries?: boolean } | undefined) => data ?? {})
    .handler(({ context, data }): Promise<DashboardData> => buildDashboard(
        context.user.id,
        data.categoryId,
        data.includeAllEntries
    ));

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
        dashboard: await withVersionedDb(env.DB, session.user.id, () => buildDashboard(session.user.id, undefined, false, true)),
        user: {
            name: session.user.name,
            image: session.user.image ?? null,
            isAdmin: hasAdminRole(session.user)
        }
    };
});
