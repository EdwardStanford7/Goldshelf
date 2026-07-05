import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { canViewProfile, deriveFollowRelationState } from "@/lib/follows";
import { hasStoredImage } from "@/lib/images";
import { orderEntries } from "@/lib/ranking";
import type {
    CategoryWithEntries,
    CurrentUserProfile,
    Entry,
    FollowProfileSummary,
    FollowRelationState,
    FollowSearchResult,
    FollowStatus,
    ProfileSettingsData,
    ProfileCopyTargetCategory,
    PublicProfileData
} from "@/lib/types";
import { all, assertOwned, first, getDb, newId, now, runBatches } from "@/server/lib/db";
import { authMiddleware, optionalAuthMiddleware } from "@/server/middleware/auth";
import { type CategoryRow, getOwnedCategory } from "./stores/categoryStore";
import {
    MIN_PROFILE_SLUG_LENGTH,
    ensureUserProfile,
    getProfileByUserId,
    getProfileBySlug,
    mapCurrentUserProfile,
    slugifyProfileInput
} from "./stores/profileStore";
import { type EntryRow, mapEntry } from "./stores/entryStore";

const MAX_USER_NAME_LENGTH = 80;
const COPY_PUBLIC_CATEGORY_IMAGE_CONCURRENCY = 4;



interface ProfileSettingsCategoryRow {
    id: string;
    name: string;
    sort_order: number;
    entry_count: number;
    is_public: number;
}

interface FollowProfileRow {
    user_id: string;
    name: string;
    image: string | null;
    slug: string;
    is_public: number;
    public_category_count: number;
    relation_state: FollowRelationState;
    created_at: number;
    accepted_at: number | null;
}

interface FollowSearchRow {
    user_id: string;
    name: string;
    image: string | null;
    slug: string;
    is_public: number;
    public_category_count: number;
    outgoing_status: FollowStatus | null;
    outgoing_created_at: number | null;
    outgoing_accepted_at: number | null;
    incoming_status: FollowStatus | null;
    incoming_created_at: number | null;
    incoming_accepted_at: number | null;
}

interface CopyableCategoryRow {
    id: string;
    user_id: string;
    name: string;
    profile_is_public: number;
    owner_name: string;
}

type CopyPublicCategoryInput =
    | { sourceCategoryId: string; mode: "new"; categoryName: string; sourceEntryIds?: string[] }
    | { sourceCategoryId: string; mode: "merge"; targetCategoryId: string; sourceEntryIds?: string[] };

export const updateUserProfile = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { name: string; slug?: string; isPublic?: boolean }) => data)
    .handler(async ({ context, data: input }) => {
        const userId = context.user.id;
        const profile = await ensureUserProfile(userId);
        const cleanName = input.name.trim();
        if (!cleanName) {
            throw new Error("Username is required");
        }

        if (cleanName.length > MAX_USER_NAME_LENGTH) {
            throw new Error(`Username must be ${MAX_USER_NAME_LENGTH} characters or fewer`);
        }

        const nextSlug = input.slug === undefined
            ? profile.slug
            : normalizeProfileSlug(input.slug);
        if (nextSlug !== profile.slug) {
            await assertProfileSlugAvailable(userId, nextSlug);
        }

        const nextIsPublic = input.isPublic === undefined ? Boolean(profile.is_public) : input.isPublic;
        const updatedAt = now();
        const db = getDb();
        await db.batch([
            db
                .prepare(
                    `UPDATE "user"
           SET name = ?, updatedAt = ?
           WHERE id = ?`
                )
                .bind(cleanName, updatedAt, userId),
            db
                .prepare(
                    `UPDATE user_profiles
           SET slug = ?, is_public = ?, updated_at = ?
           WHERE user_id = ?`
                )
                .bind(nextSlug, nextIsPublic ? 1 : 0, updatedAt, userId)
        ]);

        return {
            name: cleanName,
            profileSlug: nextSlug,
            profileIsPublic: nextIsPublic
        };
    });

export const loadProfileSettings = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .handler(async ({ context }) => {
        const userId = context.user.id;
        const profile = await ensureUserProfile(userId);
        const categories = await all<ProfileSettingsCategoryRow>(
            getDb()
                .prepare(
                    `SELECT categories.id, categories.name, categories.sort_order,
                    categories.is_public, COUNT(entries.id) AS entry_count
             FROM categories
             LEFT JOIN entries ON entries.category_id = categories.id
               AND entries.user_id = categories.user_id
               AND entries.status = 'active'
             WHERE categories.user_id = ?
             GROUP BY categories.id, categories.name, categories.sort_order, categories.is_public
             ORDER BY categories.sort_order ASC, categories.name ASC`
                )
                .bind(userId)
        );

        return {
            user: {
                id: profile.user_id,
                name: profile.name,
                imageKey: profile.image,
                slug: profile.slug,
                isPublic: Boolean(profile.is_public)
            },
            categories: categories.map((category) => ({
                id: category.id,
                name: category.name,
                sortOrder: category.sort_order,
                entryCount: category.entry_count,
                isPublic: Boolean(category.is_public)
            })),
            following: await listFollowProfiles(userId, "following"),
            followers: await listFollowProfiles(userId, "followers"),
            suggestedProfiles: await listSuggestedProfiles(userId),
            incomingFollowRequests: await listFollowProfiles(userId, "incoming_requests"),
            outgoingFollowRequests: await listFollowProfiles(userId, "outgoing_requests"),
            blockedProfiles: await listBlockedProfiles(userId)
        };
    });

