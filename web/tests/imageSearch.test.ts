import { describe, expect, it } from "vitest";
import { assertSafeImageUrl } from "../src/server/lib/imageSearch";
import { createImageProxyToken, readImageProxyToken } from "../src/server/lib/imageProxyToken";

describe("image proxy URL safety", () => {
    it("allows public https image URLs", () => {
        expect(assertSafeImageUrl("https://images.example.com/poster.jpg").hostname)
            .toBe("images.example.com");
        expect(assertSafeImageUrl("https://fda.gov/poster.jpg").hostname)
            .toBe("fda.gov");
        expect(assertSafeImageUrl("https://fc.example.com/poster.jpg").hostname)
            .toBe("fc.example.com");
    });

    it("blocks local and private direct hosts", () => {
        const blockedUrls = [
            "https://localhost/image.jpg",
            "https://127.0.0.1/image.jpg",
            "https://10.0.0.5/image.jpg",
            "https://172.16.0.5/image.jpg",
            "https://192.168.1.10/image.jpg",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/image.jpg",
            "https://[fd00::1]/image.jpg",
            "https://[fe80::1]/image.jpg",
            "https://[::ffff:127.0.0.1]/image.jpg"
        ];

        for (const url of blockedUrls) {
            expect(() => assertSafeImageUrl(url), url).toThrow("Unsupported image host");
        }
    });

    it("rejects non-http protocols", () => {
        expect(() => assertSafeImageUrl("file:///etc/passwd")).toThrow("Unsupported image URL");
        expect(() => assertSafeImageUrl("http://cdn.example.com/poster.jpg")).toThrow("Unsupported image URL");
    });
});

describe("image proxy tokens", () => {
    const secret = "test-image-proxy-secret";
    const now = 1_700_000_000_000;

    it("allows the signed-in searcher to use a recent result", async () => {
        const token = await createImageProxyToken("https://images.example.com/poster.jpg", "user-a", secret, now);
        await expect(readImageProxyToken(token, "user-a", secret, now + 1)).resolves
            .toBe("https://images.example.com/poster.jpg");
    });

    it("rejects tampered, expired, and cross-user tokens", async () => {
        const token = await createImageProxyToken("https://images.example.com/poster.jpg", "user-a", secret, now);
        await expect(readImageProxyToken(`${token}x`, "user-a", secret, now + 1)).resolves.toBeNull();
        await expect(readImageProxyToken(token, "user-b", secret, now + 1)).resolves.toBeNull();
        await expect(readImageProxyToken(token, "user-a", secret, now + 6 * 60 * 60 * 1_000 + 1)).resolves.toBeNull();
    });
});
