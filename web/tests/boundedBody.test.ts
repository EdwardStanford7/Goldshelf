import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBoundedBody } from "../src/server/lib/boundedBody";

describe("bounded image bodies", () => {
    it("cancels a chunked body as soon as its byte limit is exceeded", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) { controller.enqueue(new Uint8Array(4)); },
            cancel() { cancelled = true; }
        });
        await expect(readBoundedBody({ body }, 5)).rejects.toBeInstanceOf(BodyTooLargeError);
        expect(cancelled).toBe(true);
    });
    it("times out while waiting for a stalled body", async () => {
        const body = new ReadableStream<Uint8Array>({});
        await expect(readBoundedBody({ body }, 5, 10)).rejects.toThrow("timed out");
    });
});
