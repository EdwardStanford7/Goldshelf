import { createServerFn } from "@tanstack/react-start";
import type { ExploreData, ExploreProfile, RecentActivityItem } from "@/lib/types";
import { all, getDb } from "@/server/lib/db";
import { authMiddleware } from "@/server/middleware/auth";
import { buildDashboard } from "@/server/engine/dashboard";
import { hasAdminRole } from "@/lib/admin";

const ACTIVITY_LIMIT = 24;
const PROFILE_LIMIT = 24;
const PROFILE_CANDIDATE_LIMIT = 120;
const TRENDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const NEW_PROFILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_TRENDING_CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_TRENDING_CACHE_URL = "https://explore-cache.goldshelf.internal/public-trending-v2";

interface CloudflareCacheStorage extends CacheStorage {
    default: Cache;
}

interface RecentActivityRow {
    entry_id: string;
    entry_name: string;
    entry_image_key: string | null;
    category_id: string;
    category_name: string;
    created_at: number;
    user_id: string;
    user_name: string;
    user_image: string | null;
    slug: string;
}

interface ExploreProfileRow {
    user_id: string;
    name: string;
    image: string | null;
    slug: string;
    public_category_count: number;
    follower_count: number;
    public_entry_count: number;
    latest_public_activity_at: number | null;
}

/**
 * Returns a bounded, read-time activity view. Entry creation remains a single
 * write; there is deliberately no event table to retain or clean up.
 */
export const loadExplore = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .handler(({ context }): Promise<ExploreData> => loadExploreForUser(context.user.id));

export const loadExplorePage = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .handler(async ({ context }) => {
        const [data, dashboard] = await Promise.all([
            loadExploreForUser(context.user.id), buildDashboard(context.user.id, undefined, false, true)
        ]);
        return { data, home: { dashboard, user: { name: context.user.name,
            image: context.user.image ?? null, isAdmin: hasAdminRole(context.user) } } };
    });

async function loadExploreForUser(userId: string): Promise<ExploreData> {
    const db = getDb();
    const [followingEntries, recentPublicEntries, publicProfiles] = await Promise.all([
        all<RecentActivityRow>(
            db.prepare(
                `SELECT entries.id AS entry_id, entries.name AS entry_name,
                entries.image_key AS entry_image_key, categories.id AS category_id,
                categories.name AS category_name, entries.created_at,
                "user".id AS user_id, "user".name AS user_name,
                "user".image AS user_image, user_profiles.slug
         FROM user_follows
         INNER JOIN user_profiles ON user_profiles.user_id = user_follows.followed_user_id
         INNER JOIN "user" ON "user".id = user_profiles.user_id
         INNER JOIN categories ON categories.user_id = user_profiles.user_id
         INNER JOIN entries ON entries.category_id = categories.id
           AND entries.user_id = categories.user_id
           AND entries.status = 'active'
         WHERE user_follows.follower_user_id = ?
           AND user_follows.status = 'accepted'
           AND user_profiles.activity_visibility IN ('followers', 'public')
           AND categories.visibility != 'private'
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks blocks
             WHERE (blocks.blocker_user_id = ? AND blocks.blocked_user_id = user_profiles.user_id)
                OR (blocks.blocker_user_id = user_profiles.user_id AND blocks.blocked_user_id = ?)
           )
         ORDER BY entries.created_at DESC
         LIMIT ?`
            ).bind(userId, userId, userId, ACTIVITY_LIMIT)
        ),
        all<RecentActivityRow>(
            db.prepare(
                `SELECT entries.id AS entry_id, entries.name AS entry_name,
                entries.image_key AS entry_image_key, categories.id AS category_id,
                categories.name AS category_name, entries.created_at,
                "user".id AS user_id, "user".name AS user_name,
                "user".image AS user_image, user_profiles.slug
         FROM user_profiles
         INNER JOIN "user" ON "user".id = user_profiles.user_id
         INNER JOIN categories ON categories.user_id = user_profiles.user_id
         INNER JOIN entries ON entries.category_id = categories.id
           AND entries.user_id = categories.user_id
           AND entries.status = 'active'
         WHERE user_profiles.is_public = 1
           AND user_profiles.activity_visibility = 'public'
           AND user_profiles.user_id != ?
           AND categories.visibility = 'public'
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks blocks
             WHERE (blocks.blocker_user_id = ? AND blocks.blocked_user_id = user_profiles.user_id)
                OR (blocks.blocker_user_id = user_profiles.user_id AND blocks.blocked_user_id = ?)
           )
         ORDER BY entries.created_at DESC
         LIMIT ?`
            ).bind(userId, userId, userId, ACTIVITY_LIMIT)
        ),
        loadCachedPublicTrendingProfiles(userId)
    ]);

    return {
        followingEntries: followingEntries.map(mapRecentActivity),
        recentPublicEntries: recentPublicEntries.map(mapRecentActivity),
        publicProfiles
    };
}

function mapRecentActivity(row: RecentActivityRow): RecentActivityItem {
    return {
        entryId: row.entry_id,
        entryName: row.entry_name,
        entryImageKey: row.entry_image_key,
        categoryId: row.category_id,
        categoryName: row.category_name,
        createdAt: row.created_at,
        profile: {
            userId: row.user_id,
            name: row.user_name,
            imageKey: row.user_image,
            slug: row.slug
        }
    };
}

function mapExploreProfile(row: ExploreProfileRow): ExploreProfile {
    return {
        userId: row.user_id,
        name: row.name,
        imageKey: row.image,
        slug: row.slug,
        publicCategoryCount: row.public_category_count
    };
}

/**
 * A privacy-safe directory ranking: it only considers public profiles and
 * public shelves. Freshness is based solely on activity the owner chose to
 * publish, so an "off" activity setting never becomes an indirect signal.
 */
