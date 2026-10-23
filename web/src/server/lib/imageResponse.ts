import { env } from "cloudflare:workers";

const IMAGE_OBJECT_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const IMAGE_CACHE_ORIGIN = "https://image-cache.goldshelf.internal";

interface CloudflareCacheStorage extends CacheStorage {
    default: Cache;
}

function defaultCache() {
    return (caches as CloudflareCacheStorage).default;
}

function imageCacheRequest(imageKey: string) {
    return new Request(`${IMAGE_CACHE_ORIGIN}/${encodeURIComponent(imageKey)}`);
}

async function readCachedImage(imageKey: string) {
    try {
        return await defaultCache().match(imageCacheRequest(imageKey));
    } catch {
        return undefined;
    }
}

async function cacheImage(imageKey: string, response: Response) {
    try {
        await defaultCache().put(imageCacheRequest(imageKey), response);
    } catch {
        // Local runtimes and cache-disabled deployments can still serve directly from R2.
    }
}

export async function storedImageResponse(
    imageKey: string,
    clientCacheControl: string,
    fallbackContentType = "image/jpeg"
) {
    let cached = await readCachedImage(imageKey);
    if (!cached) {
        const image = await env.IMAGES.get(imageKey);
        if (!image?.body) {
            return null;
        }

        cached = new Response(image.body, {
            headers: {
                "cache-control": `public, max-age=${IMAGE_OBJECT_CACHE_TTL_SECONDS}, immutable`,
                "content-type": image.httpMetadata?.contentType ?? fallbackContentType,
                "content-security-policy": "sandbox; default-src 'none'",
                "etag": image.httpEtag,
                "x-content-type-options": "nosniff"
            }
        });
        await cacheImage(imageKey, cached.clone());
    }

    const headers = new Headers(cached.headers);
    headers.set("cache-control", clientCacheControl);
    return new Response(cached.body, {
        headers,
        status: cached.status,
        statusText: cached.statusText
    });
}
