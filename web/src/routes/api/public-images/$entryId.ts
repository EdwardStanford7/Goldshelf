import { hasStoredImage } from "@/lib/images";
import { hasAdminRole } from "@/lib/admin";
import { auth } from "@/server/lib/auth";
import { first, getDb } from "@/server/lib/db";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/public-images/$entryId")({
    server: {
        handlers: {
            GET: async ({ params, request }: { params: { entryId: string }; request: Request }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                const viewerUserId = session?.user.id ?? "";
                const viewerIsAdmin = hasAdminRole(session?.user);
                const entry = await first<{ image_key: string | null }>(
                    getDb()
                        .prepare(
                            `SELECT entries.image_key
               FROM entries
               INNER JOIN categories ON categories.id = entries.category_id
               INNER JOIN user_profiles ON user_profiles.user_id = entries.user_id
               WHERE entries.id = ?
                 AND entries.status = 'active'
                 AND categories.user_id = entries.user_id
                 AND (? = 1 OR categories.is_public = 1)
                 AND (
                   ? = 1
                   OR
                   user_profiles.is_public = 1
                   OR EXISTS (
                     SELECT 1
                     FROM user_follows
                     WHERE user_follows.follower_user_id = ?
                       AND user_follows.followed_user_id = entries.user_id
                       AND user_follows.status = 'accepted'
                   )
                 )`
                        )
                        .bind(params.entryId, viewerIsAdmin ? 1 : 0, viewerIsAdmin ? 1 : 0, viewerUserId)
                );

                const imageKey = entry?.image_key ?? null;
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
                        "cache-control": "no-store"
                    }
                });
            }
        }
    }
});
