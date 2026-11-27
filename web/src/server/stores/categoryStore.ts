import { first, getDb } from "@/server/lib/db";

export interface CategoryRow {
    id: string;
    name: string;
    sort_order: number;
    created_at: number;
    is_public?: number;
    visibility: "private" | "followers" | "public";
}

export async function getOwnedCategory(userId: string, categoryId: string) {
    return first<CategoryRow>(
        getDb()
            .prepare(
                `SELECT id, name, sort_order, created_at, is_public, visibility
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
                `WITH requested_order AS MATERIALIZED (
                   SELECT value AS id, CAST(key AS INTEGER) AS sort_order
                   FROM json_each(?)
                 )
                 UPDATE categories AS category
                 SET sort_order = requested_order.sort_order,
                     updated_at = ?
                 FROM requested_order
                 WHERE category.user_id = ?
                   AND category.id = requested_order.id
                   AND category.sort_order != requested_order.sort_order`
            )
            .bind(JSON.stringify(orderedCategoryIds), updatedAt, userId)
    ];
}
