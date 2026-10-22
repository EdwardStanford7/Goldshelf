import { env } from "cloudflare:workers";
import { hasStoredImage } from "@/lib/images";
import {
    contentAddressedImageKey,
    isContentAddressedImageKey,
    sha256Hex
} from "@/lib/imageAssets";
import { getDb, now } from "@/server/lib/db";

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
