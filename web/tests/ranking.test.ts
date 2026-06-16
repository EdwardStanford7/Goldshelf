import { describe, expect, it } from "vitest";
import {
    chooseBinaryPivot,
    advanceBubbleRepairState,
    rankingDisplayPhase,
    recordBinaryChoice,
    recordLocalRepairChoice,
    startBinaryState,
    startBubbleRepairState,
    startLocalRepairState
} from "../src/lib/ranking";
import {
    addCachedComparison,
    emptyRankingOperationState,
    parseRankingOperationState,
    serializeRankingOperationState
} from "../src/server/engine/rankingState";
import {
    addRecentRepairPair,
    addRepairComparison,
    advancePairRepairState,
    chooseRepairMatchup,
    emptyRepairOperationState,
    pickRepairFirstIndex,
    pickRepairSecondIndex,
    pickWeightedRepairCategory,
    repairPairKey,
    startAdjacentRepairState,
    startBinaryReinsertRepairState
} from "../src/lib/repair";
import type { Entry } from "../src/lib/types";

describe("pure binary ranking", () => {
    it("places a new entry at the top", () => {
        let state = startBinaryState(4, () => 0.5);
        expect(state).not.toBeNull();

        while (state) {
            const result = recordBinaryChoice(state, true, () => 0.5);
            if (result.complete) {
                expect(result.finalIndex).toBe(0);
                return;
            }
            state = result.state;
        }
    });

    it("places a new entry at the bottom", () => {
        let state = startBinaryState(4, () => 0.5);
        expect(state).not.toBeNull();

        while (state) {
            const result = recordBinaryChoice(state, false, () => 0.5);
            if (result.complete) {
                expect(result.finalIndex).toBe(4);
                return;
            }
            state = result.state;
        }
    });

    it("supports a single existing entry", () => {
        const state = startBinaryState(1, () => 0);
        expect(state?.pivotIndex).toBe(0);

        const result = recordBinaryChoice(state!, false, () => 0);
        expect(result.complete).toBe(true);
        expect(result.finalIndex).toBe(1);
    });

    it("keeps pivots inside the active range", () => {
        for (let index = 0; index < 20; index += 1) {
            const pivot = chooseBinaryPivot(3, 9, () => index / 20);
            expect(pivot).toBeGreaterThanOrEqual(3);
            expect(pivot).toBeLessThan(9);
        }
    });
});

describe("local repair ranking", () => {
    it("checks the insertion neighbors before committing", () => {
        expect(startLocalRepairState(0, 5)).toEqual({
            phase: "repair_down",
            finalIndex: 0,
            opponentIndex: 0,
            initialUpwardCheck: false
        });
        expect(startLocalRepairState(3, 6)).toEqual({
            phase: "repair_up",
            finalIndex: 3,
            opponentIndex: 2,
            initialUpwardCheck: true
        });
        expect(startLocalRepairState(0, 0)).toBeNull();
    });

    it("continues upward when the subject beats the left neighbor", () => {
        const state = startLocalRepairState(4, 8);
        expect(state).not.toBeNull();

        const result = recordLocalRepairChoice(state!, true, 8);
        expect(result.complete).toBe(false);
        expect(result.finalIndex).toBe(3);
        expect(result.state).toEqual({
            phase: "repair_up",
            finalIndex: 3,
            opponentIndex: 2,
            initialUpwardCheck: false
        });
    });

    it("falls through to the right-side check when the left neighbor wins", () => {
        const state = startLocalRepairState(4, 8);
        expect(state).not.toBeNull();

        const result = recordLocalRepairChoice(state!, false, 8);
        expect(result.complete).toBe(false);
        expect(result.finalIndex).toBe(4);
        expect(result.state).toEqual({
            phase: "repair_down",
            finalIndex: 4,
            opponentIndex: 4,
            initialUpwardCheck: false
        });
    });

    it("continues downward when the right neighbor beats the subject", () => {
        const state = startLocalRepairState(0, 5);
        expect(state).not.toBeNull();

        const result = recordLocalRepairChoice(state!, false, 5);
        expect(result.complete).toBe(false);
        expect(result.finalIndex).toBe(1);
        expect(result.state).toEqual({
            phase: "repair_down",
            finalIndex: 1,
            opponentIndex: 1,
            initialUpwardCheck: false
        });
    });
});

