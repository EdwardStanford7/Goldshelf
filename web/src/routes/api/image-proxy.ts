import { auth } from "@/server/lib/auth";
import { assertSafeImageUrl, decodeImageUrl } from "@/server/lib/imageSearch";
import { fetchWithTimeout } from "@/server/lib/network";
import { createFileRoute } from "@tanstack/react-router";

const MAX_PROXY_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_PROXY_TIMEOUT_MS = 8_000;

export const Route = createFileRoute("/api/image-proxy")({
    server: {
        handlers: {
            GET: async ({ request }: { request: Request }) => {
                const session = await auth.api.getSession({ headers: request.headers });
                if (!session?.user) {
                    return new Response("Unauthorized", { status: 401 });
                }

                const encodedUrl = new URL(request.url).searchParams.get("u");
                if (!encodedUrl) {
                    return new Response("Missing image URL", { status: 400 });
                }

                let imageUrl: URL;
                try {
                    imageUrl = assertSafeImageUrl(decodeImageUrl(encodedUrl));
                } catch (error) {
                    return new Response(error instanceof Error ? error.message : "Invalid image URL", {
                        status: 400
                    });
                }

                let response: Response;
                try {
                    response = await fetchWithTimeout(
                        imageUrl,
                        {
                            headers: {
                                "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                                "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
                            }
                        },
                        IMAGE_PROXY_TIMEOUT_MS,
                        "Image request timed out"
                    );
                } catch {
                    return new Response("Image request failed", { status: 502 });
                }

                if (!response.ok) {
                    return new Response("Image request failed", { status: 502 });
                }

                const contentType = response.headers.get("content-type") ?? "";
                if (!contentType.startsWith("image/")) {
                    return new Response("URL did not return an image", { status: 415 });
                }

                const contentLength = Number(response.headers.get("content-length") ?? 0);
                if (contentLength > MAX_PROXY_IMAGE_BYTES) {
                    return new Response("Image is too large", { status: 413 });
                }

                const image = await response.arrayBuffer();
                if (image.byteLength > MAX_PROXY_IMAGE_BYTES) {
                    return new Response("Image is too large", { status: 413 });
                }

                return new Response(image, {
                    headers: {
                        "cache-control": "private, no-store",
                        "content-type": contentType
                    }
                });
            }
        }
    }
});
