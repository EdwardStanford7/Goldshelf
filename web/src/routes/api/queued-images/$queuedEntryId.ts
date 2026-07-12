import { auth } from "@/server/lib/auth";
import { first, getDb, now } from "@/server/lib/db";
import { isNoImageKey, hasStoredImage } from "@/lib/images";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

const MAX_UPLOAD_IMAGE_BYTES = 3 * 1024 * 1024;

export const Route = createFileRoute("/api/queued-images/$queuedEntryId")({
    server: {
        handlers: {
            GET: async ({
                request,
                params
            }: {
                request: Request;
                params: { queuedEntryId: string };
            }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return new Response("Unauthorized", { status: 401 });
                }

                const entry = await first<{ image_key: string | null }>(
                    getDb()
                        .prepare(
                            `SELECT image_key
               FROM entry_queue
               WHERE id = ? AND user_id = ? AND status = 'queued'`
                        )
                        .bind(params.queuedEntryId, session.user.id)
                );

                if (!entry?.image_key) {
                    return new Response("Not found", { status: 404 });
                }

                if (isNoImageKey(entry.image_key)) {
                    return new Response("No image saved", { status: 404 });
                }

                const image = await env.IMAGES.get(entry.image_key);
                if (!image?.body) {
                    return new Response("Not found", { status: 404 });
                }

                return new Response(image.body, {
                    headers: {
                        "content-type": image.httpMetadata?.contentType ?? "image/png",
                        "cache-control": "private, max-age=31536000, immutable"
                    }
                });
            },
            POST: async ({
                request,
                params
            }: {
                request: Request;
                params: { queuedEntryId: string };
            }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return Response.json({ message: "Unauthorized" }, { status: 401 });
                }

                const entry = await first<{ id: string; image_key: string | null }>(
                    getDb()
                        .prepare(
                            `SELECT id, image_key
               FROM entry_queue
               WHERE id = ? AND user_id = ? AND status = 'queued'`
                        )
                        .bind(params.queuedEntryId, session.user.id)
                );

                if (!entry) {
                    return Response.json({ message: "Queued entry not found" }, { status: 404 });
                }

                const contentType = request.headers.get("content-type") ?? "";
                if (!contentType.startsWith("image/")) {
                    return Response.json({ message: "Expected an image upload" }, { status: 415 });
                }

                const image = await request.arrayBuffer();
                if (image.byteLength > MAX_UPLOAD_IMAGE_BYTES) {
                    return Response.json({ message: "Image is too large" }, { status: 413 });
                }

                const imageKey = `${session.user.id}/queue/${entry.id}-${now()}.jpg`;
                await env.IMAGES.put(imageKey, image, {
                    httpMetadata: {
                        contentType
                    }
                });

                try {
                    await getDb()
                        .prepare(
                            `UPDATE entry_queue
             SET image_key = ?, updated_at = ?
             WHERE id = ? AND user_id = ?`
                        )
                        .bind(imageKey, now(), entry.id, session.user.id)
                        .run();
                } catch (error) {
                    await env.IMAGES.delete(imageKey).catch(() => undefined);
                    throw error;
                }

                if (hasStoredImage(entry.image_key) && entry.image_key !== imageKey) {
                    await env.IMAGES.delete(entry.image_key).catch(() => undefined);
                }

                return Response.json({ imageKey });
            },
            DELETE: async ({
                request,
                params
            }: {
                request: Request;
                params: { queuedEntryId: string };
            }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return Response.json({ message: "Unauthorized" }, { status: 401 });
                }

                const entry = await first<{ id: string; image_key: string | null }>(
                    getDb()
                        .prepare(
                            `SELECT id, image_key
               FROM entry_queue
               WHERE id = ? AND user_id = ? AND status = 'queued'`
                        )
                        .bind(params.queuedEntryId, session.user.id)
                );

                if (!entry) {
                    return Response.json({ message: "Queued entry not found" }, { status: 404 });
                }

                if (hasStoredImage(entry.image_key)) {
                    await env.IMAGES.delete(entry.image_key);
                }

                await getDb()
                    .prepare(
                        `UPDATE entry_queue
             SET image_key = NULL, updated_at = ?
             WHERE id = ? AND user_id = ?`
                    )
                    .bind(now(), entry.id, session.user.id)
                    .run();

                return Response.json({ ok: true });
            }
        }
    }
});
