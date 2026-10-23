import { hasStoredImage } from "@/lib/images";
import { auth } from "@/server/lib/auth";
import { first, getDb, now } from "@/server/lib/db";
import { storedImageResponse } from "@/server/lib/imageResponse";
import { requireSameOriginMutation } from "@/server/lib/requestGuards";
import { ImageUploadError, readValidatedImageUpload } from "@/server/lib/imageUpload";
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

                return await storedImageResponse(
                    imageKey,
                    "private, max-age=31536000, immutable"
                ) ?? new Response("Not found", { status: 404 });
            },
            POST: async ({ request }: { request: Request }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return Response.json({ message: "Unauthorized" }, { status: 401 });
                }
                const originError = requireSameOriginMutation(request);
                if (originError) {
                    return originError;
                }

                let image;
                try {
                    image = await readValidatedImageUpload(request, MAX_PROFILE_IMAGE_BYTES);
                } catch (error) {
                    if (error instanceof ImageUploadError) {
                        return Response.json({ message: error.message }, { status: error.status });
                    }
                    throw error;
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

                const imageKey = `${session.user.id}/profile/avatar-${now()}.${image.extension}`;
                await env.IMAGES.put(imageKey, image.bytes, {
                    httpMetadata: {
                        contentType: image.contentType
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
                const originError = requireSameOriginMutation(request);
                if (originError) {
                    return originError;
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
                    await env.IMAGES.delete(imageKey).catch(() => undefined);
                }

                return Response.json({ ok: true });
            }
        }
    }
});
