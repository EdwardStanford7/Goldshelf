import { createServerFn } from "@tanstack/react-start";
import { orderEntries } from "@/lib/ranking";
import { env } from "cloudflare:workers";
import { NO_IMAGE_KEY, hasStoredImage } from "@/lib/images";
import { assertOwned, first, getDb, now } from "@/server/lib/db";
import { MAX_ENTRY_NAME_LENGTH, normalizeRequiredText } from "@/server/lib/validation";
import { authMiddleware } from "@/server/middleware/auth";
import { getOwnedCategory } from "./stores/categoryStore";
import {
    getActiveEntryCount,
    getOwnedActiveEntry,
    getOwnedEntry,
    getOwnedEntryWithStatus,
    listActiveEntries,
    rewriteCategoryOrderStatements
} from "./stores/entryStore";
import {
    assertNoActiveBinarySession,
    prepareBinarySession
} from "./engine/rankingSessions";
import { assertEntryNameAvailable, createEntryWithBinaryRankingForUser } from "./engine/entryCreation";


export const createEntryWithBinaryRanking = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { categoryId: string; name: string; createdAt?: number | null }) => data)
    .handler(async ({ context, data }) =>
        createEntryWithBinaryRankingForUser(context.user.id, data));

export const markImageUnavailable = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { targetKind: "entry" | "queue"; targetId: string }) => data)
    .handler(async ({ context, data: input }) => {
        const userId = context.user.id;
        const updatedAt = now();
        const db = getDb();

        if (input.targetKind === "entry") {
            const entry = await first<{ id: string; image_key: string | null }>(
                db
                    .prepare(
                        `SELECT id, image_key
             FROM entries
             WHERE id = ? AND user_id = ? AND status != 'deleted'`
                    )
                    .bind(input.targetId, userId)
            );
            assertOwned(entry, "Entry");

            await db
                .prepare(
                    `UPDATE entries
             SET image_key = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND status != 'deleted'`
                )
                .bind(NO_IMAGE_KEY, updatedAt, entry.id, userId)
                .run();

            if (hasStoredImage(entry.image_key)) {
                await env.IMAGES.delete(entry.image_key).catch(() => undefined);
            }

            return { imageKey: NO_IMAGE_KEY };
        }

        const queuedEntry = await first<{ id: string; image_key: string | null }>(
            db
                .prepare(
                    `SELECT id, image_key
             FROM entry_queue
             WHERE id = ? AND user_id = ? AND status = 'queued'`
                )
                .bind(input.targetId, userId)
        );
        assertOwned(queuedEntry, "Queued entry");

        await db
            .prepare(
                `UPDATE entry_queue
           SET image_key = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'queued'`
            )
            .bind(NO_IMAGE_KEY, updatedAt, queuedEntry.id, userId)
            .run();

        if (hasStoredImage(queuedEntry.image_key)) {
            await env.IMAGES.delete(queuedEntry.image_key).catch(() => undefined);
        }

        return { imageKey: NO_IMAGE_KEY };
    });

export const startRerankEntry = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { entryId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { entryId } = data;
        const db = getDb();
        await assertNoActiveBinarySession(userId);
        const entry = await getOwnedActiveEntry(userId, entryId);
        assertOwned(entry, "Entry");

        const activeCount = await getActiveEntryCount(userId, entry.categoryId);
        if (activeCount <= 1) {
            return { kind: "completed" as const, entryId, sessionId: null };
        }

        const updatedAt = now();
        const session = await prepareBinarySession(db, {
            userId,
            categoryId: entry.categoryId,
            subjectEntryId: entryId,
            source: "rerank_entry",
            opponentCount: activeCount - 1,
            excludedEntryId: entryId,
            initialRankPosition: entry.rankPosition,
            createdAt: updatedAt
        });
        await db.batch([
            db
                .prepare(
                    `UPDATE entries
             SET rank_position = rank_position - 1, updated_at = ?
             WHERE user_id = ? AND category_id = ? AND status = 'active' AND rank_position > ?`
                )
                .bind(updatedAt, userId, entry.categoryId, entry.rankPosition),
            db
                .prepare(
                    `UPDATE entries
             SET status = 'ranking', rank_position = ?, updated_at = ?
             WHERE user_id = ? AND id = ?`
                )
                .bind(activeCount - 1, updatedAt, userId, entryId),
            session.statement
        ]);

        return { kind: "session" as const, entryId, sessionId: session.sessionId };
    });

export const moveEntryRelativeToEntry = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { entryId: string; targetEntryId: string; placement: "before" | "after" }) => data)
    .handler(async ({ context, data: input }) => {
        const userId = context.user.id;
        await assertNoActiveBinarySession(userId);
        if (input.entryId === input.targetEntryId) {
            return { moved: false };
        }

        const entry = await getOwnedActiveEntry(userId, input.entryId);
        assertOwned(entry, "Entry");
        const targetEntry = await getOwnedActiveEntry(userId, input.targetEntryId);
        assertOwned(targetEntry, "Target entry");

        if (entry.categoryId !== targetEntry.categoryId) {
            throw new Error("Entries must be in the same category");
        }

        const orderedEntryIds = orderEntries(await listActiveEntries(userId, entry.categoryId))
            .map((candidate) => candidate.id)
            .filter((entryId) => entryId !== entry.id);
        const targetIndex = orderedEntryIds.indexOf(targetEntry.id);
        if (targetIndex === -1) {
            throw new Error("Target entry not found");
        }

        const insertionIndex = input.placement === "after" ? targetIndex + 1 : targetIndex;
        orderedEntryIds.splice(insertionIndex, 0, entry.id);
        const db = getDb();
        await db.batch(rewriteCategoryOrderStatements(db, userId, entry.categoryId, orderedEntryIds, now()));

        return { moved: true };
    });

