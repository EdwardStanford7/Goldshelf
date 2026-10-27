import { describe, expect, it } from "vitest";
import {
    CONTENT_ADDRESSED_IMAGE_PREFIX,
    contentAddressedImageKey,
    sha256Hex
} from "../src/lib/imageAssets";

describe("content-addressed image assets", () => {
    it("uses a stable SHA-256 key for identical bytes", async () => {
        const first = new TextEncoder().encode("same image bytes").buffer;
        const second = new TextEncoder().encode("same image bytes").buffer;

        const firstHash = await sha256Hex(first);
        const secondHash = await sha256Hex(second);

        expect(firstHash).toBe(secondHash);
        expect(firstHash).toHaveLength(64);
        expect(contentAddressedImageKey(firstHash)).toBe(`${CONTENT_ADDRESSED_IMAGE_PREFIX}${firstHash}`);
    });

    it("keeps different bytes distinct", async () => {
        const firstHash = await sha256Hex(new TextEncoder().encode("first").buffer);
        const secondHash = await sha256Hex(new TextEncoder().encode("second").buffer);

        expect(firstHash).not.toBe(secondHash);
    });
});
