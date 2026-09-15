import { createServerFn } from "@tanstack/react-start";
import { first, getDb, newId, now } from "@/server/lib/db";
import { authMiddleware } from "@/server/middleware/auth";

const SAMPLE_CATEGORY_NAME = "Example Ranking";
const SAMPLE_ENTRIES = [
    "Example Item A",
    "Example Item B",
    "Example Item C"
] as const;

export const createOnboardingSampleRanking = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .handler(async ({ context }) => {
        const userId = context.user.id;
        const db = getDb();
        const existing = await first<{ count: number }>(
            db
                .prepare(`SELECT COUNT(*) AS count FROM categories WHERE user_id = ?`)
                .bind(userId)
        );

        if ((existing?.count ?? 0) > 0) {
            return { created: false };
        }

        const createdAt = now();
        const categoryId = newId("cat");
        const statements: D1PreparedStatement[] = [
            db
                .prepare(
                    `INSERT INTO categories (id, user_id, name, sort_order, created_at, updated_at, is_public)
             VALUES (?, ?, ?, 0, ?, ?, 0)`
                )
                .bind(categoryId, userId, SAMPLE_CATEGORY_NAME, createdAt, createdAt)
        ];

        SAMPLE_ENTRIES.forEach((name, rankPosition) => {
            statements.push(
                db
                    .prepare(
                        `INSERT INTO entries (
                 id, user_id, category_id, name, rank_position, status, image_key,
                 created_at, updated_at
               )
               VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`
                    )
                    .bind(
                        newId("entry"),
                        userId,
                        categoryId,
                        name,
                        rankPosition,
                        createdAt,
                        createdAt
                    )
            );
        });

        await db.batch(statements);
        return { created: true };
    });