async function loadTrendingProfiles(): Promise<ExploreProfile[]> {
    const rows = await all<ExploreProfileRow>(
        getDb().prepare(
            `WITH public_shelves AS (
               SELECT c.user_id, COUNT(*) AS public_category_count,
                 SUM(c.active_entry_count) AS public_entry_count,
                 MAX(CASE WHEN p.activity_visibility = 'public' THEN (
                   SELECT e.created_at FROM entries e WHERE e.category_id = c.id
                     AND e.user_id = c.user_id AND e.status = 'active'
                   ORDER BY e.created_at DESC LIMIT 1
                 ) END) AS latest_public_activity_at
               FROM categories c JOIN user_profiles p ON p.user_id = c.user_id
               WHERE c.visibility = 'public' AND p.is_public = 1 GROUP BY c.user_id
             ), followers AS (
               SELECT followed_user_id AS user_id, COUNT(*) AS follower_count
               FROM user_follows WHERE status = 'accepted' GROUP BY followed_user_id
             )
             SELECT "user".id AS user_id, "user".name, "user".image, user_profiles.slug,
               COALESCE(public_shelves.public_category_count, 0) AS public_category_count,
               COALESCE(followers.follower_count, 0) AS follower_count,
               COALESCE(public_shelves.public_entry_count, 0) AS public_entry_count,
               public_shelves.latest_public_activity_at
             FROM user_profiles
             INNER JOIN "user" ON "user".id = user_profiles.user_id
             LEFT JOIN public_shelves ON public_shelves.user_id = user_profiles.user_id
             LEFT JOIN followers ON followers.user_id = user_profiles.user_id
             WHERE user_profiles.is_public = 1
               AND (
                 (COALESCE(public_shelves.public_category_count, 0) > 0 AND (
                   public_shelves.latest_public_activity_at >= ?
                   OR user_profiles.updated_at >= ?
                 ))
                 OR user_profiles.created_at >= ?
               )
             ORDER BY (
                follower_count * 6 + public_category_count * 4 + MIN(public_entry_count, 100) * 0.2 +
                CASE WHEN latest_public_activity_at IS NULL THEN 0 ELSE
                  MAX(0, 12 * (1 - MIN(1, (? - latest_public_activity_at) / ?)))
                END
             ) DESC, lower("user".name) ASC LIMIT ?`
        ).bind(
            Date.now() - TRENDING_WINDOW_MS,
            Date.now() - TRENDING_WINDOW_MS,
            Date.now() - NEW_PROFILE_WINDOW_MS,
            Date.now(), TRENDING_WINDOW_MS, PROFILE_CANDIDATE_LIMIT
        )
    );

    return rows
        .map(mapExploreProfile);
}

/** Anonymous-safe community directory used on the marketing page. */
export const loadPublicExplore = createServerFn({ method: "GET" })
    .handler(() => loadCachedPublicTrendingProfiles());

/**
 * Anonymous marketing traffic sees the same public directory, so a short
 * per-edge cache removes repeated global aggregation without caching any
 * viewer-specific relationship data.
 */
async function loadCachedPublicTrendingProfiles(viewerUserId = "") {
    const cacheRequest = new Request(PUBLIC_TRENDING_CACHE_URL);
    let cache: Cache | null = null;
    let profiles: ExploreProfile[] | null = null;
    try {
        cache = (caches as CloudflareCacheStorage).default;
        const cached = await cache.match(cacheRequest);
        if (cached && Number(cached.headers.get("x-goldshelf-expires-at")) > Date.now()) {
            profiles = await cached.json() as ExploreProfile[];
        }
    } catch { cache = null; }
    if (!profiles) {
        profiles = await loadTrendingProfiles();
        if (cache) {
            try {
                await cache.put(cacheRequest, Response.json(profiles, { headers: {
                    "cache-control": `public, max-age=${PUBLIC_TRENDING_CACHE_TTL_MS / 1000}`,
                    "x-goldshelf-expires-at": String(Date.now() + PUBLIC_TRENDING_CACHE_TTL_MS)
                } }));
            } catch { /* Caching must not repeat or fail the database query. */ }
        }
    }

    // Share only the ranking pool. Recheck current public metadata, audiences
    // and viewer-specific blocks on every response, including cache misses.
    const visible = await all<{ user_id: string; name: string; image: string | null; slug: string; public_category_count: number }>(
        getDb().prepare(`WITH candidates AS MATERIALIZED (
          SELECT p.user_id, u.name, u.image, p.slug, p.created_at,
            (SELECT COUNT(*) FROM categories WHERE user_id = p.user_id AND visibility = 'public') AS public_category_count
          FROM user_profiles p JOIN "user" u ON u.id = p.user_id
          WHERE p.is_public = 1 AND p.user_id IN (SELECT value FROM json_each(?))
            AND p.user_id != ? AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
              (b.blocker_user_id = ? AND b.blocked_user_id = p.user_id) OR
              (b.blocker_user_id = p.user_id AND b.blocked_user_id = ?))
        ) SELECT * FROM candidates WHERE public_category_count > 0 OR created_at >= ?`)
            .bind(JSON.stringify(profiles.map((profile) => profile.userId)), viewerUserId,
                viewerUserId, viewerUserId, Date.now() - NEW_PROFILE_WINDOW_MS)
    );
    const byId = new Map(visible.map((row) => [row.user_id, row]));
    return profiles.flatMap((profile) => {
        const row = byId.get(profile.userId);
        return row ? [{ userId: row.user_id, name: row.name, imageKey: row.image,
            slug: row.slug, publicCategoryCount: row.public_category_count }] : [];
    }).slice(0, PROFILE_LIMIT);
}
