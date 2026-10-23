import { auth } from "@/server/lib/auth";
import { enforceApiRateLimit } from "@/server/lib/apiRateLimit";
import { first, getDb } from "@/server/lib/db";
import { searchImageCandidates } from "@/server/lib/imageSearch";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/image-search")({
    server: {
        handlers: {
            GET: async ({ request }: { request: Request }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return Response.json({ message: "Unauthorized" }, { status: 401 });
                }

                const rateLimitResponse = await enforceApiRateLimit({
                    scope: "image-search",
                    subject: session.user.id,
                    maxRequests: 6,
                    windowMs: 60_000
                });
                if (rateLimitResponse) {
                    return rateLimitResponse;
                }

                const url = new URL(request.url);
                const entryId = url.searchParams.get("entryId") ?? "";
                const queuedEntryId = url.searchParams.get("queuedEntryId") ?? "";
                const query = url.searchParams.get("query") ?? "";

                const entry = queuedEntryId
                    ? await first<{ name: string; category_name: string }>(
                        getDb()
                            .prepare(
                                `SELECT entry_queue.name, categories.name AS category_name
                 FROM entry_queue
                 INNER JOIN categories ON categories.id = entry_queue.category_id
                 WHERE entry_queue.id = ? AND entry_queue.user_id = ?
                   AND entry_queue.status = 'queued'`
                            )
                            .bind(queuedEntryId, session.user.id)
                    )
                    : await first<{ name: string; category_name: string }>(
                        getDb()
                            .prepare(
                                `SELECT entries.name, categories.name AS category_name
                 FROM entries
                 INNER JOIN categories ON categories.id = entries.category_id
                 WHERE entries.id = ? AND entries.user_id = ? AND entries.status != 'deleted'`
                            )
                            .bind(entryId, session.user.id)
                    );

                if (!entry) {
                    return Response.json({ message: "Image target not found" }, { status: 404 });
                }

                const searchQuery = query.trim() || `${entry.name} (${entry.category_name})`;

                try {
                    return Response.json({
                        candidates: await searchImageCandidates(searchQuery)
                    }, {
                        headers: {
                            "cache-control": "private, no-store"
                        }
                    });
                } catch (error) {
                    return Response.json(
                        { message: error instanceof Error ? error.message : "Image search failed" },
                        { status: 502 }
                    );
                }
            }
        }
    }
});