export const searchPublicProfiles = createServerFn({ method: "GET" })
    .middleware([authMiddleware])
    .inputValidator((data: { query: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { query } = data;
        const cleanQuery = query.trim().toLowerCase();
        if (cleanQuery.length < 2) {
            return [];
        }

        const searchPattern = `%${cleanQuery.replace(/[%_]/g, "")}%`;
        const rows = await all<FollowSearchRow>(
            getDb()
                .prepare(
                    `SELECT "user".id AS user_id, "user".name, "user".image,
                    user_profiles.slug, user_profiles.is_public,
                    COUNT(categories.id) AS public_category_count,
                    outgoing.status AS outgoing_status,
                    outgoing.created_at AS outgoing_created_at,
                    outgoing.accepted_at AS outgoing_accepted_at,
                    incoming.status AS incoming_status,
                    incoming.created_at AS incoming_created_at,
                    incoming.accepted_at AS incoming_accepted_at
             FROM user_profiles
             INNER JOIN "user" ON "user".id = user_profiles.user_id
             LEFT JOIN categories ON categories.user_id = user_profiles.user_id
               AND categories.is_public = 1
             LEFT JOIN user_follows outgoing
               ON outgoing.follower_user_id = ?
              AND outgoing.followed_user_id = user_profiles.user_id
             LEFT JOIN user_follows incoming
               ON incoming.follower_user_id = user_profiles.user_id
              AND incoming.followed_user_id = ?
             WHERE user_profiles.is_public = 1
               AND user_profiles.user_id != ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM user_blocks blocks
                 WHERE (blocks.blocker_user_id = ? AND blocks.blocked_user_id = user_profiles.user_id)
                    OR (blocks.blocker_user_id = user_profiles.user_id AND blocks.blocked_user_id = ?)
               )
               AND (lower(user_profiles.slug) LIKE ? OR lower("user".name) LIKE ?)
             GROUP BY "user".id, "user".name, "user".image, user_profiles.slug,
               user_profiles.is_public, outgoing.status, outgoing.created_at,
               outgoing.accepted_at, incoming.status, incoming.created_at,
               incoming.accepted_at
             ORDER BY
               CASE
                 WHEN lower(user_profiles.slug) = ? THEN 0
                 WHEN lower(user_profiles.slug) LIKE ? THEN 1
                 ELSE 2
               END,
               lower("user".name) ASC,
               user_profiles.slug ASC
             LIMIT 12`
                )
                .bind(userId, userId, userId, userId, userId, searchPattern, searchPattern, cleanQuery, `${cleanQuery}%`)
        );

        return rows.map((row): FollowSearchResult => ({
            ...mapFollowSearchRow(row),
            matchKind: "public_profile"
        }));
    });

export const requestFollowByProfileSlug = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { profileSlugOrUrl: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { profileSlugOrUrl } = data;
        const slug = parseProfileSlugInput(profileSlugOrUrl);
        const profile = await getProfileBySlug(slug);
        if (!profile) {
            throw new Error("Profile not found");
        }

        return followProfileForUser(userId, profile.user_id);
    });

export const followProfile = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { profileUserId: string }) => data)
    .handler(async ({ context, data }) => followProfileForUser(context.user.id, data.profileUserId));

async function followProfileForUser(userId: string, profileUserId: string) {
    if (userId === profileUserId) {
        throw new Error("You cannot follow yourself");
    }

    await ensureUserProfile(userId);
    const profile = await getProfileByUserId(profileUserId);
    assertOwned(profile, "Profile");

    const blockRelation = await getBlockRelation(userId, profileUserId);
    if (blockRelation.viewerBlockedTarget) {
        throw new Error("Unblock this profile before following");
    }
    if (blockRelation.targetBlockedViewer) {
        throw new Error("This profile is not available");
    }

    const existing = await getFollowRelationRows(userId, profileUserId);
    if (existing.outgoingStatus === "accepted") {
        return {
            profileUserId,
            relationState: deriveFollowRelationState(existing.outgoingStatus, existing.incomingStatus)
        };
    }
    if (existing.outgoingStatus === "pending") {
        if (profile.is_public) {
            const acceptedAt = now();
            await getDb()
                .prepare(
                    `UPDATE user_follows
             SET status = 'accepted', accepted_at = ?
             WHERE follower_user_id = ? AND followed_user_id = ? AND status = 'pending'`
                )
                .bind(acceptedAt, userId, profileUserId)
                .run();
            const nextRelation = await getFollowRelationState(userId, profileUserId);
            return { profileUserId, relationState: nextRelation };
        }

        return {
            profileUserId,
            relationState: deriveFollowRelationState(existing.outgoingStatus, existing.incomingStatus)
        };
    }

    const createdAt = now();
    const status: FollowStatus = profile.is_public ? "accepted" : "pending";
    await getDb()
        .prepare(
            `INSERT INTO user_follows (
             follower_user_id, followed_user_id, status, created_at, accepted_at
           )
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(follower_user_id, followed_user_id)
           DO UPDATE SET
             status = excluded.status,
             created_at = excluded.created_at,
             accepted_at = excluded.accepted_at`
        )
        .bind(userId, profileUserId, status, createdAt, status === "accepted" ? createdAt : null)
        .run();

    const nextRelation = await getFollowRelationState(userId, profileUserId);
    return { profileUserId, relationState: nextRelation };
}