describe("bubble repair ranking", () => {
    it("repairs an insertion that landed too high", () => {
        let state = startBubbleRepairState(["a", "b-", "d", "b", "c", "e"], "b-");
        const comparisons = [
            { winnerId: "b", loserId: "b-" },
            { winnerId: "b", loserId: "d" },
            { winnerId: "c", loserId: "d" },
            { winnerId: "d", loserId: "e" },
            { winnerId: "b-", loserId: "c" },
            { winnerId: "a", loserId: "b" }
        ];

        const result = advanceBubbleRepairState(state, comparisons);
        state = result.state;

        expect(result.complete).toBe(true);
        expect(state.workingOrderIds).toEqual(["a", "b", "b-", "c", "d", "e"]);
    });

    it("repairs an insertion that landed too low", () => {
        let state = startBubbleRepairState(["a", "d", "b", "b-", "c", "e"], "b-");
        const comparisons = [
            { winnerId: "b-", loserId: "d" },
            { winnerId: "b", loserId: "d" },
            { winnerId: "a", loserId: "b" },
            { winnerId: "b-", loserId: "d" },
            { winnerId: "b", loserId: "b-" },
            { winnerId: "c", loserId: "d" },
            { winnerId: "d", loserId: "e" },
            { winnerId: "b-", loserId: "c" }
        ];

        const result = advanceBubbleRepairState(state, comparisons);
        state = result.state;

        expect(result.complete).toBe(true);
        expect(state.workingOrderIds).toEqual(["a", "b", "b-", "c", "d", "e"]);
    });

    it("prompts for missing comparisons and resumes with the cached answer", () => {
        const state = startBubbleRepairState(["a", "d", "b", "b-", "c", "e"], "b-");
        const firstStep = advanceBubbleRepairState(state, []);

        expect(firstStep.complete).toBe(false);
        expect(firstStep.state.currentComparison).toEqual({
            entryAId: "b-",
            entryBId: "d"
        });

        const secondStep = advanceBubbleRepairState(firstStep.state, [
            { winnerId: "b-", loserId: "d" }
        ]);
        expect(secondStep.state.currentComparison).not.toEqual(firstStep.state.currentComparison);
    });
});

describe("ranking display phases", () => {
    it("keeps binary phases separate from placement checks and local repair", () => {
        expect(rankingDisplayPhase(null)).toBe("binary");
        expect(rankingDisplayPhase("binary")).toBe("binary");
        expect(rankingDisplayPhase("bubble_repair", "left_check")).toBe("placement_check");
        expect(rankingDisplayPhase("bubble_repair", "right_check")).toBe("placement_check");
        expect(rankingDisplayPhase("bubble_repair", "bubble_b_left")).toBe("local_repair");
        expect(rankingDisplayPhase("repair_up")).toBe("local_repair");
        expect(rankingDisplayPhase("repair_down")).toBe("local_repair");
    });
});

describe("ranking comparison cache", () => {
    it("starts each operation state with an empty comparison cache", () => {
        const firstOperation = emptyRankingOperationState();
        const secondOperation = emptyRankingOperationState();

        expect(firstOperation.comparisons).toEqual([]);
        expect(secondOperation.comparisons).toEqual([]);
        expect(secondOperation).not.toBe(firstOperation);
    });

    it("replaces duplicate inverse pairs instead of keeping stale answers", () => {
        const initialState = emptyRankingOperationState();
        const firstState = addCachedComparison(initialState, "a", "b");
        const replacementState = addCachedComparison(firstState, "b", "a");

        expect(firstState.comparisons).toEqual([{ winnerId: "a", loserId: "b" }]);
        expect(replacementState.comparisons).toEqual([{ winnerId: "b", loserId: "a" }]);
    });

    it("serializes comparison cache only inside the current operation state", () => {
        const state = addCachedComparison(emptyRankingOperationState(), "winner", "loser");
        const parsedState = parseRankingOperationState(serializeRankingOperationState(state));
        const freshState = parseRankingOperationState(null);

        expect(parsedState.comparisons).toEqual([{ winnerId: "winner", loserId: "loser" }]);
        expect(freshState.comparisons).toEqual([]);
    });
});

