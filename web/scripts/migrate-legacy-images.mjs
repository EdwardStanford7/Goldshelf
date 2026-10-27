#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTENT_ADDRESSED_PREFIX = "entry-images/sha256/";

const config = readWranglerConfig();
const databaseName = config.d1_databases?.find((binding) => binding.binding === "DB")?.database_name;
const bucketName = config.r2_buckets?.find((binding) => binding.binding === "IMAGES")?.bucket_name;

if (!databaseName || !bucketName) {
    throw new Error("wrangler.jsonc must define the DB D1 binding and IMAGES R2 binding.");
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "goldshelf-legacy-images-"));
const temporaryImagePath = join(temporaryDirectory, "image");
let migratedCount = 0;

try {
    for (;;) {
        const legacyImageKey = await nextLegacyImageKey();
        if (!legacyImageKey) {
            break;
        }

        await migrateLegacyImage(legacyImageKey);
        migratedCount += 1;
        if (migratedCount % 25 === 0) {
            console.log(`Migrated ${migratedCount} legacy image objects.`);
        }
    }
} finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
}

console.log(
    migratedCount === 0
        ? "No legacy image objects need migration."
        : `Migrated ${migratedCount} legacy image objects.`
);

async function nextLegacyImageKey() {
    const rows = await executeD1Json(`
        SELECT image_key
        FROM (
          SELECT image_key
          FROM entries
          WHERE image_key IS NOT NULL AND image_key != '__media_rating_no_image__'
          UNION
          SELECT image_key
          FROM entry_queue
          WHERE image_key IS NOT NULL AND image_key != '__media_rating_no_image__'
          UNION
          SELECT image AS image_key
          FROM "user"
          WHERE image IS NOT NULL AND image != '__media_rating_no_image__'
        )
        WHERE image_key NOT LIKE '${CONTENT_ADDRESSED_PREFIX}%'
        ORDER BY image_key ASC
        LIMIT 1
    `);

    return rows[0]?.image_key ?? null;
}

async function migrateLegacyImage(legacyImageKey) {
    await rm(temporaryImagePath, { force: true });
    await runWrangler([
        "r2", "object", "get", `${bucketName}/${legacyImageKey}`, "--remote", "--file", temporaryImagePath
    ]);
    const bytes = await readFile(temporaryImagePath);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `${CONTENT_ADDRESSED_PREFIX}${contentHash}`;
    const contentType = detectImageContentType(bytes);

    await runWrangler([
        "r2", "object", "put", `${bucketName}/${objectKey}`, "--remote", "--file", temporaryImagePath,
        "--content-type", contentType
    ]);

    const timestamp = Date.now();
    const byteSize = (await stat(temporaryImagePath)).size;
    await executeD1(`
        BEGIN;
        INSERT INTO image_assets (
          content_hash, object_key, content_type, byte_size,
          created_at, last_referenced_at, unreferenced_at
        ) VALUES (
          ${sqlLiteral(contentHash)},
          ${sqlLiteral(objectKey)},
          ${sqlLiteral(contentType)},
          ${byteSize},
          ${timestamp},
          ${timestamp},
          NULL
        )
        ON CONFLICT(content_hash) DO UPDATE SET
          last_referenced_at = excluded.last_referenced_at,
          unreferenced_at = NULL;
        UPDATE entries SET image_key = ${sqlLiteral(objectKey)}
        WHERE image_key = ${sqlLiteral(legacyImageKey)};
        UPDATE entry_queue SET image_key = ${sqlLiteral(objectKey)}
        WHERE image_key = ${sqlLiteral(legacyImageKey)};
        UPDATE "user" SET image = ${sqlLiteral(objectKey)}
        WHERE image = ${sqlLiteral(legacyImageKey)};
        COMMIT;
    `);

    // The database now points only at the content-addressed object. Removing
    // the old key last makes reruns safe: an interrupted migration simply
    // repeats this idempotent conversion on its next `make deploy`.
    await runWrangler([
        "r2", "object", "delete", `${bucketName}/${legacyImageKey}`, "--remote"
    ]);
}

async function executeD1(command) {
    await runWrangler([
        "d1", "execute", databaseName, "--remote", "--command", command
    ]);
}

async function executeD1Json(command) {
    const { stdout } = await runWrangler([
        "d1", "execute", databaseName, "--remote", "--json", "--command", command
    ]);
    const response = JSON.parse(stdout);
    const result = Array.isArray(response) ? response[0] : response;
    if (!result?.success) {
        throw new Error("D1 did not report a successful migration query.");
    }
    return result.results ?? [];
}

function runWrangler(arguments_) {
    return execFileAsync("pnpm", ["exec", "wrangler", ...arguments_], {
        cwd: new URL("..", import.meta.url),
        maxBuffer: 10 * 1024 * 1024
    });
}

function readWranglerConfig() {
    const url = new URL("../wrangler.jsonc", import.meta.url);
    const jsonc = JSON.parse(readFileSync(url, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, ""));
    return jsonc;
}

function sqlLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function detectImageContentType(bytes) {
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
    if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
    if (asciiAt(bytes, 4, "ftyp") && (asciiAt(bytes, 8, "avif") || asciiAt(bytes, 8, "avis"))) {
        return "image/avif";
    }
    throw new Error("A legacy image did not have a supported image signature; it was not changed.");
}

function startsWith(bytes, prefix) {
    return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes, offset, value) {
    return bytes.length >= offset + value.length &&
        [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}
