import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { hasStoredImage } from "@/lib/images";
import { all, assertOwned, first, getDb, newId, now } from "@/server/lib/db";
import { MAX_CATEGORY_NAME_LENGTH, normalizeRequiredText } from "@/server/lib/validation";
import { authMiddleware } from "@/server/middleware/auth";
import {
    type CategoryRow,
    getOwnedCategory,
    rewriteUserCategoryOrderStatements
} from "./stores/categoryStore";
import { assertNoActiveBinarySession } from "./engine/rankingSessions";

export const createCategory = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { name: string; isPublic?: boolean }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const cleanName = normalizeRequiredText(data.name, "Category name", MAX_CATEGORY_NAME_LENGTH);

        const db = getDb();
        const maxSort = await first<{ max_sort: number | null }>(
            db
                .prepare(
                    `SELECT MAX(sort_order) AS max_sort
         FROM categories
         WHERE user_id = ?`
                )
                .bind(userId)
        );
        const createdAt = now();
        const id = newId("cat");

        await db
            .prepare(
                `INSERT INTO categories (id, user_id, name, sort_order, created_at, updated_at, is_public)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(id, userId, cleanName, (maxSort?.max_sort ?? -1) + 1, createdAt, createdAt, data.isPublic ? 1 : 0)
            .run();

        return id;
    });

export const renameCategory = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { categoryId: string; name: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const category = await getOwnedCategory(userId, data.categoryId);
        assertOwned(category, "Category");

        const cleanName = normalizeRequiredText(data.name, "Category name", MAX_CATEGORY_NAME_LENGTH);

        const updatedAt = now();
        await getDb()
            .prepare(
                `UPDATE categories
       SET name = ?, updated_at = ?
       WHERE user_id = ? AND id = ?`
            )
            .bind(cleanName, updatedAt, userId, data.categoryId)
            .run();
    });

export const moveCategoryRelativeToCategory = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator(
        (data: { categoryId: string; targetCategoryId: string; placement: "before" | "after" }) => data
    )
    .handler(async ({ context, data: input }) => {
        const userId = context.user.id;
        if (input.categoryId === input.targetCategoryId) {
            return { moved: false };
        }

        const category = await getOwnedCategory(userId, input.categoryId);
        assertOwned(category, "Category");
        const targetCategory = await getOwnedCategory(userId, input.targetCategoryId);
        assertOwned(targetCategory, "Target category");

        const db = getDb();
        const categories = await all<CategoryRow>(
            db
                .prepare(
                    `SELECT id, name, sort_order, created_at, is_public
         FROM categories
         WHERE user_id = ?
         ORDER BY sort_order ASC, name ASC`
                )
                .bind(userId)
        );
        const currentCategoryIds = categories.map((candidate) => candidate.id);
        const originalCategoryIndex = currentCategoryIds.indexOf(category.id);
        const targetCategoryIndex = currentCategoryIds.indexOf(targetCategory.id);
        if (
            originalCategoryIndex >= 0 &&
            targetCategoryIndex >= 0 &&
            (
                (input.placement === "before" && targetCategoryIndex === originalCategoryIndex + 1) ||
                (input.placement === "after" && targetCategoryIndex === originalCategoryIndex - 1)
            )
        ) {
            return { moved: false };
        }

        const orderedCategoryIds = currentCategoryIds.filter((categoryId) => categoryId !== category.id);
        const targetIndex = orderedCategoryIds.indexOf(targetCategory.id);
        if (targetIndex === -1) {
            throw new Error("Target category not found");
        }

        const insertionIndex = input.placement === "after" ? targetIndex + 1 : targetIndex;
        orderedCategoryIds.splice(insertionIndex, 0, category.id);
        await db.batch(rewriteUserCategoryOrderStatements(db, userId, orderedCategoryIds, now()));

        return { moved: true };
    });

export const deleteCategory = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { categoryId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { categoryId } = data;
        const category = await getOwnedCategory(userId, categoryId);
        assertOwned(category, "Category");
        await assertNoActiveBinarySession(userId);

        const db = getDb();
        const imageRows = await all<{ image_key: string | null }>(
            db
                .prepare(
                    `SELECT image_key
         FROM entries
         WHERE user_id = ? AND category_id = ? AND image_key IS NOT NULL
         UNION ALL
         SELECT image_key
         FROM entry_queue
         WHERE user_id = ? AND category_id = ? AND image_key IS NOT NULL`
                )
                .bind(userId, categoryId, userId, categoryId)
        );
        const imageKeys = Array.from(new Set(
            imageRows
                .map((row) => row.image_key)
                .filter((imageKey): imageKey is string => hasStoredImage(imageKey))
        ));

        await db.batch([
            db
                .prepare(`DELETE FROM ranking_sessions WHERE user_id = ? AND category_id = ?`)
                .bind(userId, categoryId),
            db
                .prepare(
                    `DELETE FROM repair_sessions
                     WHERE user_id = ?
                       AND (scope_category_id = ? OR active_category_id = ?)`
                )
                .bind(userId, categoryId, categoryId),
            db
                .prepare(`DELETE FROM entry_queue WHERE user_id = ? AND category_id = ?`)
                .bind(userId, categoryId),
            db
                .prepare(`DELETE FROM entries WHERE user_id = ? AND category_id = ?`)
                .bind(userId, categoryId),
            db
                .prepare(`DELETE FROM categories WHERE user_id = ? AND id = ?`)
                .bind(userId, categoryId),
            db
                .prepare(
                    `UPDATE categories
         SET sort_order = sort_order - 1, updated_at = ?
         WHERE user_id = ? AND sort_order > ?`
                )
                .bind(now(), userId, category.sort_order)
        ]);

        await Promise.all(imageKeys.map((imageKey) => env.IMAGES.delete(imageKey).catch(() => undefined)));
    });

export const updateCategoryVisibility = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { categoryId: string; isPublic: boolean }) => data)
    .handler(async ({ context, data: input }) => {
        const userId = context.user.id;
        const category = await getOwnedCategory(userId, input.categoryId);
        assertOwned(category, "Category");

        await getDb()
            .prepare(
                `UPDATE categories
       SET is_public = ?, updated_at = ?
       WHERE user_id = ? AND id = ?`
            )
            .bind(input.isPublic ? 1 : 0, now(), userId, input.categoryId)
            .run();

        return { categoryId: input.categoryId, isPublic: input.isPublic };
    });

function normalizeCategoryIds(value: unknown) {
    if (!Array.isArray(value)) {
        throw new Error("Categories are required");
    }

    const categoryIds = Array.from(new Set(
        value
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter(Boolean)
    ));
    if (categoryIds.length === 0) {
        throw new Error("Choose at least one category");
    }
    return categoryIds;
}

async function assertOwnedCategoryIds(userId: string, categoryIds: string[]) {
    const result = await first<{ category_count: number }>(
        getDb()
            .prepare(
                `SELECT COUNT(*) AS category_count
                 FROM categories
                 WHERE user_id = ?
                   AND id IN (SELECT value FROM json_each(?))`
            )
            .bind(userId, JSON.stringify(categoryIds))
    );
    if ((result?.category_count ?? 0) !== categoryIds.length) {
        throw new Error("One or more categories could not be found");
    }
}

export const updateCategoriesVisibility = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { categoryIds: string[]; isPublic: boolean }) => data)
    .handler(async ({ context, data: input }) => {
        const userId = context.user.id;
        const categoryIds = normalizeCategoryIds(input.categoryIds);
        await assertOwnedCategoryIds(userId, categoryIds);

        await getDb()
            .prepare(
                `UPDATE categories
                 SET is_public = ?, updated_at = ?
                 WHERE user_id = ?
                   AND id IN (SELECT value FROM json_each(?))`
            )
            .bind(input.isPublic ? 1 : 0, now(), userId, JSON.stringify(categoryIds))
            .run();

        return { updatedCount: categoryIds.length, isPublic: input.isPublic };
    });

export const moveCategoriesToQueue = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { categoryIds: string[] }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const categoryIds = normalizeCategoryIds(data.categoryIds);
        await assertNoActiveBinarySession(userId);
        await assertOwnedCategoryIds(userId, categoryIds);

        const categoryIdsJson = JSON.stringify(categoryIds);
        const result = await first<{ entry_count: number }>(
            getDb()
                .prepare(
                    `SELECT COUNT(*) AS entry_count
                     FROM entries
                     WHERE user_id = ?
                       AND status = 'active'
                       AND category_id IN (SELECT value FROM json_each(?))`
                )
                .bind(userId, categoryIdsJson)
        );
        const movedCount = result?.entry_count ?? 0;
        if (movedCount === 0) {
            throw new Error("The selected categories have no ranked entries to move");
        }

        const updatedAt = now();
        const db = getDb();
        await db.batch([
            db
                .prepare(
                    `UPDATE entry_queue
                     SET image_key = COALESCE(
                           image_key,
                           (
                             SELECT entries.image_key
                             FROM entries
                             WHERE entries.user_id = entry_queue.user_id
                               AND entries.category_id = entry_queue.category_id
                               AND entries.name = entry_queue.name
                               AND entries.status = 'active'
                           )
                         ),
                         updated_at = ?
                     WHERE user_id = ?
                       AND status = 'queued'
                       AND category_id IN (SELECT value FROM json_each(?))
                       AND EXISTS (
                         SELECT 1
                         FROM entries
                         WHERE entries.user_id = entry_queue.user_id
                           AND entries.category_id = entry_queue.category_id
                           AND entries.name = entry_queue.name
                           AND entries.status = 'active'
                       )`
                )
                .bind(updatedAt, userId, categoryIdsJson),
            db
                .prepare(
                    `INSERT OR IGNORE INTO entry_queue (
                       id, user_id, category_id, name, status,
                       created_at, updated_at, image_key
                     )
                     SELECT 'queue_' || lower(hex(randomblob(16))), user_id, category_id,
                            name, 'queued', created_at, ?, image_key
                     FROM entries
                     WHERE user_id = ?
                       AND status = 'active'
                       AND category_id IN (SELECT value FROM json_each(?))`
                )
                .bind(updatedAt, userId, categoryIdsJson),
            db
                .prepare(
                    `UPDATE entries
                     SET status = 'deleted', image_key = NULL, updated_at = ?
                     WHERE user_id = ?
                       AND status = 'active'
                       AND category_id IN (SELECT value FROM json_each(?))`
                )
                .bind(updatedAt, userId, categoryIdsJson)
        ]);

        return { movedCount, categoryCount: categoryIds.length };
    });
