import { createServerFn } from "@tanstack/react-start";
import type { ParsedImport } from "@/lib/types";
import { all, getDb, newId, now, runBatches } from "@/server/lib/db";
import { MAX_CATEGORY_NAME_LENGTH, MAX_ENTRY_NAME_LENGTH, isWithinTextLimit } from "@/server/lib/validation";
import { authMiddleware } from "@/server/middleware/auth";
import { type CategoryRow } from "./stores/categoryStore";
import { assertNoActiveBinarySession } from "./engine/rankingSessions";

interface ExistingEntryRow {
    category_id: string;
    name: string;
    status: string;
}

export const importLegacyEntries = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .inputValidator((data: ParsedImport) => data)
    .handler(async ({ context, data: parsedImport }) => {
        const userId = context.user.id;
        const db = getDb();
        await assertNoActiveBinarySession(userId);
        const createdAt = now();
        const rankedImportEntries = parsedImport.entries ?? [];
        const queuedImportEntries = parsedImport.queuedEntries ?? [];
        const categoriesByName = new Map<string, string>();
        const importedByCategory = new Map<string, typeof rankedImportEntries>();
        const queuedByCategory = new Map<string, typeof queuedImportEntries>();
        const existingCategories = await all<CategoryRow>(
            db
                .prepare(
                    `SELECT id, name, sort_order, created_at
             FROM categories
             WHERE user_id = ?`
                )
                .bind(userId)
        );

        for (const category of existingCategories) {
            categoriesByName.set(category.name, category.id);
        }

        for (const entry of rankedImportEntries) {
            const categoryName = entry.categoryName.trim();
            const name = entry.name.trim();
            if (!categoryName || !name) {
                continue;
            }
            if (!isWithinTextLimit(categoryName, MAX_CATEGORY_NAME_LENGTH) || !isWithinTextLimit(name, MAX_ENTRY_NAME_LENGTH)) {
                continue;
            }

            const bucket = importedByCategory.get(categoryName) ?? [];
            bucket.push({ ...entry, categoryName, name });
            importedByCategory.set(categoryName, bucket);
        }

        for (const entry of queuedImportEntries) {
            const categoryName = entry.categoryName.trim();
            const name = entry.name.trim();
            if (!categoryName || !name) {
                continue;
            }
            if (!isWithinTextLimit(categoryName, MAX_CATEGORY_NAME_LENGTH) || !isWithinTextLimit(name, MAX_ENTRY_NAME_LENGTH)) {
                continue;
            }

            const bucket = queuedByCategory.get(categoryName) ?? [];
            bucket.push({ ...entry, categoryName, name });
            queuedByCategory.set(categoryName, bucket);
        }

        let sortOrder = Math.max(-1, ...existingCategories.map((category) => category.sort_order)) + 1;
        const categoryInsertStatements: D1PreparedStatement[] = [];

        for (const categoryName of new Set([...importedByCategory.keys(), ...queuedByCategory.keys()])) {
            if (!categoriesByName.has(categoryName)) {
                const categoryId = newId("cat");
                categoriesByName.set(categoryName, categoryId);
                categoryInsertStatements.push(
                    db.prepare(
                        `INSERT INTO categories (id, user_id, name, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)`
                    )
                        .bind(categoryId, userId, categoryName, sortOrder, createdAt, createdAt)
                );
                sortOrder += 1;
            }
        }

        await runBatches(db, categoryInsertStatements);

        const existingEntries = await all<ExistingEntryRow>(
            db
                .prepare(
                    `SELECT category_id, name, status
             FROM entries
             WHERE user_id = ? AND status != 'deleted'`
                )
                .bind(userId)
        );
        const namesByCategory = new Map<string, Set<string>>();
        const activeCountsByCategory = new Map<string, number>();
        for (const entry of existingEntries) {
            const names = namesByCategory.get(entry.category_id) ?? new Set<string>();
            names.add(entry.name);
            namesByCategory.set(entry.category_id, names);

            if (entry.status === "active") {
                activeCountsByCategory.set(
                    entry.category_id,
                    (activeCountsByCategory.get(entry.category_id) ?? 0) + 1
                );
            }
        }

        const existingQueuedEntries = await all<{ category_id: string; name: string }>(
            db
                .prepare(
                    `SELECT category_id, name
             FROM entry_queue
             WHERE user_id = ? AND status = 'queued'`
                )
                .bind(userId)
        );
        for (const entry of existingQueuedEntries) {
            const names = namesByCategory.get(entry.category_id) ?? new Set<string>();
            names.add(entry.name);
            namesByCategory.set(entry.category_id, names);
        }

        const entryInsertStatements: D1PreparedStatement[] = [];
        const queueInsertStatements: D1PreparedStatement[] = [];
        let rankedImportedCount = 0;
        let rankedSkippedCount = 0;
        let queuedImportedCount = 0;
        let queuedSkippedCount = 0;
        let queuedInsertIndex = 0;

        for (const [categoryName, entries] of importedByCategory) {
            const categoryId = categoriesByName.get(categoryName);
            if (!categoryId) {
                continue;
            }

            entries.sort((left, right) => left.rankPosition - right.rankPosition);
            const knownNames = namesByCategory.get(categoryId) ?? new Set<string>();
            namesByCategory.set(categoryId, knownNames);
            let rankPosition = activeCountsByCategory.get(categoryId) ?? 0;
            const insertableEntries = entries.filter((entry) => {
                if (knownNames.has(entry.name)) {
                    rankedSkippedCount += 1;
                    return false;
                }

                knownNames.add(entry.name);
                return true;
            });
            for (const entry of insertableEntries) {
                const entryId = newId("entry");
                const entryCreatedAt = normalizeImportedTimestamp(entry.createdAt) ?? createdAt;
                entryInsertStatements.push(
                    db.prepare(
                        `INSERT OR IGNORE INTO entries (
                 id, user_id, category_id, name, rank_position, status, image_key,
                 created_at, updated_at
               )
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
                    )
                        .bind(
                            entryId,
                            userId,
                            categoryId,
                            entry.name,
                            rankPosition,
                            null,
                            entryCreatedAt,
                            createdAt
                        )
                );
                rankedImportedCount += 1;
                rankPosition += 1;
            }

            activeCountsByCategory.set(categoryId, rankPosition);
        }

        for (const [categoryName, entries] of queuedByCategory) {
            const categoryId = categoriesByName.get(categoryName);
            if (!categoryId) {
                continue;
            }

            const knownNames = namesByCategory.get(categoryId) ?? new Set<string>();
            namesByCategory.set(categoryId, knownNames);

            for (const entry of entries) {
                if (knownNames.has(entry.name)) {
                    queuedSkippedCount += 1;
                    continue;
                }

                knownNames.add(entry.name);
                const queueId = newId("queue");
                const rowCreatedAt = normalizeImportedTimestamp(entry.createdAt) ?? createdAt + queuedInsertIndex;
                queueInsertStatements.push(
                    db.prepare(
                        `INSERT OR IGNORE INTO entry_queue (
                 id, user_id, category_id, name, image_key,
                 status, created_at, updated_at
               )
               VALUES (?, ?, ?, ?, NULL, 'queued', ?, ?)`
                    )
                        .bind(
                            queueId,
                            userId,
                            categoryId,
                            entry.name,
                            rowCreatedAt,
                            createdAt
                        )
                );
                queuedImportedCount += 1;
                queuedInsertIndex += 1;
            }
        }

        await runBatches(db, [...entryInsertStatements, ...queueInsertStatements]);

        return {
            importedCount: rankedImportedCount + queuedImportedCount,
            skippedCount: rankedSkippedCount + queuedSkippedCount,
            rankedImportedCount,
            rankedSkippedCount,
            queuedImportedCount,
            queuedSkippedCount
        };
    });

function normalizeImportedTimestamp(value: number | null | undefined) {
    return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}
