import { createServerFn } from "@tanstack/react-start";
import type { ExploreData, ExploreProfile, RecentActivityItem } from "@/lib/types";
import { all, getDb } from "@/server/lib/db";
import { authMiddleware } from "@/server/middleware/auth";

const ACTIVITY_LIMIT = 24;
const PROFILE_LIMIT = 12;
const TRENDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
    .handler(async ({ context }): Promise<ExploreData> => {
        const userId = context.user.id;
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
            loadTrendingProfiles(userId)
        ]);

        return {
            followingEntries: followingEntries.map(mapRecentActivity),
            recentPublicEntries: recentPublicEntries.map(mapRecentActivity),
            publicProfiles
        };
    });

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
async function loadTrendingProfiles(viewerUserId?: string): Promise<ExploreProfile[]> {
    const viewerId = viewerUserId ?? "";
    const rows = await all<ExploreProfileRow>(
        getDb().prepare(
            `WITH public_shelves AS (
               SELECT user_id, COUNT(*) AS public_category_count
               FROM categories WHERE visibility = 'public' GROUP BY user_id
             ), public_entries AS (
               SELECT categories.user_id, COUNT(*) AS public_entry_count,
                 MAX(CASE WHEN user_profiles.activity_visibility = 'public' THEN entries.created_at END) AS latest_public_activity_at
               FROM categories
               INNER JOIN entries ON entries.category_id = categories.id
                 AND entries.user_id = categories.user_id AND entries.status = 'active'
               INNER JOIN user_profiles ON user_profiles.user_id = categories.user_id
               WHERE categories.visibility = 'public'
               GROUP BY categories.user_id
             ), followers AS (
               SELECT followed_user_id AS user_id, COUNT(*) AS follower_count
               FROM user_follows WHERE status = 'accepted' GROUP BY followed_user_id
             )
             SELECT "user".id AS user_id, "user".name, "user".image, user_profiles.slug,
               COALESCE(public_shelves.public_category_count, 0) AS public_category_count,
               COALESCE(followers.follower_count, 0) AS follower_count,
               COALESCE(public_entries.public_entry_count, 0) AS public_entry_count,
               public_entries.latest_public_activity_at
             FROM user_profiles
             INNER JOIN "user" ON "user".id = user_profiles.user_id
             LEFT JOIN public_shelves ON public_shelves.user_id = user_profiles.user_id
             LEFT JOIN public_entries ON public_entries.user_id = user_profiles.user_id
             LEFT JOIN followers ON followers.user_id = user_profiles.user_id
             WHERE user_profiles.is_public = 1
               AND (? = '' OR user_profiles.user_id != ?)
               AND (? = '' OR NOT EXISTS (SELECT 1 FROM user_blocks blocks WHERE
                    (blocks.blocker_user_id = ? AND blocks.blocked_user_id = user_profiles.user_id) OR
                    (blocks.blocker_user_id = user_profiles.user_id AND blocks.blocked_user_id = ?)))
             ORDER BY (
                follower_count * 6 + public_category_count * 4 + MIN(public_entry_count, 100) * 0.2 +
                CASE WHEN latest_public_activity_at IS NULL THEN 0 ELSE
                  MAX(0, 12 * (1 - MIN(1, (? - latest_public_activity_at) / ?)))
                END
             ) DESC, lower("user".name) ASC LIMIT ?`
        ).bind(viewerId, viewerId, viewerId, viewerId, viewerId, Date.now(), TRENDING_WINDOW_MS, PROFILE_LIMIT)
    );

    return rows
        .map(mapExploreProfile);
}

/** Anonymous-safe community directory used on the marketing page. */
export const loadPublicExplore = createServerFn({ method: "GET" })
    .handler(() => loadTrendingProfiles());
