import { describe, expect, it } from "vitest";
import { nextLimitedMultiSelection } from "../src/lib/multiSelect";

describe("nextLimitedMultiSelection", () => {
    it("retains the current selection when a shift selection exceeds its limit", () => {
        const orderedIds = Array.from({ length: 201 }, (_, index) => `entry-${index}`);

        const result = nextLimitedMultiSelection({
            anchorId: "entry-0",
            clickedId: "entry-200",
            orderedIds,
            selectedIds: new Set(),
            shiftKey: true
        }, 200);

        expect(result.limitExceeded).toBe(true);
        expect(result.anchorId).toBe("entry-0");
        expect(result.selectedIds).toEqual(new Set());
    });

    it("allows a selection at the limit", () => {
        const orderedIds = Array.from({ length: 200 }, (_, index) => `entry-${index}`);

        const result = nextLimitedMultiSelection({
            anchorId: "entry-0",
            clickedId: "entry-199",
            orderedIds,
            selectedIds: new Set(),
            shiftKey: true
        }, 200);

        expect(result.limitExceeded).toBe(false);
        expect(result.selectedIds).toHaveLength(200);
    });
});
