import type { Entry } from "@/lib/types";
import { all, first, getDb } from "@/server/lib/db";

export interface EntryRow {
    id: string;
    category_id: string;
    name: string;
    rank_position: number;
    image_key: string | null;
    created_at: number;
}

export interface EntryStatusRow extends EntryRow {
    status: string;
}

export async function getOwnedEntry(userId: string, entryId: string) {
    const row = await first<EntryRow>(
        getDb()
            .prepare(
                `SELECT id, category_id, name, rank_position, image_key, created_at
         FROM entries
         WHERE user_id = ? AND id = ? AND status != 'deleted'`
            )
            .bind(userId, entryId)
    );

    return row ? mapEntry(row) : null;
}

export async function getOwnedEntryWithStatus(userId: string, entryId: string) {
    return first<EntryStatusRow>(
        getDb()
            .prepare(
                `SELECT id, category_id, name, rank_position, image_key, created_at, status
         FROM entries
         WHERE user_id = ? AND id = ?`
            )
            .bind(userId, entryId)
    );
}

export async function getOwnedActiveEntry(userId: string, entryId: string) {
    const row = await first<EntryRow>(
        getDb()
            .prepare(
                `SELECT id, category_id, name, rank_position, image_key, created_at
         FROM entries
         WHERE user_id = ? AND id = ? AND status = 'active'`
            )
            .bind(userId, entryId)
    );

    return row ? mapEntry(row) : null;
}

export async function listActiveEntries(userId: string, categoryId: string, excludedEntryId?: string) {
    const rows = await all<EntryRow>(
        getDb()
            .prepare(
                `SELECT id, category_id, name, rank_position, image_key, created_at
         FROM entries
         WHERE user_id = ? AND category_id = ? AND status = 'active'
           AND (? IS NULL OR id != ?)
         ORDER BY rank_position ASC`
            )
            .bind(userId, categoryId, excludedEntryId ?? null, excludedEntryId ?? null)
    );

    return rows.map(mapEntry);
}

export async function getActiveEntryCount(userId: string, categoryId: string) {
    const count = await first<{ count: number }>(
        getDb()
            .prepare(
                `SELECT COUNT(*) AS count
         FROM entries
         WHERE user_id = ? AND category_id = ? AND status = 'active'`
            )
            .bind(userId, categoryId)
    );

    return count?.count ?? 0;
}

export async function getNextActiveRankPosition(userId: string, categoryId: string) {
    const row = await first<{ next_rank: number }>(
        getDb()
            .prepare(
                `SELECT COALESCE(MAX(rank_position) + 1, 0) AS next_rank
         FROM entries
         WHERE user_id = ? AND category_id = ? AND status = 'active'`
            )
            .bind(userId, categoryId)
    );

    return row?.next_rank ?? 0;
}

export function rewriteCategoryOrderStatements(
    db: D1Database,
    userId: string,
    categoryId: string,
    orderedEntryIds: string[],
    updatedAt: number
) {
    // Keep a complete rank rewrite atomic without emitting one D1 statement per
    // entry. JSON is one bind parameter, so this remains safe for large lists.
    return [
        db
            .prepare(
                `WITH requested_order AS (
                   SELECT value AS id, CAST(key AS INTEGER) AS rank_position
                   FROM json_each(?)
                 )
                 UPDATE entries
                 SET status = 'active',
                     rank_position = (
                       SELECT requested_order.rank_position
                       FROM requested_order
                       WHERE requested_order.id = entries.id
                     ),
                     updated_at = ?
                 WHERE user_id = ?
                   AND category_id = ?
                   AND id IN (SELECT id FROM requested_order)
                   AND (
                     status != 'active'
                     OR rank_position != (
                       SELECT requested_order.rank_position
                       FROM requested_order
                       WHERE requested_order.id = entries.id
                     )
                   )`
            )
            .bind(JSON.stringify(orderedEntryIds), updatedAt, userId, categoryId)
    ];
}

export function placeRankedEntryStatements(
    db: D1Database,
    userId: string,
    entryId: string,
    categoryId: string,
    rankPosition: number,
    updatedAt: number
) {
    return [
        db
            .prepare(
                `UPDATE entries
       SET rank_position = rank_position + 1, updated_at = ?
       WHERE user_id = ? AND category_id = ? AND status = 'active' AND rank_position >= ?`
            )
            .bind(updatedAt, userId, categoryId, rankPosition),
        db
            .prepare(
                `UPDATE entries
       SET status = 'active',
           rank_position = ?,
           updated_at = ?
       WHERE user_id = ? AND id = ?`
            )
            .bind(rankPosition, updatedAt, userId, entryId)
    ];
}

export function mapEntry(row: EntryRow): Entry {
    return {
        id: row.id,
        categoryId: row.category_id,
        name: row.name,
        rankPosition: row.rank_position,
        imageKey: row.image_key,
        createdAt: row.created_at
    };
}
