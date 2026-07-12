import { env } from "cloudflare:workers";
import { hasStoredImage } from "@/lib/images";
import { all, getDb, now } from "@/server/lib/db";

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETED_ITEM_RETENTION_MS = 30 * DAY_MS;
const DELETED_CLEANUP_LIMIT = 50;

interface DeletedImageRow {
    id: string;
    image_key: string | null;
}

export async function purgeExpiredDeletedItems(userId: string) {
    const cutoff = now() - DELETED_ITEM_RETENTION_MS;
    const db = getDb();
    await purgeDeletedRows({
        db,
        cutoff,
        tableName: "entries",
        userId
    });
    await purgeDeletedRows({
        db,
        cutoff,
        tableName: "entry_queue",
        userId
    });
}

async function purgeDeletedRows({
    cutoff,
    db,
    tableName,
    userId
}: {
    cutoff: number;
    db: D1Database;
    tableName: "entries" | "entry_queue";
    userId: string;
}) {
    const deletedRows = await all<DeletedImageRow>(
        db
            .prepare(
                `SELECT id, image_key
         FROM ${tableName}
         WHERE user_id = ? AND status = 'deleted' AND updated_at < ?
         ORDER BY updated_at ASC
         LIMIT ?`
            )
            .bind(userId, cutoff, DELETED_CLEANUP_LIMIT)
    );

    if (deletedRows.length === 0) {
        return;
    }

    const imageKeys = Array.from(new Set(
        deletedRows
            .map((row) => row.image_key)
            .filter((imageKey): imageKey is string => hasStoredImage(imageKey))
    ));
    await Promise.all(imageKeys.map((imageKey) => env.IMAGES.delete(imageKey).catch(() => undefined)));
    await db.batch(
        deletedRows.map((row) =>
            db
                .prepare(
                    `DELETE FROM ${tableName}
             WHERE user_id = ? AND id = ? AND status = 'deleted' AND updated_at < ?`
                )
                .bind(userId, row.id, cutoff)
        )
    );
}
