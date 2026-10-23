import { createServerFn } from "@tanstack/react-start";
import { all, first, getDb } from "@/server/lib/db";
import { deleteLegacyImageObject, deleteUnreferencedImageAssets, releaseImageReferences } from "@/server/lib/imageAssets";
import { authMiddleware } from "@/server/middleware/auth";

const ACCOUNT_DELETION_CONFIRMATION = "DELETE";

interface ImageKeyRow {
    image_key: string | null;
}

interface UserImageRow {
    image: string | null;
}

export const deleteCurrentUserAccount = createServerFn({ method: "POST" })
    .middleware([authMiddleware])
    .validator((data: { confirmation: string }) => data)
    .handler(async ({ context, data }) => {
        if (data.confirmation.trim() !== ACCOUNT_DELETION_CONFIRMATION) {
            throw new Error(`Type ${ACCOUNT_DELETION_CONFIRMATION} to permanently delete your account.`);
        }

        const db = getDb();
        const userId = context.user.id;
        const [entryImages, queuedImages, user] = await Promise.all([
            all<ImageKeyRow>(db.prepare(`SELECT image_key FROM entries WHERE user_id = ?`).bind(userId)),
            all<ImageKeyRow>(db.prepare(`SELECT image_key FROM entry_queue WHERE user_id = ?`).bind(userId)),
            first<UserImageRow>(db.prepare(`SELECT image FROM "user" WHERE id = ?`).bind(userId))
        ]);
        if (!user) {
            throw new Error("Account not found.");
        }

        const imageKeys = [
            ...entryImages.map((row) => row.image_key),
            ...queuedImages.map((row) => row.image_key)
        ];
        await db.batch([
            db.prepare(`DELETE FROM active_user_operations WHERE user_id = ?`).bind(userId),
            db.prepare(`DELETE FROM ranking_sessions WHERE user_id = ?`).bind(userId),
            db.prepare(`DELETE FROM repair_sessions WHERE user_id = ?`).bind(userId),
            db.prepare(`DELETE FROM entry_queue WHERE user_id = ?`).bind(userId),
            db.prepare(`DELETE FROM entries WHERE user_id = ?`).bind(userId),
            db.prepare(`DELETE FROM categories WHERE user_id = ?`).bind(userId),
            db.prepare(`DELETE FROM queue_settings WHERE user_id = ?`).bind(userId),
            db.prepare(`DELETE FROM api_rate_limits WHERE "key" LIKE ?`).bind(`%:${userId}`),
            db.prepare(`DELETE FROM verification WHERE identifier = ?`).bind(context.user.email),
            db.prepare(`DELETE FROM admin_audit_events WHERE target_user_id = ?`).bind(userId),
            db.prepare(`DELETE FROM "user" WHERE id = ?`).bind(userId)
        ]);

        await releaseImageReferences(imageKeys);
        await deleteUnreferencedImageAssets(imageKeys);
        await deleteLegacyImageObject(user.image);
        return { deleted: true };
    });
