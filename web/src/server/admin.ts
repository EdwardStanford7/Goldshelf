import { createServerFn } from "@tanstack/react-start";
import { ADMIN_ROLE, USER_ROLE } from "@/lib/admin";
import type {
    AdminSessionSummary,
    AdminUserDetailData,
    AdminUserListData,
    AdminUserSearchField,
    AdminUserSummary
} from "@/lib/types";
import { all, first, getDb, newId, now } from "@/server/lib/db";
import { MAX_ADMIN_SEARCH_LENGTH, normalizeOptionalSearch } from "@/server/lib/validation";
import { adminMiddleware } from "@/server/middleware/auth";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_REASON_LENGTH = 500;

type AdminAuditAction =
    | "ban_user"
    | "unban_user"
    | "revoke_session"
    | "revoke_sessions";

interface AdminUserRow {
    id: string;
    name: string;
    email: string;
    emailVerified: number | boolean;
    image: string | null;
    role: string | null;
    banned: number | boolean | null;
    banReason: string | null;
    banExpires: number | string | Date | null;
    createdAt: number | string | Date;
    updatedAt: number | string | Date;
    profile_slug: string | null;
    profile_is_public: number | boolean | null;
    category_count: number;
    entry_count: number;
    queued_entry_count: number;
    active_session_count: number;
}

interface AdminSessionRow {
    id: string;
    expiresAt: number | string | Date;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: number | string | Date;
    updatedAt: number | string | Date;
    impersonatedBy: string | null;
}

export const loadAdminUsers = createServerFn({ method: "POST" })
    .middleware([adminMiddleware])
    .inputValidator((data: {
        search?: string;
        searchField?: AdminUserSearchField;
        limit?: number;
        offset?: number;
    }) => data)
    .handler(async ({ data }) => loadAdminUsersForQuery(data));

export const loadAdminUserDetail = createServerFn({ method: "POST" })
    .middleware([adminMiddleware])
    .inputValidator((data: { userId: string }) => data)
    .handler(async ({ data }) => {
        const detail = await loadAdminUserDetailForId(data.userId);
        if (!detail) {
            throw new Error("User not found");
        }
        return detail;
    });

export const banAdminUser = createServerFn({ method: "POST" })
    .middleware([adminMiddleware])
    .inputValidator((data: { userId: string; reason: string }) => data)
    .handler(async ({ context, data }) => {
        const targetUserId = data.userId.trim();
        const reason = normalizeReason(data.reason);
        if (!targetUserId) {
            throw new Error("User is required");
        }
        if (targetUserId === context.user.id) {
            throw new Error("Admin users cannot ban themselves");
        }

        const target = await getAdminUserSummary(targetUserId);
        if (!target) {
            throw new Error("User not found");
        }

        const db = getDb();
        const timestamp = now();
        const activeSessions = await countUserSessions(targetUserId);
        await db.batch([
            db
                .prepare(
                    `UPDATE "user"
             SET banned = 1, banReason = ?, banExpires = NULL, updatedAt = ?
             WHERE id = ?`
                )
                .bind(reason, timestamp, targetUserId),
            db.prepare(`DELETE FROM session WHERE userId = ?`).bind(targetUserId),
            adminAuditStatement({
                actorUserId: context.user.id,
                targetUserId,
                action: "ban_user",
                reason,
                metadata: { revokedSessionCount: activeSessions }
            })
        ]);

        return await requireAdminUserDetail(targetUserId);
    });

export const unbanAdminUser = createServerFn({ method: "POST" })
    .middleware([adminMiddleware])
    .inputValidator((data: { userId: string }) => data)
    .handler(async ({ context, data }) => {
        const targetUserId = data.userId.trim();
        if (!targetUserId) {
            throw new Error("User is required");
        }
        const target = await getAdminUserSummary(targetUserId);
        if (!target) {
            throw new Error("User not found");
        }

        const db = getDb();
        await db.batch([
            db
                .prepare(
                    `UPDATE "user"
             SET banned = 0, banReason = NULL, banExpires = NULL, updatedAt = ?
             WHERE id = ?`
                )
                .bind(now(), targetUserId),
            adminAuditStatement({
                actorUserId: context.user.id,
                targetUserId,
                action: "unban_user",
                reason: null,
                metadata: {}
            })
        ]);

        return await requireAdminUserDetail(targetUserId);
    });

