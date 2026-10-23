import { describe, expect, it } from "vitest";
import { fixedWindowStart } from "../src/server/lib/rateLimitWindow";

describe("API rate-limit window bucketing", () => {
    it("places requests in fixed windows", () => {
        expect(fixedWindowStart(119_999, 60_000)).toBe(60_000);
        expect(fixedWindowStart(120_000, 60_000)).toBe(120_000);
    });
});
