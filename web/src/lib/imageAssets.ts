export const CONTENT_ADDRESSED_IMAGE_PREFIX = "entry-images/sha256/";

export function contentAddressedImageKey(contentHash: string) {
    return `${CONTENT_ADDRESSED_IMAGE_PREFIX}${contentHash}`;
}

export async function sha256Hex(bytes: ArrayBuffer) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
