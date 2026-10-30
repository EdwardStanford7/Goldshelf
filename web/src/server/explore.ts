import { createServerFn } from "@tanstack/react-start";
import type { ExploreData, ExploreProfile, RecentActivityItem } from "@/lib/types";
import { all, getDb } from "@/server/lib/db";
import { authMiddleware } from "@/server/middleware/auth";

const ACTIVITY_LIMIT = 24;
const PROFILE_LIMIT = 12;

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
               AND categories.is_public = 1
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
               AND categories.is_public = 1
               AND NOT EXISTS (
                 SELECT 1 FROM user_blocks blocks
                 WHERE (blocks.blocker_user_id = ? AND blocks.blocked_user_id = user_profiles.user_id)
                    OR (blocks.blocker_user_id = user_profiles.user_id AND blocks.blocked_user_id = ?)
               )
             ORDER BY entries.created_at DESC
             LIMIT ?`
                ).bind(userId, userId, userId, ACTIVITY_LIMIT)
            ),
            all<ExploreProfileRow>(
                db.prepare(
                    `SELECT "user".id AS user_id, "user".name, "user".image,
                    user_profiles.slug, COUNT(categories.id) AS public_category_count
             FROM user_profiles
             INNER JOIN "user" ON "user".id = user_profiles.user_id
             LEFT JOIN categories ON categories.user_id = user_profiles.user_id
               AND categories.is_public = 1
             WHERE user_profiles.is_public = 1
               AND user_profiles.user_id != ?
               AND NOT EXISTS (
                 SELECT 1 FROM user_blocks blocks
                 WHERE (blocks.blocker_user_id = ? AND blocks.blocked_user_id = user_profiles.user_id)
                    OR (blocks.blocker_user_id = user_profiles.user_id AND blocks.blocked_user_id = ?)
               )
             GROUP BY "user".id, "user".name, "user".image, user_profiles.slug,
                      user_profiles.updated_at
             ORDER BY user_profiles.updated_at DESC, lower("user".name) ASC
             LIMIT ?`
                ).bind(userId, userId, userId, PROFILE_LIMIT)
            )
        ]);

        return {
            followingEntries: followingEntries.map(mapRecentActivity),
            recentPublicEntries: recentPublicEntries.map(mapRecentActivity),
            publicProfiles: publicProfiles.map(mapExploreProfile)
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