describe("repair mode sampling", () => {
    it("excludes categories with fewer than two entries and weights by entry count", () => {
        const category = pickWeightedRepairCategory(
            [
                { id: "empty", entryCount: 0 },
                { id: "one", entryCount: 1 },
                { id: "small", entryCount: 2 },
                { id: "large", entryCount: 8 }
            ],
            () => 0.95
        );

        expect(category?.id).toBe("large");
    });

    it("keeps center-biased and local-biased indexes in bounds", () => {
        for (let index = 0; index < 40; index += 1) {
            let randomValue = index / 41;
            const random = () => {
                randomValue = (randomValue + 0.37) % 1;
                return randomValue;
            };
            const firstIndex = pickRepairFirstIndex(20, random);
            const secondIndex = pickRepairSecondIndex(20, firstIndex, random);

            expect(firstIndex).toBeGreaterThanOrEqual(0);
            expect(firstIndex).toBeLessThan(20);
            expect(secondIndex).toBeGreaterThanOrEqual(0);
            expect(secondIndex).toBeLessThan(20);
            expect(secondIndex).not.toBe(firstIndex);
        }
    });

    it("avoids immediate duplicate repair pairs when another pair is available", () => {
        const entries = makeRepairEntries(["a", "b", "c", "d"]);
        const recentPairs = [repairPairKey("b", "c")];
        const matchup = chooseRepairMatchup(entries, recentPairs, sequenceRandom([
            0.5, 0.5, 0.1, 0.1,
            0.5, 0.5, 0.9, 0.1
        ]));

        expect(matchup).not.toBeNull();
        expect(repairPairKey(matchup!.higherEntryId, matchup!.lowerEntryId)).not.toBe(recentPairs[0]);
    });
});

describe("repair mode comparison cache", () => {
    it("tracks recent pairs and replaces inverse duplicate comparison answers", () => {
        const state = emptyRepairOperationState();
        state.recentPairs = addRecentRepairPair(state.recentPairs, "a", "b");
        state.recentPairs = addRecentRepairPair(state.recentPairs, "b", "a");

        expect(state.recentPairs).toEqual([repairPairKey("a", "b")]);

        const first = addRepairComparison(state, "a", "b");
        const replacement = addRepairComparison(first, "b", "a");

        expect(replacement.comparisons).toEqual([{ winnerId: "b", loserId: "a" }]);
    });
});

describe("repair mode adjacent repair", () => {
    it("does not move the lower-ranked winner above middle entries it loses to", () => {
        const state = startAdjacentRepairState(["p", "h", "m1", "m2", "l", "q"], "l", "h");
        const result = advancePairRepairState(state, [
            { winnerId: "l", loserId: "h" },
            { winnerId: "m2", loserId: "l" },
            { winnerId: "m1", loserId: "h" },
            { winnerId: "m2", loserId: "h" },
            { winnerId: "q", loserId: "h" }
        ]);

        expect(result.complete).toBe(true);
        expect(result.state.workingOrderIds).toEqual(["p", "m1", "m2", "l", "q", "h"]);
    });

    it("moves an over-ranked higher entry down after the known inversion", () => {
        const state = startAdjacentRepairState(["p", "h", "m1", "m2", "l", "q"], "l", "h");
        const result = advancePairRepairState(state, [
            { winnerId: "l", loserId: "h" },
            { winnerId: "m2", loserId: "l" },
            { winnerId: "m1", loserId: "h" },
            { winnerId: "m2", loserId: "h" },
            { winnerId: "h", loserId: "q" }
        ]);

        expect(result.complete).toBe(true);
        expect(result.state.workingOrderIds).toEqual(["p", "m1", "m2", "l", "h", "q"]);
    });
});

describe("repair mode binary re-place", () => {
    it("places both entries through the full category while keeping the winner above the loser", () => {
        const state = startBinaryReinsertRepairState(["a", "h", "b", "c", "d", "e", "f", "l", "g"], "l", "h");
        const result = advancePairRepairState(state, [
            { winnerId: "l", loserId: "h" },
            { winnerId: "b", loserId: "l" },
            { winnerId: "l", loserId: "d" },
            { winnerId: "c", loserId: "l" },
            { winnerId: "l", loserId: "d" },
            { winnerId: "f", loserId: "h" },
            { winnerId: "h", loserId: "g" }
        ], () => 0.5);

        expect(result.complete).toBe(true);
        expect(result.state.workingOrderIds.indexOf("l")).toBeLessThan(result.state.workingOrderIds.indexOf("h"));
        expect(result.state.workingOrderIds).toEqual(["a", "b", "c", "l", "d", "e", "f", "h", "g"]);
    });
});

function makeRepairEntries(ids: string[]): Entry[] {
    return ids.map((id, index) => ({
        id,
        categoryId: "cat",
        name: id,
        rankPosition: index,
        imageKey: null,
        createdAt: index
    }));
}

function sequenceRandom(values: number[]) {
    let index = 0;
    return () => {
        const value = values[index] ?? values[values.length - 1] ?? 0;
        index += 1;
        return value;
    };
}
