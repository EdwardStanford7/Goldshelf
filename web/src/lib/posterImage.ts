import type { CategoryWithEntries, Entry, QueuedEntry } from "@/lib/types";

export interface ImagePickerTarget {
    kind: "entry" | "queue";
    item: Pick<Entry | QueuedEntry, "id" | "name" | "imageKey">;
    category: Pick<CategoryWithEntries, "id" | "name">;
}

export interface ImageSearchCandidate {
    id: string;
    imageUrl: string;
    thumbnailUrl: string;
    width: number;
    height: number;
}

export const POSTER_WIDTH = 380;
export const POSTER_HEIGHT = 475;
export const MAX_LOCAL_IMAGE_BYTES = 12 * 1024 * 1024;

export function withCacheBust(path: string, value: string) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("refresh", value);
    return `${url.pathname}${url.search}`;
}

export async function imageUrlToPosterBlob(imageUrl: string) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
        throw new Error("Remote image could not be loaded");
    }

    return imageBlobToPosterBlob(await response.blob());
}

export async function imageCandidateToPosterBlob(
    candidate: ImageSearchCandidate,
    renderedThumbnail: HTMLImageElement | null,
    cachedThumbnailBlob: Blob | null
) {
    try {
        return await imageUrlToPosterBlob(candidate.imageUrl);
    } catch (fullSizeError) {
        if (cachedThumbnailBlob) {
            return cachedThumbnailBlob;
        }

        if (
            renderedThumbnail?.complete &&
            renderedThumbnail.naturalWidth > 0 &&
            renderedThumbnail.naturalHeight > 0
        ) {
            try {
                return await imageElementToPosterBlob(renderedThumbnail);
            } catch {
                // Fall through to a network thumbnail fetch as the last resort.
            }
        }

        if (candidate.thumbnailUrl === candidate.imageUrl) {
            throw new Error("Displayed image could not be saved");
        }

        return imageUrlToPosterBlob(candidate.thumbnailUrl);
    }
}

export function imageBlobToPosterBlob(blob: Blob) {
    if (blob.size > MAX_LOCAL_IMAGE_BYTES) {
        throw new Error("Image file is too large");
    }

    return new Promise<Blob>((resolve, reject) => {
        const image = new Image();
        const objectUrl = URL.createObjectURL(blob);

        image.onload = () => {
            imageElementToPosterBlob(image)
                .then(resolve)
                .catch(reject)
                .finally(() => URL.revokeObjectURL(objectUrl));
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error("Full-size image could not be loaded"));
        };
        image.src = objectUrl;
    });
}

export function imageElementToPosterBlob(image: HTMLImageElement) {
    return new Promise<Blob>((resolve, reject) => {
        try {
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (!context) {
                throw new Error("Image processing is unavailable");
            }

            const sourceWidth = image.naturalWidth;
            const sourceHeight = image.naturalHeight;
            if (sourceWidth === 0 || sourceHeight === 0) {
                throw new Error("Image has no dimensions");
            }

            const targetRatio = POSTER_WIDTH / POSTER_HEIGHT;
            const sourceRatio = sourceWidth / sourceHeight;
            let cropX = 0;
            let cropY = 0;
            let cropWidth = sourceWidth;
            let cropHeight = sourceHeight;

            if (sourceRatio > targetRatio) {
                cropWidth = sourceHeight * targetRatio;
                cropX = (sourceWidth - cropWidth) / 2;
            } else {
                cropHeight = sourceWidth / targetRatio;
                cropY = (sourceHeight - cropHeight) / 2;
            }

            canvas.width = POSTER_WIDTH;
            canvas.height = POSTER_HEIGHT;
            context.drawImage(
                image,
                cropX,
                cropY,
                cropWidth,
                cropHeight,
                0,
                0,
                POSTER_WIDTH,
                POSTER_HEIGHT
            );

            canvas.toBlob(
                (posterBlob) => {
                    if (!posterBlob) {
                        reject(new Error("Image could not be saved"));
                        return;
                    }

                    resolve(posterBlob);
                },
                "image/jpeg",
                0.9
            );
        } catch (error) {
            reject(error);
        }
    });
}

export async function uploadImageForTarget(target: ImagePickerTarget, blob: Blob) {
    const endpoint = target.kind === "entry"
        ? `/api/images/${encodeURIComponent(target.item.id)}`
        : `/api/queued-images/${encodeURIComponent(target.item.id)}`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "content-type": blob.type || "image/jpeg"
        },
        body: blob
    });

    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
            ? body.message
            : "Image upload failed";
        throw new Error(message);
    }
}