export const approveFollowRequest = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { followerUserId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { followerUserId } = data;
        if (userId === followerUserId) {
            throw new Error("You cannot follow yourself");
        }

        const request = await first<{ follower_user_id: string }>(
            getDb()
                .prepare(
                    `SELECT follower_user_id
             FROM user_follows
             WHERE follower_user_id = ? AND followed_user_id = ? AND status = 'pending'`
                )
                .bind(followerUserId, userId)
        );
        if (!request) {
            throw new Error("Follow request not found");
        }

        const blockRelation = await getBlockRelation(userId, followerUserId);
        if (blockRelation.viewerBlockedTarget || blockRelation.targetBlockedViewer) {
            throw new Error("This follow request is no longer available");
        }

        const acceptedAt = now();
        await getDb()
            .prepare(
                `UPDATE user_follows
           SET status = 'accepted', accepted_at = ?
           WHERE follower_user_id = ? AND followed_user_id = ? AND status = 'pending'`
            )
            .bind(acceptedAt, followerUserId, userId)
            .run();

        const nextRelation = await getFollowRelationState(userId, followerUserId);
        return { followerUserId, relationState: nextRelation };
    });

export const declineFollowRequest = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { followerUserId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { followerUserId } = data;
        await getDb()
            .prepare(
                `DELETE FROM user_follows
           WHERE follower_user_id = ? AND followed_user_id = ? AND status = 'pending'`
            )
            .bind(followerUserId, userId)
            .run();

        return { followerUserId };
    });

export const cancelFollowRequest = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { followedUserId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { followedUserId } = data;
        await getDb()
            .prepare(
                `DELETE FROM user_follows
           WHERE follower_user_id = ? AND followed_user_id = ? AND status = 'pending'`
            )
            .bind(userId, followedUserId)
            .run();

        return { followedUserId };
    });

export const removeFollow = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { followedUserId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { followedUserId } = data;
        await getDb()
            .prepare(
                `DELETE FROM user_follows
           WHERE follower_user_id = ? AND followed_user_id = ? AND status = 'accepted'`
            )
            .bind(userId, followedUserId)
            .run();

        return { followedUserId };
    });

export const blockProfile = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { profileUserId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { profileUserId } = data;
        if (userId === profileUserId) {
            throw new Error("You cannot block yourself");
        }

        const profile = await getProfileByUserId(profileUserId);
        assertOwned(profile, "Profile");

        const db = getDb();
        await db.batch([
            db
                .prepare(
                    `INSERT OR IGNORE INTO user_blocks (blocker_user_id, blocked_user_id, created_at)
             VALUES (?, ?, ?)`
                )
                .bind(userId, profileUserId, now()),
            db
                .prepare(
                    `DELETE FROM user_follows
             WHERE (follower_user_id = ? AND followed_user_id = ?)
                OR (follower_user_id = ? AND followed_user_id = ?)`
                )
                .bind(userId, profileUserId, profileUserId, userId)
        ]);

        return { profileUserId };
    });

export const unblockProfile = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { profileUserId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { profileUserId } = data;
        await getDb()
            .prepare(
                `DELETE FROM user_blocks
           WHERE blocker_user_id = ? AND blocked_user_id = ?`
            )
            .bind(userId, profileUserId)
            .run();

        return { profileUserId };
    });

export const loadPublicProfile = createServerFn({ method: "GET" })
    .middleware([optionalAuthMiddleware])
    .inputValidator((data: { profileSlug: string }) => data)
    .handler(async ({ context, data }) => {
        const viewerUserId = context.user?.id ?? null;
        const { profileSlug } = data;
        const slug = parseProfileSlugInput(profileSlug);
        const profile = await getProfileBySlug(slug);
        if (!profile) {
            return null;
        }

        const isSelf = viewerUserId === profile.user_id;
        const relationState = viewerUserId
            ? await getFollowRelationState(viewerUserId, profile.user_id)
            : "none";
        if (!canViewProfile(Boolean(profile.is_public), isSelf, relationState)) {
            return null;
        }

        const categories = await loadPublicCategories(profile.user_id);
        const viewerCategories = viewerUserId
            ? await listCopyTargetCategories(viewerUserId)
            : [];

        return {
            profile: {
                userId: profile.user_id,
                name: profile.name,
                imageKey: profile.image,
                slug: profile.slug,
                isPublic: Boolean(profile.is_public),
                isSelf,
                relationState
            },
            categories,
            viewer: {
                isSignedIn: Boolean(viewerUserId),
                isSelf,
                relationState,
                categories: viewerCategories
            }
        };
    });

