import { first, getDb } from "@/server/lib/db";

export interface CategoryRow {
    id: string;
    name: string;
    sort_order: number;
    created_at: number;
    is_public?: number;
}

export async function getOwnedCategory(userId: string, categoryId: string) {
    return first<CategoryRow>(
        getDb()
            .prepare(
                `SELECT id, name, sort_order, created_at, is_public
         FROM categories
         WHERE user_id = ? AND id = ?`
            )
            .bind(userId, categoryId)
    );
}

export function rewriteUserCategoryOrderStatements(
    db: D1Database,
    userId: string,
    orderedCategoryIds: string[],
    updatedAt: number
) {
    return [
        db
            .prepare(
                `WITH requested_order AS (
                   SELECT value AS id, CAST(key AS INTEGER) AS sort_order
                   FROM json_each(?)
                 )
                 UPDATE categories
                 SET sort_order = (
                       SELECT requested_order.sort_order
                       FROM requested_order
                       WHERE requested_order.id = categories.id
                     ),
                     updated_at = ?
                 WHERE user_id = ?
                   AND id IN (SELECT id FROM requested_order)
                   AND sort_order != (
                     SELECT requested_order.sort_order
                     FROM requested_order
                     WHERE requested_order.id = categories.id
                   )`
            )
            .bind(JSON.stringify(orderedCategoryIds), updatedAt, userId)
    ];
}
