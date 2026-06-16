import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { hasStoredImage } from "@/lib/images";
import { all, assertOwned, first, getDb, newId, now } from "@/server/lib/db";
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
        const cleanName = data.name.trim();
        if (!cleanName) {
            throw new Error("Category name is required");
        }

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

        const cleanName = data.name.trim();
        if (!cleanName) {
            throw new Error("Category name is required");
        }

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

        await Promise.all(imageKeys.map((imageKey) => env.IMAGES.delete(imageKey)));
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