export const revokeAdminUserSession = createServerFn({ method: "POST" })
    .middleware([adminMiddleware])
    .inputValidator((data: { userId: string; sessionId: string }) => data)
    .handler(async ({ context, data }) => {
        const targetUserId = data.userId.trim();
        const sessionId = data.sessionId.trim();
        if (!targetUserId || !sessionId) {
            throw new Error("User and session are required");
        }

        const session = await first<{ id: string }>(
            getDb()
                .prepare(`SELECT id FROM session WHERE id = ? AND userId = ?`)
                .bind(sessionId, targetUserId)
        );
        if (!session) {
            throw new Error("Session not found");
        }

        const db = getDb();
        await db.batch([
            db.prepare(`DELETE FROM session WHERE id = ? AND userId = ?`).bind(sessionId, targetUserId),
            adminAuditStatement({
                actorUserId: context.user.id,
                targetUserId,
                action: "revoke_session",
                reason: null,
                metadata: { sessionId }
            })
        ]);

        return await requireAdminUserDetail(targetUserId);
    });

export const revokeAdminUserSessions = createServerFn({ method: "POST" })
    .middleware([adminMiddleware])
    .inputValidator((data: { userId: string }) => data)
    .handler(async ({ context, data }) => {
        const targetUserId = data.userId.trim();
        if (!targetUserId) {
            throw new Error("User is required");
        }
        const target = await getAdminUserSummary(targetUserId);
        if (!target) {
            throw new Error("User not found");
        }

        const activeSessions = await countUserSessions(targetUserId);
        const db = getDb();
        await db.batch([
            db.prepare(`DELETE FROM session WHERE userId = ?`).bind(targetUserId),
            adminAuditStatement({
                actorUserId: context.user.id,
                targetUserId,
                action: "revoke_sessions",
                reason: null,
                metadata: { revokedSessionCount: activeSessions }
            })
        ]);

        return await requireAdminUserDetail(targetUserId);
    });

