import { describe, expect, it } from "vitest";
import { detectImageFormat } from "../src/server/lib/imageUpload";

function bytes(...values: number[]) {
    return new Uint8Array(values);
}

describe("uploaded image validation", () => {
    it("recognizes supported raster image signatures", () => {
        expect(detectImageFormat(bytes(0xff, 0xd8, 0xff))?.contentType).toBe("image/jpeg");
        expect(detectImageFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.contentType).toBe("image/png");
        expect(detectImageFormat(new TextEncoder().encode("GIF89a"))?.contentType).toBe("image/gif");
        expect(detectImageFormat(new TextEncoder().encode("RIFF0000WEBP"))?.contentType).toBe("image/webp");
        expect(detectImageFormat(new TextEncoder().encode("0000ftypavif"))?.contentType).toBe("image/avif");
    });

    it("rejects active and mislabeled document formats", () => {
        expect(detectImageFormat(new TextEncoder().encode("<svg><script>alert(1)</script></svg>"))).toBeNull();
        expect(detectImageFormat(new TextEncoder().encode("<html>not an image</html>"))).toBeNull();
    });
});
