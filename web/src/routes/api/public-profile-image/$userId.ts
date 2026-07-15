import { hasStoredImage } from "@/lib/images";
import { hasAdminRole } from "@/lib/admin";
import { auth } from "@/server/lib/auth";
import { first, getDb } from "@/server/lib/db";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/public-profile-image/$userId")({
    server: {
        handlers: {
            GET: async ({ params, request }: { params: { userId: string }; request: Request }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                const viewerUserId = session?.user.id ?? "";
                const viewerIsAdmin = hasAdminRole(session?.user);
                const user = await first<{ image: string | null }>(
                    getDb()
                        .prepare(
                            `SELECT "user".image
               FROM "user"
               INNER JOIN user_profiles ON user_profiles.user_id = "user".id
               WHERE "user".id = ?
                 AND (
                   ? = 1
                   OR user_profiles.is_public = 1
                   OR EXISTS (
                     SELECT 1
                     FROM user_follows
                     WHERE user_follows.follower_user_id = ?
                       AND user_follows.followed_user_id = "user".id
                       AND user_follows.status = 'accepted'
                   )
                   OR EXISTS (
                     SELECT 1
                     FROM user_follows
                     WHERE user_follows.follower_user_id = "user".id
                       AND user_follows.followed_user_id = ?
                       AND user_follows.status IN ('pending', 'accepted')
                   )
                 )`
                        )
                        .bind(params.userId, viewerIsAdmin ? 1 : 0, viewerUserId, viewerUserId)
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
                        "cache-control": "no-store"
                    }
                });
            }
        }
    }
});
