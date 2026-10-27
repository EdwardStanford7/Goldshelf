const TOKEN_VERSION = 1;
// Keep result links valid for the same period as the edge image cache. A user
// can leave the picker open, scroll, or retry a selection without a token
// expiring underneath an otherwise usable thumbnail.
const TOKEN_TTL_MS = 6 * 60 * 60 * 1_000;

interface ImageProxyTokenPayload {
    version: number;
    userId: string;
    imageUrl: string;
    expiresAt: number;
}

const signingKeys = new Map<string, Promise<CryptoKey>>();

function toBase64Url(bytes: Uint8Array) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

function fromBase64Url(value: string) {
    const base64 = value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string) {
    let key = signingKeys.get(secret);
    if (!key) {
        key = crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(secret),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign", "verify"]
        );
        signingKeys.set(secret, key);
    }
    return key;
}

async function sign(payload: string, secret: string) {
    const signature = await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        new TextEncoder().encode(`goldshelf:image-proxy:v1:${payload}`)
    );
    return toBase64Url(new Uint8Array(signature));
}

/**
 * A proxy URL is only useful to the signed-in user and only for a recent
 * search result. That lets thumbnail requests avoid a database rate-limit
 * write without reopening the proxy as a general-purpose fetch endpoint.
 */
export async function createImageProxyToken(
    imageUrl: string,
    userId: string,
    secret: string,
    now = Date.now()
) {
    const payload: ImageProxyTokenPayload = {
        version: TOKEN_VERSION,
        userId,
        imageUrl,
        expiresAt: now + TOKEN_TTL_MS
    };
    const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    return `${encodedPayload}.${await sign(encodedPayload, secret)}`;
}

export async function readImageProxyToken(
    token: string,
    userId: string,
    secret: string,
    now = Date.now()
) {
    const [encodedPayload, signature, ...extra] = token.split(".");
    if (!encodedPayload || !signature || extra.length > 0) {
        return null;
    }

    try {
        const validSignature = await crypto.subtle.verify(
            "HMAC",
            await signingKey(secret),
            fromBase64Url(signature),
            new TextEncoder().encode(`goldshelf:image-proxy:v1:${encodedPayload}`)
        );
        if (!validSignature) {
            return null;
        }

        const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload))) as ImageProxyTokenPayload;
        if (
            payload.version !== TOKEN_VERSION ||
            payload.userId !== userId ||
            typeof payload.imageUrl !== "string" ||
            !Number.isSafeInteger(payload.expiresAt) ||
            payload.expiresAt < now
        ) {
            return null;
        }

        return payload.imageUrl;
    } catch {
        return null;
    }
}
