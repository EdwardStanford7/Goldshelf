import { hasStoredImage } from "@/lib/images";
import { auth } from "@/server/lib/auth";
import { first, getDb } from "@/server/lib/db";
import { storedImageResponse } from "@/server/lib/imageResponse";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public-images/$entryId")({
    server: { handlers: { GET: async ({ params, request }: { params: { entryId: string }; request: Request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        const viewerUserId = session?.user.id ?? "";
        const entry = await first<{ image_key: string | null }>(getDb().prepare(
            `SELECT entries.image_key FROM entries
             INNER JOIN categories ON categories.id = entries.category_id
             INNER JOIN user_profiles ON user_profiles.user_id = entries.user_id
             WHERE entries.id = ? AND entries.status = 'active' AND categories.user_id = entries.user_id
               AND (categories.visibility = 'public' OR (categories.visibility = 'followers' AND ? != '' AND EXISTS (
                    SELECT 1 FROM user_follows WHERE follower_user_id = ? AND followed_user_id = entries.user_id AND status = 'accepted')))
               AND (? = '' OR NOT EXISTS (SELECT 1 FROM user_blocks WHERE
                    (blocker_user_id = ? AND blocked_user_id = entries.user_id) OR
                    (blocker_user_id = entries.user_id AND blocked_user_id = ?)))
               AND (user_profiles.is_public = 1 OR EXISTS (
                    SELECT 1 FROM user_follows WHERE follower_user_id = ? AND followed_user_id = entries.user_id AND status = 'accepted'))`
        ).bind(params.entryId, viewerUserId, viewerUserId, viewerUserId, viewerUserId, viewerUserId, viewerUserId));
        if (!hasStoredImage(entry?.image_key ?? null)) return new Response("Not found", { status: 404 });
        return await storedImageResponse(entry!.image_key!, "no-store") ?? new Response("Not found", { status: 404 });
    } } }
});