export const renameEntry = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { entryId: string; name: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { entryId, name } = data;
        const entry = await getOwnedEntry(userId, entryId);
        assertOwned(entry, "Entry");

        const cleanName = normalizeRequiredText(name, "Entry name", MAX_ENTRY_NAME_LENGTH);

        const updatedAt = now();
        await getDb()
            .prepare(
                `UPDATE entries
           SET name = ?, updated_at = ?
           WHERE user_id = ? AND id = ? AND status != 'deleted'`
            )
            .bind(cleanName, updatedAt, userId, entryId)
            .run();
    });

export const deleteEntry = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { entryId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { entryId } = data;
        await assertNoActiveBinarySession(userId);
        const entry = await getOwnedActiveEntry(userId, entryId);
        assertOwned(entry, "Entry");

        const updatedAt = now();
        await getDb()
            .prepare(
                `UPDATE entries
           SET status = 'deleted', updated_at = ?
           WHERE user_id = ? AND id = ?`
            )
            .bind(updatedAt, userId, entryId)
            .run();
        await getDb()
            .prepare(
                `UPDATE entries
           SET rank_position = rank_position - 1, updated_at = ?
           WHERE user_id = ? AND category_id = ? AND status = 'active' AND rank_position > ?`
            )
            .bind(updatedAt, userId, entry.categoryId, entry.rankPosition)
            .run();
    });

export const restoreEntry = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { entryId: string }) => data)
    .handler(async ({ context, data }) => {
        const userId = context.user.id;
        const { entryId } = data;
        await assertNoActiveBinarySession(userId);
        const entry = await getOwnedEntryWithStatus(userId, entryId);
        assertOwned(entry, "Entry");

        if (entry.status === "active") {
            return;
        }

        if (entry.status !== "deleted") {
            throw new Error("Entry cannot be restored");
        }

        const category = await getOwnedCategory(userId, entry.category_id);
        assertOwned(category, "Category");
        await assertEntryNameAvailable(userId, entry.category_id, entry.name);

        const activeEntryCount = await getActiveEntryCount(userId, entry.category_id);
        const restoreRankPosition = Math.max(0, Math.min(entry.rank_position, activeEntryCount));
        const updatedAt = now();
        const db = getDb();

        await db.batch([
            db
                .prepare(
                    `UPDATE entries
           SET rank_position = rank_position + 1, updated_at = ?
           WHERE user_id = ? AND category_id = ? AND status = 'active' AND rank_position >= ?`
                )
                .bind(updatedAt, userId, entry.category_id, restoreRankPosition),
            db
                .prepare(
                    `UPDATE entries
           SET status = 'active', rank_position = ?, updated_at = ?
           WHERE user_id = ? AND id = ? AND status = 'deleted'`
                )
                .bind(restoreRankPosition, updatedAt, userId, entryId)
        ]);
    });

export const switchEntryCategory = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: { entryId: string; targetCategoryId: string }) => data)
    .handler(async ({ context, data: input }) => {
        const userId = context.user.id;
        const db = getDb();
        await assertNoActiveBinarySession(userId);
        const entry = await getOwnedActiveEntry(userId, input.entryId);
        assertOwned(entry, "Entry");
        const targetCategory = await getOwnedCategory(userId, input.targetCategoryId);
        assertOwned(targetCategory, "Target category");

        if (entry.categoryId === input.targetCategoryId) {
            return { kind: "completed" as const, entryId: entry.id, sessionId: null };
        }

        const duplicate = await first<{ id: string }>(
            getDb()
                .prepare(
                    `SELECT id
             FROM entries
             WHERE user_id = ? AND category_id = ? AND name = ? AND status != 'deleted' AND id != ?`
                )
                .bind(userId, input.targetCategoryId, entry.name, entry.id)
        );
        if (duplicate) {
            throw new Error("That entry already exists in the target category");
        }

        const targetCount = await getActiveEntryCount(userId, input.targetCategoryId);
        const updatedAt = now();
        const statements: D1PreparedStatement[] = [
            db
                .prepare(
                    `UPDATE entries
             SET rank_position = rank_position - 1, updated_at = ?
             WHERE user_id = ? AND category_id = ? AND status = 'active' AND rank_position > ?`
                )
                .bind(updatedAt, userId, entry.categoryId, entry.rankPosition),
            db
                .prepare(
                    `UPDATE entries
             SET category_id = ?, rank_position = ?, status = ?, updated_at = ?
             WHERE user_id = ? AND id = ?`
                )
                .bind(
                    input.targetCategoryId,
                    targetCount,
                    targetCount === 0 ? "active" : "ranking",
                    updatedAt,
                    userId,
                    entry.id
                )
        ];

        if (targetCount === 0) {
            await db.batch(statements);
            return { kind: "completed" as const, entryId: entry.id, sessionId: null };
        }

        const session = await prepareBinarySession(db, {
            userId,
            categoryId: input.targetCategoryId,
            subjectEntryId: entry.id,
            source: "switch_category",
            fromCategoryId: entry.categoryId,
            opponentCount: targetCount,
            createdAt: updatedAt
        });
        statements.push(session.statement);
        await db.batch(statements);

        return { kind: "session" as const, entryId: entry.id, sessionId: session.sessionId };
    });
