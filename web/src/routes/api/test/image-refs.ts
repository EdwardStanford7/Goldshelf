import { createFileRoute } from "@tanstack/react-router";
import { all, getDb } from "@/server/lib/db";
import { testModeGate } from "@/server/lib/testMode";

interface ImageReferenceRow {
    kind: "entry" | "queue";
    name: string;
    image_key: string | null;
}

interface ImageAssetRow {
    object_key: string;
    unreferenced_at: number | null;
}

export const Route = createFileRoute("/api/test/image-refs")({
    server: {
        handlers: {
            GET: async ({ request }: { request: Request }) => {
                const gated = testModeGate();
                if (gated) {
                    return gated;
                }

                const email = new URL(request.url).searchParams.get("email")?.trim() ?? "";
                if (!email) {
                    return Response.json({ message: "email is required" }, { status: 400 });
                }

                const rows = await all<ImageReferenceRow>(
                    getDb()
                        .prepare(
                            `SELECT 'entry' AS kind, entries.name, entries.image_key
                             FROM entries
                             INNER JOIN "user" ON "user".id = entries.user_id
                             WHERE "user".email = ? AND entries.status != 'deleted'
                             UNION ALL
                             SELECT 'queue' AS kind, entry_queue.name, entry_queue.image_key
                             FROM entry_queue
                             INNER JOIN "user" ON "user".id = entry_queue.user_id
                             WHERE "user".email = ? AND entry_queue.status = 'queued'`
                        )
                        .bind(email, email)
                );

                const assets = await all<ImageAssetRow>(
                    getDb()
                        .prepare(
                            `SELECT object_key, unreferenced_at
                             FROM image_assets
                             ORDER BY object_key ASC`
                        )
                );

                return Response.json({ assets, rows });
            }
        }
    }
});
