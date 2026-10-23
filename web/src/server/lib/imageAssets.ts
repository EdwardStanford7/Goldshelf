import { env } from "cloudflare:workers";
import { hasStoredImage } from "@/lib/images";
import {
    contentAddressedImageKey,
    isContentAddressedImageKey,
    sha256Hex
} from "@/lib/imageAssets";
import { getDb, now } from "@/server/lib/db";

const IMAGE_ASSET_GRACE_MS = 35 * 24 * 60 * 60 * 1000;
const IMAGE_ASSET_CLEANUP_LIMIT = 25;

interface UnreferencedImageAssetRow {
    object_key: string;
    content_type: string;
    unreferenced_at: number;
}

export async function storeContentAddressedImage(
    bytes: ArrayBuffer,
    contentType: string,
    timestamp = now()
) {
    const contentHash = await sha256Hex(bytes);
    const objectKey = contentAddressedImageKey(contentHash);
    const existingObject = await env.IMAGES.head(objectKey);
    if (!existingObject) {
        await env.IMAGES.put(objectKey, bytes, {
            httpMetadata: { contentType }
        });
    }

    await getDb()
        .prepare(
            `INSERT INTO image_assets (
               content_hash, object_key, content_type, byte_size,
               created_at, last_referenced_at, unreferenced_at
             )
             VALUES (?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(content_hash) DO UPDATE SET
               last_referenced_at = excluded.last_referenced_at,
               unreferenced_at = NULL`
        )
        .bind(contentHash, objectKey, contentType, bytes.byteLength, timestamp, timestamp)
        .run();

    return objectKey;
}

export async function deleteLegacyImageObject(imageKey: string | null) {
    if (!hasStoredImage(imageKey) || isContentAddressedImageKey(imageKey)) {
        return;
    }

    await env.IMAGES.delete(imageKey).catch(() => undefined);
}

export async function releaseImageReference(imageKey: string | null, timestamp = now()) {
    if (!hasStoredImage(imageKey)) {
        return;
    }
    if (!isContentAddressedImageKey(imageKey)) {
        await deleteLegacyImageObject(imageKey);
        return;
    }

    await getDb()
        .prepare(
            `UPDATE image_assets
             SET unreferenced_at = CASE
               WHEN EXISTS (SELECT 1 FROM entries WHERE image_key = ?)
                 OR EXISTS (SELECT 1 FROM entry_queue WHERE image_key = ?)
               THEN NULL
               ELSE COALESCE(unreferenced_at, ?)
             END
             WHERE object_key = ?`
        )
        .bind(imageKey, imageKey, timestamp, imageKey)
        .run();
}

export async function releaseImageReferences(imageKeys: Array<string | null>, timestamp = now()) {
    await Promise.all(Array.from(new Set(imageKeys)).map((imageKey) => releaseImageReference(imageKey, timestamp)));
}

export async function deleteUnreferencedImageAssets(imageKeys: Array<string | null>) {
    const objectKeys = Array.from(new Set(
        imageKeys.filter((imageKey): imageKey is string => isContentAddressedImageKey(imageKey))
    ));

    for (const objectKey of objectKeys) {
        const candidate = await getDb()
            .prepare(
                `SELECT object_key, content_type
                 FROM image_assets
                 WHERE object_key = ?
                   AND NOT EXISTS (SELECT 1 FROM entries WHERE image_key = image_assets.object_key)
                   AND NOT EXISTS (SELECT 1 FROM entry_queue WHERE image_key = image_assets.object_key)`
            )
            .bind(objectKey)
            .first<{ object_key: string; content_type: string }>();
        if (!candidate) {
            continue;
        }

        const object = await env.IMAGES.get(candidate.object_key);
        const bytes = object?.body ? await object.arrayBuffer() : null;
        if (object) {
            await env.IMAGES.delete(candidate.object_key);
        }

        const deletion = await getDb()
            .prepare(
                `DELETE FROM image_assets
                 WHERE object_key = ?
                   AND NOT EXISTS (SELECT 1 FROM entries WHERE image_key = image_assets.object_key)
                   AND NOT EXISTS (SELECT 1 FROM entry_queue WHERE image_key = image_assets.object_key)`
            )
            .bind(candidate.object_key)
            .run();
        if ((deletion.meta.changes ?? 0) > 0 || !bytes) {
            continue;
        }

        await env.IMAGES.put(candidate.object_key, bytes, {
            httpMetadata: {
                contentType: object?.httpMetadata?.contentType ?? candidate.content_type
            }
        });
    }
}

export async function purgeUnreferencedImageAssets(timestamp = now()) {
    const db = getDb();
    const cutoff = timestamp - IMAGE_ASSET_GRACE_MS;
    const candidates = await db
        .prepare(
            `SELECT object_key, content_type, unreferenced_at
             FROM image_assets
             WHERE unreferenced_at IS NOT NULL
               AND unreferenced_at < ?
               AND NOT EXISTS (SELECT 1 FROM entries WHERE entries.image_key = image_assets.object_key)
               AND NOT EXISTS (SELECT 1 FROM entry_queue WHERE entry_queue.image_key = image_assets.object_key)
             ORDER BY unreferenced_at ASC
             LIMIT ?`
        )
        .bind(cutoff, IMAGE_ASSET_CLEANUP_LIMIT)
        .all<UnreferencedImageAssetRow>();

    let deletedCount = 0;
    for (const candidate of candidates.results ?? []) {
        const object = await env.IMAGES.get(candidate.object_key);
        const bytes = object?.body ? await object.arrayBuffer() : null;
        if (object) {
            await env.IMAGES.delete(candidate.object_key);
        }

        const deletion = await db
            .prepare(
                `DELETE FROM image_assets
                 WHERE object_key = ? AND unreferenced_at = ?
                   AND NOT EXISTS (SELECT 1 FROM entries WHERE image_key = ?)
                   AND NOT EXISTS (SELECT 1 FROM entry_queue WHERE image_key = ?)`
            )
            .bind(
                candidate.object_key,
                candidate.unreferenced_at,
                candidate.object_key,
                candidate.object_key
            )
            .run();

        if ((deletion.meta.changes ?? 0) > 0) {
            deletedCount += 1;
            continue;
        }

        if (bytes) {
            await env.IMAGES.put(candidate.object_key, bytes, {
                httpMetadata: {
                    contentType: object?.httpMetadata?.contentType ?? candidate.content_type
                }
            });
        }
    }

    return { deletedCount, examinedCount: candidates.results?.length ?? 0 };
}
