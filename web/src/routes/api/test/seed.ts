import { createFileRoute } from "@tanstack/react-router";
import { NO_IMAGE_KEY } from "@/lib/images";
import { auth } from "@/server/lib/auth";
import { getDb, newId, now } from "@/server/lib/db";
import { testModeGate } from "@/server/lib/testMode";

interface SeedEntry {
    name: string;
    imageKey?: string | null;
}

interface SeedCategory {
    name: string;
    entries?: Array<SeedEntry | string>;
}

interface SeedQueueSettings {
    enabled?: boolean;
    promptForMissingImages?: boolean;
    randomizeReadyEntries?: boolean;
}

interface SeedQueuedEntry {
    categoryName: string;
    name: string;
    imageKey?: string | null;
    createdAt?: number;
}

interface SeedUser {
    email: string;
    password: string;
    name: string;
    role?: string;
    direct?: boolean;
    queueSettings?: SeedQueueSettings;
    categories?: SeedCategory[];
    queuedEntries?: SeedQueuedEntry[];
}

interface SeedBody {
    users: SeedUser[];
}

export const Route = createFileRoute("/api/test/seed")({
    server: {
        handlers: {
            POST: async ({ request }: { request: Request }) => {
                const gated = testModeGate();
                if (gated) {
                    return gated;
                }

                const body = (await request.json()) as SeedBody;
                if (!Array.isArray(body.users) || body.users.length === 0) {
                    return Response.json({ message: "users are required" }, { status: 400 });
                }

                const db = getDb();
                const createdUsers: Array<{ id: string; email: string }> = [];

                for (const seedUser of body.users) {
                    const timestamp = now();
                    let userId: string;
                    if (seedUser.direct) {
                        userId = newId("user");
                        await db
                            .prepare(
                                `INSERT INTO "user" (
                     id, name, email, emailVerified, image, createdAt, updatedAt,
                     role, banned, banReason, banExpires
                   )
                   VALUES (?, ?, ?, 0, NULL, ?, ?, ?, 0, NULL, NULL)`
                            )
                            .bind(userId, seedUser.name, seedUser.email, timestamp, timestamp, seedUser.role ?? "user")
                            .run();
                    } else {
                        const signUp = await auth.api.signUpEmail({
                            body: {
                                email: seedUser.email,
                                password: seedUser.password,
                                name: seedUser.name
                            }
                        });
                        userId = signUp.user.id;
                        await db.prepare(`DELETE FROM session WHERE userId = ?`).bind(userId).run();
                    }

                    createdUsers.push({ id: userId, email: seedUser.email });

                    if (seedUser.role && !seedUser.direct) {
                        await db
                            .prepare(`UPDATE "user" SET role = ?, updatedAt = ? WHERE id = ?`)
                            .bind(seedUser.role, timestamp, userId)
                            .run();
                    }

                    const queueSettings = seedUser.queueSettings ?? {};
                    await db
                        .prepare(
                            `INSERT INTO queue_settings (
                 user_id, enabled, prompt_missing_images, randomize_ready_entries, created_at, updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET
                 enabled = excluded.enabled,
                 prompt_missing_images = excluded.prompt_missing_images,
                 randomize_ready_entries = excluded.randomize_ready_entries,
                 updated_at = excluded.updated_at`
                        )
                        .bind(
                            userId,
                            queueSettings.enabled ? 1 : 0,
                            queueSettings.promptForMissingImages ? 1 : 0,
                            queueSettings.randomizeReadyEntries ? 1 : 0,
                            timestamp,
                            timestamp
                        )
                        .run();

                    const categories = seedUser.categories ?? [];
                    const categoryIdsByName = new Map<string, string>();
                    for (const [categoryIndex, category] of categories.entries()) {
                        const categoryId = newId("cat");
                        categoryIdsByName.set(category.name, categoryId);
                        await db
                            .prepare(
                                `INSERT INTO categories (id, user_id, name, sort_order, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
                            )
                            .bind(categoryId, userId, category.name, categoryIndex, timestamp, timestamp)
                            .run();

                        const entries = (category.entries ?? []).map((entry) =>
                            typeof entry === "string" ? { name: entry } : entry
                        );
                        for (const [entryIndex, entry] of entries.entries()) {
                            await db
                                .prepare(
                                    `INSERT INTO entries (
                     id, user_id, category_id, name, rank_position, status, image_key,
                     created_at, updated_at
                   )
                   VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
                                )
                                .bind(
                                    newId("entry"),
                                    userId,
                                    categoryId,
                                    entry.name,
                                    entryIndex,
                                    entry.imageKey === undefined ? NO_IMAGE_KEY : entry.imageKey,
                                    timestamp,
                                    timestamp
                                )
                                .run();
                        }
                    }

                    const queuedEntries = seedUser.queuedEntries ?? [];
                    for (const [queueIndex, queuedEntry] of queuedEntries.entries()) {
                        const categoryId = categoryIdsByName.get(queuedEntry.categoryName);
                        if (!categoryId) {
                            return Response.json({
                                message: `queued category not found: ${queuedEntry.categoryName}`
                            }, { status: 400 });
                        }

                        const queuedCreatedAt = queuedEntry.createdAt ?? timestamp + queueIndex;
                        await db
                            .prepare(
                                `INSERT INTO entry_queue (
                     id, user_id, category_id, name, image_key,
                     status, created_at, updated_at
                   )
                   VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
                            )
                            .bind(
                                newId("queue"),
                                userId,
                                categoryId,
                                queuedEntry.name,
                                queuedEntry.imageKey ?? null,
                                queuedCreatedAt,
                                timestamp
                            )
                            .run();
                    }
                }

                return Response.json({ ok: true, users: createdUsers });
            }
        }
    }
});
