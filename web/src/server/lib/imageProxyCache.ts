const IMAGE_PROXY_CACHE_TTL_SECONDS = 6 * 60 * 60;
const MAX_CACHED_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_PROXY_CACHE_ORIGIN = "https://image-proxy-cache.goldshelf.internal";

interface CloudflareCacheStorage extends CacheStorage {
    default: Cache;
}

function defaultCache() {
    return (caches as CloudflareCacheStorage).default;
}

async function cacheRequest(imageUrl: URL) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(imageUrl.toString()));
    const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return new Request(`${IMAGE_PROXY_CACHE_ORIGIN}/${key}`);
}

export async function readCachedProxiedImage(imageUrl: URL) {
    try {
        return await defaultCache().match(await cacheRequest(imageUrl));
    } catch {
        // Local runtimes and cache-disabled deployments still proxy safely.
        return undefined;
    }
}

export async function cacheProxiedImage(imageUrl: URL, response: Response, bytes: number) {
    if (bytes > MAX_CACHED_IMAGE_BYTES) {
        return;
    }

    try {
        await defaultCache().put(await cacheRequest(imageUrl), response);
    } catch {
        // A cache miss must never make an otherwise valid picker image fail.
    }
}

export function proxiedImageResponse(response: Response) {
    const headers = new Headers(response.headers);
    // This permits the user's browser to reuse a loaded thumbnail. The edge
    // cache always stores a separate public response with no user data.
    headers.set("cache-control", "private, max-age=3600");
    headers.set("content-security-policy", "sandbox; default-src 'none'");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText
    });
}

export function cacheableImageResponse(image: ArrayBuffer, contentType: string) {
    return new Response(image, {
        headers: {
            "cache-control": `public, max-age=${IMAGE_PROXY_CACHE_TTL_SECONDS}`,
            "content-type": contentType,
            "content-security-policy": "sandbox; default-src 'none'",
            "x-content-type-options": "nosniff"
        }
    });
}
