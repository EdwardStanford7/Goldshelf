import { env } from "cloudflare:workers";
import { hasStoredImage } from "@/lib/images";
import { contentAddressedImageKey, sha256Hex } from "@/lib/imageAssets";
import { getDb, now } from "@/server/lib/db";

const IMAGE_ASSET_GRACE_MS = 35 * 24 * 60 * 60 * 1000;
const IMAGE_ASSET_CLEANUP_LIMIT = 25;
const UPLOAD_LEASE_MS = 60_000;

export async function storeContentAddressedImage(bytes: ArrayBuffer, contentType: string, timestamp = now()) {
    const contentHash = await sha256Hex(bytes);
    const objectKey = contentAddressedImageKey(contentHash);
    // Reserve before touching R2. Cleanup cannot claim this asset while its
    // upload/reference update is in flight. A claimed deletion is retryable.
    const reservation = await getDb().prepare(`INSERT INTO image_assets
      (content_hash, object_key, content_type, byte_size, created_at, last_referenced_at, unreferenced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO UPDATE SET last_referenced_at = excluded.last_referenced_at,
        unreferenced_at = COALESCE(image_assets.unreferenced_at, excluded.unreferenced_at)
        WHERE image_assets.deleting = 0 RETURNING object_key`)
        .bind(contentHash, objectKey, contentType, bytes.byteLength, timestamp, timestamp, timestamp)
        .all<{ object_key: string }>();
    if (reservation.results.length === 0) throw new Error("Image cleanup is in progress. Please try again.");
    if (!await env.IMAGES.head(objectKey)) {
        await env.IMAGES.put(objectKey, bytes, { httpMetadata: { contentType } });
    }
    return objectKey;
}

export async function releaseImageReference(imageKey: string | null, timestamp = now()) {
    await releaseImageReferences([imageKey], timestamp);
}

export async function releaseImageReferences(imageKeys: Array<string | null>, timestamp = now()) {
    const keys = [...new Set(imageKeys.filter((key): key is string => hasStoredImage(key)))];
    // One set-based statement and one revision guard per bounded chunk.
    for (let offset = 0; offset < keys.length; offset += 500) {
        await getDb().prepare(`UPDATE image_assets SET unreferenced_at = CASE
      WHEN EXISTS (SELECT 1 FROM entries WHERE image_key = image_assets.object_key)
        OR EXISTS (SELECT 1 FROM entry_queue WHERE image_key = image_assets.object_key)
        OR EXISTS (SELECT 1 FROM "user" WHERE image = image_assets.object_key)
      THEN NULL ELSE COALESCE(unreferenced_at, ?) END
      WHERE object_key IN (SELECT value FROM json_each(?))`)
            .bind(timestamp, JSON.stringify(keys.slice(offset, offset + 500))).run();
    }
}

async function deleteAsset(objectKey: string, timestamp: number, cutoff: number) {
    const db = getDb();
    const claimed = await db.prepare(`UPDATE image_assets SET deleting = 1
      WHERE object_key = ? AND (deleting = 1 OR
        (unreferenced_at IS NOT NULL AND unreferenced_at <= ? AND last_referenced_at < ?))
      AND NOT EXISTS (SELECT 1 FROM entries WHERE image_key = image_assets.object_key)
      AND NOT EXISTS (SELECT 1 FROM entry_queue WHERE image_key = image_assets.object_key)
      AND NOT EXISTS (SELECT 1 FROM "user" WHERE image = image_assets.object_key)
      RETURNING object_key`).bind(objectKey, cutoff, timestamp - UPLOAD_LEASE_MS).all();
    if (!claimed.results.length) return false;
    // The durable fence rejects new references. If interrupted at either
    // step, the next scheduled cleanup resumes this same deletion.
    await env.IMAGES.delete(objectKey);
    await db.prepare("DELETE FROM image_assets WHERE object_key = ? AND deleting = 1").bind(objectKey).run();
    return true;
}

export async function deleteUnreferencedImageAssets(imageKeys: Array<string | null>) {
    const timestamp = now();
    for (const key of new Set(imageKeys)) {
        if (hasStoredImage(key)) await deleteAsset(key, timestamp, timestamp);
    }
}

export async function purgeUnreferencedImageAssets(timestamp = now()) {
    const cutoff = timestamp - IMAGE_ASSET_GRACE_MS;
    const candidates = await getDb().prepare(`SELECT object_key FROM image_assets
      WHERE (deleting = 1 OR (unreferenced_at IS NOT NULL AND unreferenced_at < ?))
        AND NOT EXISTS (SELECT 1 FROM entries WHERE image_key = image_assets.object_key)
        AND NOT EXISTS (SELECT 1 FROM entry_queue WHERE image_key = image_assets.object_key)
        AND NOT EXISTS (SELECT 1 FROM "user" WHERE image = image_assets.object_key)
      ORDER BY unreferenced_at LIMIT ?`).bind(cutoff, IMAGE_ASSET_CLEANUP_LIMIT).all<{ object_key: string }>();
    let deletedCount = 0;
    for (const candidate of candidates.results) {
        if (await deleteAsset(candidate.object_key, timestamp, cutoff)) deletedCount++;
    }
    return { deletedCount, examinedCount: candidates.results.length };
}
