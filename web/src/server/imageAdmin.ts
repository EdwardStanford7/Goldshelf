import { createServerFn } from "@tanstack/react-start";
import { isContentAddressedImageKey } from "@/lib/imageAssets";
import type { ImageStorageReconciliation } from "@/lib/types";
import { all, getDb, getImagesBucket, now } from "@/server/lib/db";
import { adminMiddleware } from "@/server/middleware/auth";

const MAX_RECONCILIATION_OBJECTS = 50_000;
const RECONCILIATION_SAMPLE_SIZE = 20;

interface ImageKeyRow {
    image_key: string;
}

interface ImageAssetKeyRow {
    object_key: string;
}

export const loadImageStorageReconciliation = createServerFn({ method: "POST" })
    .middleware([adminMiddleware])
    .handler(() => reconcileImageStorage());

async function reconcileImageStorage(): Promise<ImageStorageReconciliation> {
    const db = getDb();
    const images = getImagesBucket();
    const [referenceRows, assetRows] = await Promise.all([
        all<ImageKeyRow>(
            db.prepare(
                `SELECT image_key FROM entries
                 WHERE image_key IS NOT NULL AND image_key != '__media_rating_no_image__'
                 UNION
                 SELECT image_key FROM entry_queue
                 WHERE image_key IS NOT NULL AND image_key != '__media_rating_no_image__'
                 UNION
                 SELECT image AS image_key FROM "user"
                 WHERE image IS NOT NULL`
            )
        ),
        all<ImageAssetKeyRow>(db.prepare(`SELECT object_key FROM image_assets`))
    ]);

    const referencedKeys = new Set(referenceRows.map((row) => row.image_key));
    const trackedAssetKeys = new Set(assetRows.map((row) => row.object_key));
    const r2Keys = new Set<string>();
    let cursor: string | undefined;
    let truncated = false;

    do {
        const page = await images.list({ cursor, limit: 1_000 });
        for (const object of page.objects) {
            r2Keys.add(object.key);
            if (r2Keys.size >= MAX_RECONCILIATION_OBJECTS) {
                truncated = page.truncated || page.objects.length > 0;
                break;
            }
        }
        if (r2Keys.size >= MAX_RECONCILIATION_OBJECTS || !page.truncated) {
            break;
        }
        cursor = page.cursor;
    } while (cursor);

    const missingObjects = Array.from(referencedKeys).filter((key) => !r2Keys.has(key));
    const orphanObjects = Array.from(r2Keys).filter((key) => !referencedKeys.has(key));
    const untrackedSharedReferences = Array.from(referencedKeys).filter(
        (key) => isContentAddressedImageKey(key) && !trackedAssetKeys.has(key)
    );
    const legacyReferenceCount = Array.from(referencedKeys).filter(
        (key) => !isContentAddressedImageKey(key)
    ).length;

    return {
        checkedAt: now(),
        truncated,
        r2ObjectCount: r2Keys.size,
        referencedKeyCount: referencedKeys.size,
        trackedAssetCount: trackedAssetKeys.size,
        legacyReferenceCount,
        missingObjectCount: missingObjects.length,
        orphanObjectCount: orphanObjects.length,
        untrackedSharedReferenceCount: untrackedSharedReferences.length,
        missingObjectSamples: missingObjects.slice(0, RECONCILIATION_SAMPLE_SIZE),
        orphanObjectSamples: orphanObjects.slice(0, RECONCILIATION_SAMPLE_SIZE),
        untrackedSharedReferenceSamples: untrackedSharedReferences.slice(0, RECONCILIATION_SAMPLE_SIZE)
    };
}
