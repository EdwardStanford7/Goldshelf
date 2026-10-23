export interface ValidatedImageUpload {
    bytes: ArrayBuffer;
    contentType: SupportedImageContentType;
    extension: string;
}

export type SupportedImageContentType =
    | "image/jpeg"
    | "image/png"
    | "image/webp"
    | "image/gif"
    | "image/avif";

interface ImageFormat {
    contentType: SupportedImageContentType;
    extension: string;
}

const JPEG: ImageFormat = { contentType: "image/jpeg", extension: "jpg" };
const PNG: ImageFormat = { contentType: "image/png", extension: "png" };
const WEBP: ImageFormat = { contentType: "image/webp", extension: "webp" };
const GIF: ImageFormat = { contentType: "image/gif", extension: "gif" };
const AVIF: ImageFormat = { contentType: "image/avif", extension: "avif" };

/**
 * Reads a bounded image upload and derives its stored MIME type from its
 * binary signature. A client-controlled Content-Type is never persisted.
 * This deliberately excludes SVG: it is an active document format, not a
 * safe user-uploaded image format for same-origin delivery.
 */
export async function readValidatedImageUpload(request: Request, maxBytes: number): Promise<ValidatedImageUpload> {
    const declaredLength = parseContentLength(request.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > maxBytes) {
        throw new ImageUploadError("Image is too large", 413);
    }

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
        throw new ImageUploadError("Image is too large", 413);
    }

    const format = detectImageFormat(new Uint8Array(bytes));
    if (!format) {
        throw new ImageUploadError("Upload must be a JPEG, PNG, WebP, GIF, or AVIF image", 415);
    }

    return { bytes, ...format };
}

export class ImageUploadError extends Error {
    constructor(message: string, readonly status: 413 | 415) {
        super(message);
    }
}

export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
    if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) return GIF;
    if (startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, "WEBP")) return WEBP;

    // ISO Base Media File Format: AVIF uses an ftyp box whose major brand is
    // avif/avis. Keeping this explicit avoids accepting arbitrary MP4 files.
    if (asciiAt(bytes, 4, "ftyp") && (asciiAt(bytes, 8, "avif") || asciiAt(bytes, 8, "avis"))) {
        return AVIF;
    }

    return null;
}

function parseContentLength(value: string | null) {
    if (!value || !/^\d+$/u.test(value)) return null;
    const length = Number(value);
    return Number.isSafeInteger(length) ? length : null;
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
    return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function startsWithAscii(bytes: Uint8Array, value: string) {
    return asciiAt(bytes, 0, value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string) {
    return bytes.length >= offset + value.length &&
        [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}