async function loadAdminUsersForQuery(input: {
    search?: string;
    searchField?: AdminUserSearchField;
    limit?: number;
    offset?: number;
}): Promise<AdminUserListData> {
    const query = normalizeUserListQuery(input);
    const { clause, params } = userSearchWhere(query.search, query.searchField);
    const db = getDb();
    const totalRow = await first<{ total: number }>(
        db.prepare(`SELECT COUNT(*) AS total FROM "user" ${clause}`).bind(...params)
    );
    const rows = await all<AdminUserRow>(
        db
            .prepare(
                `WITH page_users AS (
           SELECT id, name, email, emailVerified, image, role, banned,
                  banReason, banExpires, createdAt, updatedAt
           FROM "user"
           ${clause}
           ORDER BY createdAt DESC, email ASC
           LIMIT ? OFFSET ?
         )
         SELECT
           page_users.id,
           page_users.name,
           page_users.email,
           page_users.emailVerified,
           page_users.image,
           COALESCE(page_users.role, ?) AS role,
           COALESCE(page_users.banned, 0) AS banned,
           page_users.banReason,
           page_users.banExpires,
           page_users.createdAt,
           page_users.updatedAt,
           user_profiles.slug AS profile_slug,
           user_profiles.is_public AS profile_is_public,
           COALESCE(category_counts.category_count, 0) AS category_count,
           COALESCE(entry_counts.entry_count, 0) AS entry_count,
           COALESCE(queue_counts.queued_entry_count, 0) AS queued_entry_count,
           COALESCE(session_counts.active_session_count, 0) AS active_session_count
         FROM page_users
         LEFT JOIN user_profiles ON user_profiles.user_id = page_users.id
         LEFT JOIN (
           SELECT categories.user_id, COUNT(*) AS category_count
           FROM categories
           INNER JOIN page_users ON page_users.id = categories.user_id
           GROUP BY categories.user_id
         ) AS category_counts ON category_counts.user_id = page_users.id
         LEFT JOIN (
           SELECT entries.user_id, COUNT(*) AS entry_count
           FROM entries
           INNER JOIN page_users ON page_users.id = entries.user_id
           WHERE status = 'active'
           GROUP BY entries.user_id
         ) AS entry_counts ON entry_counts.user_id = page_users.id
         LEFT JOIN (
           SELECT entry_queue.user_id, COUNT(*) AS queued_entry_count
           FROM entry_queue
           INNER JOIN page_users ON page_users.id = entry_queue.user_id
           WHERE status = 'queued'
           GROUP BY entry_queue.user_id
         ) AS queue_counts ON queue_counts.user_id = page_users.id
         LEFT JOIN (
           SELECT session.userId, COUNT(*) AS active_session_count
           FROM session
           INNER JOIN page_users ON page_users.id = session.userId
           WHERE expiresAt > ?
           GROUP BY session.userId
         ) AS session_counts ON session_counts.userId = page_users.id
         ORDER BY page_users.createdAt DESC, page_users.email ASC`
            )
            .bind(...params, query.limit, query.offset, USER_ROLE, now())
    );

    return {
        users: rows.map(mapAdminUserRow),
        total: totalRow?.total ?? 0,
        limit: query.limit,
        offset: query.offset,
        search: query.search,
        searchField: query.searchField
    };
}

async function loadAdminUserDetailForId(userId: string): Promise<AdminUserDetailData | null> {
    const user = await getAdminUserSummary(userId);
    if (!user) {
        return null;
    }

    const sessions = await all<AdminSessionRow>(
        getDb()
            .prepare(
                `SELECT id, expiresAt, ipAddress, userAgent, createdAt, updatedAt, impersonatedBy
         FROM session
         WHERE userId = ?
         ORDER BY expiresAt DESC, createdAt DESC`
            )
            .bind(userId)
    );

    return { user, sessions: sessions.map(mapAdminSessionRow) };
}

async function requireAdminUserDetail(userId: string) {
    const detail = await loadAdminUserDetailForId(userId);
    if (!detail) {
        throw new Error("User not found");
    }
    return detail;
}

async function getAdminUserSummary(userId: string) {
    return await getAdminUserSummaryById(userId);
}

async function getAdminUserSummaryById(userId: string): Promise<AdminUserSummary | null> {
    const db = getDb();
    const row = await first<AdminUserRow>(
        db
            .prepare(
                `SELECT
           "user".id,
           "user".name,
           "user".email,
           "user".emailVerified,
           "user".image,
           COALESCE("user".role, ?) AS role,
           COALESCE("user".banned, 0) AS banned,
           "user".banReason,
           "user".banExpires,
           "user".createdAt,
           "user".updatedAt,
           user_profiles.slug AS profile_slug,
           user_profiles.is_public AS profile_is_public,
           (SELECT COUNT(*) FROM categories WHERE categories.user_id = "user".id) AS category_count,
           (SELECT COUNT(*) FROM entries WHERE entries.user_id = "user".id AND entries.status = 'active') AS entry_count,
           (SELECT COUNT(*) FROM entry_queue WHERE entry_queue.user_id = "user".id AND entry_queue.status = 'queued') AS queued_entry_count,
           (SELECT COUNT(*) FROM session WHERE session.userId = "user".id AND session.expiresAt > ?) AS active_session_count
         FROM "user"
         LEFT JOIN user_profiles ON user_profiles.user_id = "user".id
         WHERE "user".id = ?`
            )
            .bind(USER_ROLE, now(), userId)
    );

    return row ? mapAdminUserRow(row) : null;
}

