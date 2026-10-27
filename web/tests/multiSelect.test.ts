import { describe, expect, it } from "vitest";
import { nextMultiSelection } from "../src/lib/multiSelect";

describe("nextMultiSelection", () => {
    it("keeps the complete shift selection", () => {
        const orderedIds = Array.from({ length: 201 }, (_, index) => `entry-${index}`);

        const result = nextMultiSelection({
            anchorId: "entry-0",
            clickedId: "entry-200",
            orderedIds,
            selectedIds: new Set(),
            shiftKey: true
        });

        expect(result.anchorId).toBe("entry-0");
        expect(result.selectedIds).toHaveLength(201);
    });
});