export const copyPublicCategoryToQueue = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: CopyPublicCategoryInput) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const sourceCategoryId = data.sourceCategoryId.trim();
        if (!sourceCategoryId) {
            throw new Error("Shared category is required");
        }

        const sourceCategory = await first<CopyableCategoryRow>(
            getDb()
                .prepare(
                    `SELECT categories.id, categories.user_id, categories.name,
                    user_profiles.is_public AS profile_is_public,
                    "user".name AS owner_name
             FROM categories
             INNER JOIN user_profiles ON user_profiles.user_id = categories.user_id
             INNER JOIN "user" ON "user".id = categories.user_id
             WHERE categories.id = ? AND categories.is_public = 1`
                )
                .bind(sourceCategoryId)
        );
        assertOwned(sourceCategory, "Shared category");

        if (sourceCategory.user_id === userId) {
            throw new Error("You already own this category");
        }

        const relationState = await getFollowRelationState(userId, sourceCategory.user_id);
        if (!canViewProfile(Boolean(sourceCategory.profile_is_public), false, relationState)) {
            throw new Error("Shared category not found");
        }

        const entries = await all<EntryRow>(
            getDb()
                .prepare(
                    `SELECT id, category_id, name, rank_position, image_key, created_at
             FROM entries
             WHERE user_id = ? AND category_id = ? AND status = 'active'
             ORDER BY rank_position ASC, name ASC`
                )
                .bind(sourceCategory.user_id, sourceCategory.id)
        );
        const orderedEntries = orderEntries(entries.map(mapEntry));
        const createdAt = now();
        const db = getDb();
        let targetCategoryId: string;
        let targetCategoryName: string;
        let categoryInsertStatement: D1PreparedStatement | null = null;
        let entriesToQueue = selectedOrderedEntries(orderedEntries, data.sourceEntryIds);
        let skippedCount = 0;

        if (data.mode === "new") {
            const cleanName = data.categoryName.trim();
            if (!cleanName) {
                throw new Error("Category name is required");
            }

            await assertCategoryNameAvailable(userId, cleanName);
            targetCategoryId = newId("cat");
            targetCategoryName = cleanName;

            const maxSort = await first<{ max_sort: number | null }>(
                db
                    .prepare(`SELECT MAX(sort_order) AS max_sort FROM categories WHERE user_id = ?`)
                    .bind(userId)
            );
            categoryInsertStatement = db
                .prepare(
                    `INSERT INTO categories (id, user_id, name, sort_order, created_at, updated_at, is_public)
             VALUES (?, ?, ?, ?, ?, ?, 0)`
                )
                .bind(
                    targetCategoryId,
                    userId,
                    targetCategoryName,
                    (maxSort?.max_sort ?? -1) + 1,
                    createdAt,
                    createdAt
                );
        } else if (data.mode === "merge") {
            const targetCategory = await getOwnedCategory(userId, data.targetCategoryId);
            assertOwned(targetCategory, "Target category");
            targetCategoryId = targetCategory.id;
            targetCategoryName = targetCategory.name;

            const existingRows = await all<{ name: string }>(
                db
                    .prepare(
                        `SELECT name
                 FROM entries
                 WHERE user_id = ? AND category_id = ? AND status != 'deleted'
                 UNION
                 SELECT name
                 FROM entry_queue
                 WHERE user_id = ? AND category_id = ? AND status = 'queued'`
                    )
                    .bind(userId, targetCategoryId, userId, targetCategoryId)
            );
            const unavailableNames = new Set(existingRows.map((row) => row.name));
            entriesToQueue = orderedEntries.filter((entry) => {
                if (unavailableNames.has(entry.name)) {
                    skippedCount += 1;
                    return false;
                }

                unavailableNames.add(entry.name);
                return true;
            });
        } else {
            throw new Error("Copy mode is required");
        }

        const copiedImageKeys: string[] = [];
        let queuedEntries: QueuedPublicCategoryCopyEntry[] = [];

        try {
            queuedEntries = await copyPublicCategoryEntriesToQueueImages(
                userId,
                entriesToQueue.map((entry, index) => ({
                    entry,
                    queueId: newId("queue"),
                    createdAt: createdAt + index
                })),
                copiedImageKeys
            );

            const statements: D1PreparedStatement[] = [
                ...(categoryInsertStatement ? [categoryInsertStatement] : []),
                ...queuedEntries.map((entry) =>
                    db
                        .prepare(
                            `INSERT INTO entry_queue (
                       id, user_id, category_id, name, image_key, available_at,
                       status, created_at, updated_at
                     )
                     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
                        )
                        .bind(
                            entry.id,
                            userId,
                            targetCategoryId,
                            entry.name,
                            entry.imageKey,
                            entry.createdAt,
                            entry.createdAt,
                            entry.createdAt
                        )
                )
            ];

            await runBatches(db, statements);
        } catch (error) {
            await Promise.all(copiedImageKeys.map((imageKey) => env.IMAGES.delete(imageKey).catch(() => undefined)));
            throw error;
        }

        return {
            categoryId: targetCategoryId,
            categoryName: targetCategoryName,
            copiedCount: queuedEntries.length,
            mode: data.mode,
            ownerName: sourceCategory.owner_name,
            skippedCount
        };
    });

interface QueuedPublicCategoryCopyEntry {
    id: string;
    name: string;
    imageKey: string | null;
    createdAt: number;
}

interface PublicCategoryImageCopyInput {
    entry: Entry;
    queueId: string;
    createdAt: number;
}

function selectedOrderedEntries(orderedEntries: Entry[], sourceEntryIds: string[] | undefined) {
    if (sourceEntryIds === undefined) {
        return orderedEntries;
    }

    if (!Array.isArray(sourceEntryIds)) {
        throw new Error("Selected entries are required");
    }

    const selectedEntryIds = Array.from(new Set(sourceEntryIds.map((id) => id.trim()).filter(Boolean)));
    if (selectedEntryIds.length === 0) {
        throw new Error("Select at least one entry to copy");
    }

    const selectedEntryIdSet = new Set(selectedEntryIds);
    const entries = orderedEntries.filter((entry) => selectedEntryIdSet.has(entry.id));
    if (entries.length !== selectedEntryIdSet.size) {
        throw new Error("Selected entries are no longer available");
    }

    return entries;
}

async function copyPublicCategoryEntriesToQueueImages(
    userId: string,
    inputs: PublicCategoryImageCopyInput[],
    copiedImageKeys: string[]
) {
    if (inputs.length === 0) {
        return [];
    }

    const queuedEntries: Array<QueuedPublicCategoryCopyEntry | undefined> = new Array(inputs.length);
    let nextIndex = 0;
    const workerCount = Math.min(COPY_PUBLIC_CATEGORY_IMAGE_CONCURRENCY, inputs.length);

    const workerResults = await Promise.allSettled(Array.from({ length: workerCount }, async () => {
        while (nextIndex < inputs.length) {
            const index = nextIndex;
            nextIndex += 1;
            const input = inputs[index];
            if (!input) {
                continue;
            }

            const copiedImageKey = await copyEntryImageToQueueImage(
                userId,
                input.queueId,
                input.entry.imageKey,
                input.createdAt
            );
            if (hasStoredImage(copiedImageKey)) {
                copiedImageKeys.push(copiedImageKey);
            }

            queuedEntries[index] = {
                id: input.queueId,
                name: input.entry.name,
                imageKey: copiedImageKey,
                createdAt: input.createdAt
            };
        }
    }));
    const failedWorker = workerResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedWorker) {
        throw failedWorker.reason;
    }

    return queuedEntries.map((entry) => {
        if (!entry) {
            throw new Error("Failed to prepare copied entry");
        }

        return entry;
    });
}

async function assertProfileSlugAvailable(userId: string, profileSlug: string) {
    const existing = await first<{ user_id: string }>(
        getDb()
            .prepare(`SELECT user_id FROM user_profiles WHERE slug = ? AND user_id != ?`)
            .bind(profileSlug, userId)
    );
    if (existing) {
        throw new Error("That public handle is already taken");
    }
}

async function assertCategoryNameAvailable(userId: string, categoryName: string) {
    const existing = await first<{ id: string }>(
        getDb()
            .prepare(`SELECT id FROM categories WHERE user_id = ? AND name = ?`)
            .bind(userId, categoryName)
    );
    if (existing) {
        throw new Error("That category name already exists");
    }
}

async function copyEntryImageToQueueImage(
    userId: string,
    queueId: string,
    sourceImageKey: string | null,
    timestamp: number
) {
    if (!hasStoredImage(sourceImageKey)) {
        return sourceImageKey;
    }

    const image = await env.IMAGES.get(sourceImageKey);
    if (!image?.body) {
        return null;
    }

    const imageKey = `${userId}/queue/${queueId}-copy-${timestamp}.jpg`;
    await env.IMAGES.put(imageKey, image.body, {
        httpMetadata: {
            contentType: image.httpMetadata?.contentType ?? "image/jpeg"
        }
    });

    return imageKey;
}

async function listCopyTargetCategories(userId: string): Promise<ProfileCopyTargetCategory[]> {
    const rows = await all<Pick<CategoryRow, "id" | "name">>(
        getDb()
            .prepare(
                `SELECT id, name
         FROM categories
         WHERE user_id = ?
         ORDER BY sort_order ASC, name ASC`
            )
            .bind(userId)
    );

    return rows.map((row) => ({
        id: row.id,
        name: row.name
    }));
}

async function loadPublicCategories(userId: string): Promise<CategoryWithEntries[]> {
    const categories = await all<CategoryRow>(
        getDb()
            .prepare(
                `SELECT id, name, sort_order, created_at, is_public
         FROM categories
         WHERE user_id = ? AND is_public = 1
         ORDER BY sort_order ASC, name ASC`
            )
            .bind(userId)
    );

    if (categories.length === 0) {
        return [];
    }

    const entryRows = await all<EntryRow>(
        getDb()
            .prepare(
                `SELECT entries.id, entries.category_id, entries.name, entries.rank_position,
                entries.image_key, entries.created_at
         FROM entries
         INNER JOIN categories ON categories.id = entries.category_id
         WHERE entries.user_id = ? AND entries.status = 'active'
           AND categories.user_id = entries.user_id
           AND categories.is_public = 1
         ORDER BY entries.category_id ASC, entries.rank_position ASC`
            )
            .bind(userId)
    );
    const entriesByCategory = new Map<string, Entry[]>();
    for (const row of entryRows) {
        const entries = entriesByCategory.get(row.category_id) ?? [];
        entries.push(mapEntry(row));
        entriesByCategory.set(row.category_id, entries);
    }

    return categories.map((category) => ({
        id: category.id,
        name: category.name,
        sortOrder: category.sort_order,
        createdAt: category.created_at,
        isPublic: Boolean(category.is_public),
        entries: orderEntries(entriesByCategory.get(category.id) ?? [])
    }));
}

type FollowProfileListKind =
    | "following"
    | "followers"
    | "incoming_requests"
    | "outgoing_requests";

async function listFollowProfiles(
    userId: string,
    kind: FollowProfileListKind
): Promise<FollowProfileSummary[]> {
    if (kind === "following") {
        const rows = await all<FollowProfileRow>(
            getDb()
                .prepare(
                    `SELECT "user".id AS user_id, "user".name, "user".image,
                    user_profiles.slug, user_profiles.is_public,
                    user_follows.created_at, user_follows.accepted_at,
                    COUNT(categories.id) AS public_category_count,
                    CASE
                      WHEN reciprocal.status = 'accepted' THEN 'mutual'
                      ELSE 'following'
                    END AS relation_state
             FROM user_follows
             INNER JOIN "user" ON "user".id = user_follows.followed_user_id
             INNER JOIN user_profiles ON user_profiles.user_id = user_follows.followed_user_id
             LEFT JOIN categories ON categories.user_id = user_follows.followed_user_id
               AND categories.is_public = 1
             LEFT JOIN user_follows reciprocal
               ON reciprocal.follower_user_id = user_follows.followed_user_id
              AND reciprocal.followed_user_id = ?
              AND reciprocal.status = 'accepted'
             WHERE user_follows.follower_user_id = ?
               AND user_follows.status = 'accepted'
             GROUP BY "user".id, "user".name, "user".image, user_profiles.slug,
               user_profiles.is_public, user_follows.created_at, user_follows.accepted_at,
               reciprocal.status
             ORDER BY lower("user".name) ASC, user_profiles.slug ASC`
                )
                .bind(userId, userId)
        );
        return rows.map(mapFollowProfile);
    }

    if (kind === "followers") {
        const rows = await all<FollowProfileRow>(
            getDb()
                .prepare(
                    `SELECT "user".id AS user_id, "user".name, "user".image,
                    user_profiles.slug, user_profiles.is_public,
                    user_follows.created_at, user_follows.accepted_at,
                    COUNT(categories.id) AS public_category_count,
                    CASE
                      WHEN reciprocal.status = 'accepted' THEN 'mutual'
                      WHEN reciprocal.status = 'pending' THEN 'requested'
                      ELSE 'follows_you'
                    END AS relation_state
             FROM user_follows
             INNER JOIN "user" ON "user".id = user_follows.follower_user_id
             INNER JOIN user_profiles ON user_profiles.user_id = user_follows.follower_user_id
             LEFT JOIN categories ON categories.user_id = user_follows.follower_user_id
               AND categories.is_public = 1
             LEFT JOIN user_follows reciprocal
               ON reciprocal.follower_user_id = ?
              AND reciprocal.followed_user_id = user_follows.follower_user_id
              AND reciprocal.status IN ('pending', 'accepted')
             WHERE user_follows.followed_user_id = ?
               AND user_follows.status = 'accepted'
             GROUP BY "user".id, "user".name, "user".image, user_profiles.slug,
               user_profiles.is_public, user_follows.created_at, user_follows.accepted_at,
               reciprocal.status
             ORDER BY lower("user".name) ASC, user_profiles.slug ASC`
                )
                .bind(userId, userId)
        );
        return rows.map(mapFollowProfile);
    }

    if (kind === "incoming_requests") {
        const rows = await all<FollowProfileRow>(
            getDb()
                .prepare(
                    `SELECT "user".id AS user_id, "user".name, "user".image,
                    user_profiles.slug, user_profiles.is_public,
                    user_follows.created_at, user_follows.accepted_at,
                    COUNT(categories.id) AS public_category_count,
                    'incoming_request' AS relation_state
             FROM user_follows
             INNER JOIN "user" ON "user".id = user_follows.follower_user_id
             INNER JOIN user_profiles ON user_profiles.user_id = user_follows.follower_user_id
             LEFT JOIN categories ON categories.user_id = user_follows.follower_user_id
               AND categories.is_public = 1
             WHERE user_follows.followed_user_id = ?
               AND user_follows.status = 'pending'
             GROUP BY "user".id, "user".name, "user".image, user_profiles.slug,
               user_profiles.is_public, user_follows.created_at, user_follows.accepted_at
             ORDER BY user_follows.created_at ASC`
                )
                .bind(userId)
        );
        return rows.map(mapFollowProfile);
    }

    const rows = await all<FollowProfileRow>(
        getDb()
            .prepare(
                `SELECT "user".id AS user_id, "user".name, "user".image,
                user_profiles.slug, user_profiles.is_public,
                user_follows.created_at, user_follows.accepted_at,
                COUNT(categories.id) AS public_category_count,
                'requested' AS relation_state
         FROM user_follows
         INNER JOIN "user" ON "user".id = user_follows.followed_user_id
         INNER JOIN user_profiles ON user_profiles.user_id = user_follows.followed_user_id
         LEFT JOIN categories ON categories.user_id = user_follows.followed_user_id
           AND categories.is_public = 1
         WHERE user_follows.follower_user_id = ?
           AND user_follows.status = 'pending'
         GROUP BY "user".id, "user".name, "user".image, user_profiles.slug,
           user_profiles.is_public, user_follows.created_at, user_follows.accepted_at
         ORDER BY user_follows.created_at ASC`
            )
            .bind(userId)
    );
    return rows.map(mapFollowProfile);
}

async function listBlockedProfiles(userId: string): Promise<FollowProfileSummary[]> {
    const rows = await all<FollowProfileRow>(
        getDb()
            .prepare(
                `SELECT "user".id AS user_id, "user".name, "user".image,
                user_profiles.slug, user_profiles.is_public,
                user_blocks.created_at, NULL AS accepted_at,
                COUNT(categories.id) AS public_category_count,
                'none' AS relation_state
         FROM user_blocks
         INNER JOIN "user" ON "user".id = user_blocks.blocked_user_id
         INNER JOIN user_profiles ON user_profiles.user_id = user_blocks.blocked_user_id
         LEFT JOIN categories ON categories.user_id = user_blocks.blocked_user_id
           AND categories.is_public = 1
         WHERE user_blocks.blocker_user_id = ?
         GROUP BY "user".id, "user".name, "user".image, user_profiles.slug,
           user_profiles.is_public, user_blocks.created_at
         ORDER BY user_blocks.created_at DESC, lower("user".name) ASC`
            )
            .bind(userId)
    );

    return rows.map(mapFollowProfile);
}

async function listSuggestedProfiles(userId: string): Promise<FollowProfileSummary[]> {
    const rows = await all<FollowProfileRow>(
        getDb()
            .prepare(
                `WITH direct_connections AS (
                   SELECT followed_user_id AS user_id
                   FROM user_follows
                   WHERE follower_user_id = ? AND status = 'accepted'
                   UNION
                   SELECT follower_user_id AS user_id
                   FROM user_follows
                   WHERE followed_user_id = ? AND status = 'accepted'
                 ),
                 candidate_links AS (
                   SELECT user_follows.followed_user_id AS user_id,
                          user_follows.follower_user_id AS through_user_id
                   FROM user_follows
                   INNER JOIN direct_connections
                     ON direct_connections.user_id = user_follows.follower_user_id
                   WHERE user_follows.status = 'accepted'
                   UNION ALL
                   SELECT user_follows.follower_user_id AS user_id,
                          user_follows.followed_user_id AS through_user_id
                   FROM user_follows
                   INNER JOIN direct_connections
                     ON direct_connections.user_id = user_follows.followed_user_id
                   WHERE user_follows.status = 'accepted'
                 ),
                 candidates AS (
                   SELECT candidate_links.user_id,
                          COUNT(DISTINCT candidate_links.through_user_id) AS shared_connection_count
                   FROM candidate_links
                   WHERE candidate_links.user_id != ?
                     AND candidate_links.user_id NOT IN (SELECT user_id FROM direct_connections)
                   GROUP BY candidate_links.user_id
                 )
                 SELECT "user".id AS user_id, "user".name, "user".image,
                        user_profiles.slug, user_profiles.is_public,
                        COUNT(categories.id) AS public_category_count,
                        'none' AS relation_state,
                        0 AS created_at,
                        NULL AS accepted_at
                 FROM candidates
                 INNER JOIN user_profiles ON user_profiles.user_id = candidates.user_id
                 INNER JOIN "user" ON "user".id = candidates.user_id
                 LEFT JOIN categories ON categories.user_id = candidates.user_id
                   AND categories.is_public = 1
                 WHERE user_profiles.is_public = 1
                   AND NOT EXISTS (
                     SELECT 1
                     FROM user_follows direct
                     WHERE (direct.follower_user_id = ? AND direct.followed_user_id = candidates.user_id)
                        OR (direct.follower_user_id = candidates.user_id AND direct.followed_user_id = ?)
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM user_blocks blocks
                     WHERE (blocks.blocker_user_id = ? AND blocks.blocked_user_id = candidates.user_id)
                        OR (blocks.blocker_user_id = candidates.user_id AND blocks.blocked_user_id = ?)
                   )
                 GROUP BY "user".id, "user".name, "user".image, user_profiles.slug,
                          user_profiles.is_public, candidates.shared_connection_count
                 ORDER BY candidates.shared_connection_count DESC,
                          COUNT(categories.id) DESC,
                          lower("user".name) ASC,
                          user_profiles.slug ASC
                 LIMIT 8`
            )
            .bind(userId, userId, userId, userId, userId, userId, userId)
    );

    return rows.map(mapFollowProfile);
}

function mapFollowProfile(row: FollowProfileRow): FollowProfileSummary {
    return {
        userId: row.user_id,
        name: row.name,
        imageKey: row.image,
        slug: row.slug,
        isPublic: Boolean(row.is_public),
        publicCategoryCount: row.public_category_count,
        relationState: row.relation_state,
        createdAt: row.created_at,
        acceptedAt: row.accepted_at
    };
}

function mapFollowSearchRow(row: FollowSearchRow): FollowProfileSummary {
    const relationState = deriveFollowRelationState(row.outgoing_status, row.incoming_status);
    const createdAt = row.outgoing_created_at ?? row.incoming_created_at ?? 0;
    const acceptedAt = row.outgoing_accepted_at ?? row.incoming_accepted_at ?? null;

    return {
        userId: row.user_id,
        name: row.name,
        imageKey: row.image,
        slug: row.slug,
        isPublic: Boolean(row.is_public),
        publicCategoryCount: row.public_category_count,
        relationState,
        createdAt,
        acceptedAt
    };
}

async function getFollowRelationState(
    followerUserId: string,
    followedUserId: string
): Promise<FollowRelationState> {
    const rows = await getFollowRelationRows(followerUserId, followedUserId);
    return deriveFollowRelationState(rows.outgoingStatus, rows.incomingStatus);
}

async function getFollowRelationRows(
    followerUserId: string,
    followedUserId: string
): Promise<{ outgoingStatus: FollowStatus | null; incomingStatus: FollowStatus | null }> {
    if (followerUserId === followedUserId) {
        return { outgoingStatus: null, incomingStatus: null };
    }

    const rows = await all<{
        follower_user_id: string;
        followed_user_id: string;
        status: FollowStatus;
    }>(
        getDb()
            .prepare(
                `SELECT follower_user_id, followed_user_id, status
         FROM user_follows
         WHERE (follower_user_id = ? AND followed_user_id = ?)
            OR (follower_user_id = ? AND followed_user_id = ?)`
            )
            .bind(followerUserId, followedUserId, followedUserId, followerUserId)
    );

    let outgoingStatus: FollowStatus | null = null;
    let incomingStatus: FollowStatus | null = null;
    for (const row of rows) {
        if (row.follower_user_id === followerUserId && row.followed_user_id === followedUserId) {
            outgoingStatus = row.status;
        } else if (row.follower_user_id === followedUserId && row.followed_user_id === followerUserId) {
            incomingStatus = row.status;
        }
    }

    return { outgoingStatus, incomingStatus };
}

async function getBlockRelation(
    viewerUserId: string,
    profileUserId: string
): Promise<{ viewerBlockedTarget: boolean; targetBlockedViewer: boolean }> {
    if (viewerUserId === profileUserId) {
        return { viewerBlockedTarget: false, targetBlockedViewer: false };
    }

    const rows = await all<{
        blocker_user_id: string;
        blocked_user_id: string;
    }>(
        getDb()
            .prepare(
                `SELECT blocker_user_id, blocked_user_id
         FROM user_blocks
         WHERE (blocker_user_id = ? AND blocked_user_id = ?)
            OR (blocker_user_id = ? AND blocked_user_id = ?)`
            )
            .bind(viewerUserId, profileUserId, profileUserId, viewerUserId)
    );

    let viewerBlockedTarget = false;
    let targetBlockedViewer = false;
    for (const row of rows) {
        if (row.blocker_user_id === viewerUserId && row.blocked_user_id === profileUserId) {
            viewerBlockedTarget = true;
        } else if (row.blocker_user_id === profileUserId && row.blocked_user_id === viewerUserId) {
            targetBlockedViewer = true;
        }
    }

    return { viewerBlockedTarget, targetBlockedViewer };
}

function normalizeProfileSlug(value: string) {
    const slug = slugifyProfileInput(value);
    if (slug.length < MIN_PROFILE_SLUG_LENGTH) {
        throw new Error(`Public handle must be at least ${MIN_PROFILE_SLUG_LENGTH} characters`);
    }

    return slug;
}

function parseProfileSlugInput(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error("Public handle is required");
    }

    try {
        const url = new URL(trimmed);
        const profilePathIndex = url.pathname.split("/").findIndex((part) => part === "u");
        const profilePathSlug = profilePathIndex >= 0
            ? url.pathname.split("/")[profilePathIndex + 1]
            : url.pathname.split("/").filter(Boolean).at(-1);
        return normalizeProfileSlug(profilePathSlug ?? trimmed);
    } catch {
        return normalizeProfileSlug(trimmed.replace(/^@/, ""));
    }
}