async function countUserSessions(userId: string) {
    const row = await first<{ count: number }>(
        getDb()
            .prepare(`SELECT COUNT(*) AS count FROM session WHERE userId = ?`)
            .bind(userId)
    );
    return row?.count ?? 0;
}

function normalizeUserListQuery(input: {
    search?: string;
    searchField?: AdminUserSearchField;
    limit?: number;
    offset?: number;
}) {
    const searchField: AdminUserSearchField = input.searchField === "email" || input.searchField === "name"
        ? input.searchField
        : "all";
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    return {
        search: normalizeOptionalSearch(input.search, MAX_ADMIN_SEARCH_LENGTH),
        searchField,
        limit,
        offset
    };
}

function userSearchWhere(search: string, searchField: AdminUserSearchField) {
    if (!search) {
        return { clause: "", params: [] as unknown[] };
    }

    const pattern = `%${escapeLike(search.toLowerCase())}%`;
    if (searchField === "email") {
        return { clause: `WHERE lower("user".email) LIKE ? ESCAPE '\\'`, params: [pattern] };
    }
    if (searchField === "name") {
        return { clause: `WHERE lower("user".name) LIKE ? ESCAPE '\\'`, params: [pattern] };
    }
    return {
        clause: `WHERE lower("user".email) LIKE ? ESCAPE '\\'
          OR lower("user".name) LIKE ? ESCAPE '\\'
          OR lower("user".id) = ?`,
        params: [pattern, pattern, search.toLowerCase()]
    };
}

function escapeLike(value: string) {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function normalizeReason(reason: string) {
    const cleanReason = reason.trim();
    if (!cleanReason) {
        throw new Error("Reason is required");
    }
    if (cleanReason.length > MAX_REASON_LENGTH) {
        throw new Error(`Reason must be ${MAX_REASON_LENGTH} characters or fewer`);
    }
    return cleanReason;
}

function mapAdminUserRow(row: AdminUserRow): AdminUserSummary {
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        emailVerified: Boolean(row.emailVerified),
        imageKey: row.image,
        role: row.role ?? USER_ROLE,
        banned: Boolean(row.banned),
        banReason: row.banReason,
        banExpires: normalizeTimestamp(row.banExpires),
        createdAt: normalizeTimestamp(row.createdAt) ?? 0,
        updatedAt: normalizeTimestamp(row.updatedAt) ?? 0,
        profileSlug: row.profile_slug,
        profileIsPublic: row.profile_is_public === null ? null : Boolean(row.profile_is_public),
        categoryCount: row.category_count,
        entryCount: row.entry_count,
        queuedEntryCount: row.queued_entry_count,
        activeSessionCount: row.active_session_count
    };
}

function mapAdminSessionRow(row: AdminSessionRow): AdminSessionSummary {
    return {
        id: row.id,
        expiresAt: normalizeTimestamp(row.expiresAt) ?? 0,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: normalizeTimestamp(row.createdAt) ?? 0,
        updatedAt: normalizeTimestamp(row.updatedAt) ?? 0,
        impersonatedBy: row.impersonatedBy
    };
}

function normalizeTimestamp(value: number | string | Date | null | undefined) {
    if (value === null || value === undefined) {
        return null;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function adminAuditStatement({
    actorUserId,
    targetUserId,
    action,
    reason,
    metadata
}: {
    actorUserId: string;
    targetUserId: string;
    action: AdminAuditAction;
    reason: string | null;
    metadata: Record<string, unknown>;
}) {
    return getDb()
        .prepare(
            `INSERT INTO admin_audit_events (
         id, actor_user_id, actor_label, target_user_id, action, reason, metadata_json, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
            newId("audit"),
            actorUserId,
            ADMIN_ROLE,
            targetUserId,
            action,
            reason,
            JSON.stringify(metadata),
            now()
        );
}
