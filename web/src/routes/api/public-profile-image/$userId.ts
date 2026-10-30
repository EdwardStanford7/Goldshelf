import { hasStoredImage } from "@/lib/images";
import { auth } from "@/server/lib/auth";
import { first, getDb } from "@/server/lib/db";
import { storedImageResponse } from "@/server/lib/imageResponse";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public-profile-image/$userId")({
    server: { handlers: { GET: async ({ params, request }: { params: { userId: string }; request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        const viewerUserId = session?.user.id ?? "";
        const user = await first<{ image: string | null }>(getDb().prepare(
            `SELECT "user".image FROM "user" INNER JOIN user_profiles ON user_profiles.user_id = "user".id
             WHERE "user".id = ? AND (? = '' OR NOT EXISTS (SELECT 1 FROM user_blocks WHERE
                    (blocker_user_id = ? AND blocked_user_id = "user".id) OR
                    (blocker_user_id = "user".id AND blocked_user_id = ?)))
               AND (user_profiles.is_public = 1 OR EXISTS (SELECT 1 FROM user_follows
                    WHERE follower_user_id = ? AND followed_user_id = "user".id AND status = 'accepted')
                 OR EXISTS (SELECT 1 FROM user_follows WHERE follower_user_id = "user".id
                    AND followed_user_id = ? AND status IN ('pending', 'accepted')))`
        ).bind(params.userId, viewerUserId, viewerUserId, viewerUserId, viewerUserId, viewerUserId));
        if (!hasStoredImage(user?.image ?? null)) return new Response("Not found", { status: 404 });
        return await storedImageResponse(user!.image!, "no-store") ?? new Response("Not found", { status: 404 });
    } } }
});
