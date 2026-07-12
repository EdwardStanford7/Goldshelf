import { hasStoredImage } from "@/lib/images";
import { auth } from "@/server/lib/auth";
import { first, getDb, now } from "@/server/lib/db";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;

export const Route = createFileRoute("/api/profile-image")({
    server: {
        handlers: {
            GET: async ({ request }: { request: Request }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return new Response("Unauthorized", { status: 401 });
                }

                const user = await first<{ image: string | null }>(
                    getDb()
                        .prepare(`SELECT image FROM "user" WHERE id = ?`)
                        .bind(session.user.id)
                );
                const imageKey = user?.image ?? null;

                if (!hasStoredImage(imageKey)) {
                    return new Response("Not found", { status: 404 });
                }

                const image = await env.IMAGES.get(imageKey);
                if (!image?.body) {
                    return new Response("Not found", { status: 404 });
                }

                return new Response(image.body, {
                    headers: {
                        "content-type": image.httpMetadata?.contentType ?? "image/jpeg",
                        "cache-control": "private, max-age=31536000, immutable"
                    }
                });
            },
            POST: async ({ request }: { request: Request }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return Response.json({ message: "Unauthorized" }, { status: 401 });
                }

                const contentType = request.headers.get("content-type") ?? "";
                if (!contentType.startsWith("image/")) {
                    return Response.json({ message: "Expected an image upload" }, { status: 415 });
                }

                const image = await request.arrayBuffer();
                if (image.byteLength > MAX_PROFILE_IMAGE_BYTES) {
                    return Response.json({ message: "Image is too large" }, { status: 413 });
                }

                const user = await first<{ image: string | null }>(
                    getDb()
                        .prepare(`SELECT image FROM "user" WHERE id = ?`)
                        .bind(session.user.id)
                );
                if (!user) {
                    return Response.json({ message: "Profile not found" }, { status: 404 });
                }
                const oldImageKey = user?.image ?? null;

                const imageKey = `${session.user.id}/profile/avatar-${now()}.jpg`;
                await env.IMAGES.put(imageKey, image, {
                    httpMetadata: {
                        contentType
                    }
                });

                try {
                    await getDb()
                        .prepare(
                            `UPDATE "user"
             SET image = ?, updatedAt = ?
             WHERE id = ?`
                        )
                        .bind(imageKey, now(), session.user.id)
                        .run();
                } catch (error) {
                    await env.IMAGES.delete(imageKey).catch(() => undefined);
                    throw error;
                }

                if (hasStoredImage(oldImageKey) && oldImageKey !== imageKey) {
                    await env.IMAGES.delete(oldImageKey).catch(() => undefined);
                }

                return Response.json({ imageKey });
            },
            DELETE: async ({ request }: { request: Request }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return Response.json({ message: "Unauthorized" }, { status: 401 });
                }

                const user = await first<{ image: string | null }>(
                    getDb()
                        .prepare(`SELECT image FROM "user" WHERE id = ?`)
                        .bind(session.user.id)
                );
                if (!user) {
                    return Response.json({ message: "Profile not found" }, { status: 404 });
                }
                const imageKey = user?.image ?? null;

                await getDb()
                    .prepare(
                        `UPDATE "user"
             SET image = NULL, updatedAt = ?
             WHERE id = ?`
                    )
                    .bind(now(), session.user.id)
                    .run();

                if (hasStoredImage(imageKey)) {
                    await env.IMAGES.delete(imageKey);
                }

                return Response.json({ ok: true });
            }
        }
    }
});
