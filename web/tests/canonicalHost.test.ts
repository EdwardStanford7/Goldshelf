import { describe, expect, it } from "vitest";
import { canonicalUrl } from "../src/lib/canonicalHost";

describe("canonical host redirects", () => {
    it("redirects www while preserving the path and query", () => {
        expect(canonicalUrl("https://www.goldshelf.net/u/alice?view=public")?.toString())
            .toBe("https://goldshelf.net/u/alice?view=public");
    });

    it("does not redirect the canonical host", () => {
        expect(canonicalUrl("https://goldshelf.net/profile")).toBeNull();
    });
});
