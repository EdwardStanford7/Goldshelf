import {
    chooseBinaryPivot,
    getCachedWinner,
    type RankingComparison
} from "./ranking";
import type { Entry } from "./types";

export const REPAIR_ADJACENT_GAP_THRESHOLD = 8;
const RECENT_REPAIR_PAIR_LIMIT = 100;

export type RepairScope = "all" | "category";
export type RepairSessionPhase = "checking" | "local_repair" | "binary_repair";
export type RepairStrategy = "none" | "adjacent" | "binary_reinsert";

export interface RepairCurrentCheck {
    categoryId: string;
    higherEntryId: string;
    lowerEntryId: string;
    gap: number;
}

export interface RepairComparisonPrompt {
    entryAId: string;
    entryBId: string;
}

export interface AdjacentRepairState {
    kind: "adjacent";
    winnerId: string;
    loserId: string;
    stage: "winner_left" | "loser_right";
    workingOrderIds: string[];
    currentComparison: RepairComparisonPrompt | null;
}

export interface BinaryReinsertRepairState {
    kind: "binary_reinsert";
    winnerId: string;
    loserId: string;
    stage:
        | "place_winner"
        | "check_winner_left"
        | "check_winner_right"
        | "place_loser"
        | "check_loser_left"
        | "check_loser_right";
    workingOrderIds: string[];
    lowerBound: number;
    upperBound: number;
    winnerIndex: number | null;
    currentComparison: RepairComparisonPrompt | null;
}

export type PairRepairState = AdjacentRepairState | BinaryReinsertRepairState;

export interface RepairOperationState {
    kind: "repair_operation_state";
    recentPairs: string[];
    comparisons: RankingComparison[];
    currentCheck: RepairCurrentCheck | null;
    repair: PairRepairState | null;
}

export interface RepairMatchupChoice {
    higherEntryId: string;
    lowerEntryId: string;
    gap: number;
}

export interface PairRepairAdvanceResult {
    state: PairRepairState;
    complete: boolean;
}

export function emptyRepairOperationState(): RepairOperationState {
    return {
        kind: "repair_operation_state",
        recentPairs: [],
        comparisons: [],
        currentCheck: null,
        repair: null
    };
}

export function serializeRepairOperationState(state: RepairOperationState) {
    return JSON.stringify(state);
}

export function parseRepairOperationState(value: string | null | undefined): RepairOperationState {
    if (!value) {
        return emptyRepairOperationState();
    }

    try {
        const parsed = JSON.parse(value) as Partial<RepairOperationState>;
        if (parsed.kind !== "repair_operation_state") {
            return emptyRepairOperationState();
        }

        return {
            kind: "repair_operation_state",
            recentPairs: normalizeRecentPairs(parsed.recentPairs),
            comparisons: normalizeComparisons(parsed.comparisons),
            currentCheck: normalizeCurrentCheck(parsed.currentCheck),
            repair: normalizePairRepairState(parsed.repair)
        };
    } catch {
        return emptyRepairOperationState();
    }
}

export function addRepairComparison(
    state: RepairOperationState,
    winnerId: string,
    loserId: string
): RepairOperationState {
    const comparisons = state.comparisons.filter((comparison) =>
        !(
            (comparison.winnerId === winnerId && comparison.loserId === loserId) ||
            (comparison.winnerId === loserId && comparison.loserId === winnerId)
        )
    );

    return {
        ...state,
        comparisons: [{ winnerId, loserId }, ...comparisons].slice(0, 200)
    };
}

export function addRecentRepairPair(
    recentPairs: string[],
    entryAId: string,
    entryBId: string
) {
    const key = repairPairKey(entryAId, entryBId);
    return [key, ...recentPairs.filter((pairKey) => pairKey !== key)]
        .slice(0, RECENT_REPAIR_PAIR_LIMIT);
}

export function repairPairKey(entryAId: string, entryBId: string) {
    return [entryAId, entryBId].sort().join(":");
}

export function pickWeightedRepairCategory<T extends { entryCount: number }>(
    categories: T[],
    random: () => number = Math.random
): T | null {
    const eligible = categories.filter((category) => category.entryCount >= 2);
    const totalWeight = eligible.reduce((sum, category) => sum + category.entryCount, 0);
    if (totalWeight <= 0) {
        return null;
    }

    let target = random() * totalWeight;
    for (const category of eligible) {
        target -= category.entryCount;
        if (target < 0) {
            return category;
        }
    }

    return eligible[eligible.length - 1] ?? null;
}

export function chooseRepairMatchup(
    entries: Entry[],
    recentPairs: string[],
    random: () => number = Math.random
): RepairMatchupChoice | null {
    if (entries.length < 2) {
        return null;
    }

    let fallback: RepairMatchupChoice | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const firstIndex = pickRepairFirstIndex(entries.length, random);
        const secondIndex = pickRepairSecondIndex(entries.length, firstIndex, random);
        const highIndex = Math.min(firstIndex, secondIndex);
        const lowIndex = Math.max(firstIndex, secondIndex);
        const higherEntry = entries[highIndex];
        const lowerEntry = entries[lowIndex];
        if (!higherEntry || !lowerEntry || higherEntry.id === lowerEntry.id) {
            continue;
        }

        const choice = {
            higherEntryId: higherEntry.id,
            lowerEntryId: lowerEntry.id,
            gap: lowIndex - highIndex
        };
        fallback = choice;
        if (!recentPairs.includes(repairPairKey(choice.higherEntryId, choice.lowerEntryId))) {
            return choice;
        }
    }

    return fallback;
}

export function pickRepairFirstIndex(
    length: number,
    random: () => number = Math.random
) {
    if (length <= 1) {
        return 0;
    }

    if (random() < 0.2) {
        return Math.floor(random() * length);
    }

    const center = (length - 1) / 2;
    const sigma = Math.max(length / 3, 1);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const index = Math.round(center + sampleNormal(random) * sigma);
        if (index >= 0 && index < length) {
            return index;
        }
    }

    return clampIndex(Math.round(center), length);
}

export function pickRepairSecondIndex(
    length: number,
    firstIndex: number,
    random: () => number = Math.random
) {
    if (length <= 1) {
        return 0;
    }

    const leftGap = firstIndex;
    const rightGap = length - firstIndex - 1;
    const chooseLeft = leftGap > 0 && (rightGap <= 0 || random() < 0.5);
    const maxGap = chooseLeft ? leftGap : rightGap;
    if (maxGap <= 0) {
        return chooseLeft ? firstIndex + 1 : firstIndex - 1;
    }

    const gap = pickRepairGap(maxGap, random);
    return chooseLeft ? firstIndex - gap : firstIndex + gap;
}

export function startAdjacentRepairState(
    orderedEntryIds: string[],
    winnerId: string,
    loserId: string
): AdjacentRepairState {
    return {
        kind: "adjacent",
        winnerId,
        loserId,
        stage: "winner_left",
        workingOrderIds: [...orderedEntryIds],
        currentComparison: null
    };
}

export function startBinaryReinsertRepairState(
    orderedEntryIds: string[],
    winnerId: string,
    loserId: string
): BinaryReinsertRepairState {
    return {
        kind: "binary_reinsert",
        winnerId,
        loserId,
        stage: "place_winner",
        workingOrderIds: orderedEntryIds.filter((entryId) => entryId !== winnerId && entryId !== loserId),
        lowerBound: 0,
        upperBound: Math.max(orderedEntryIds.length - 2, 0),
        winnerIndex: null,
        currentComparison: null
    };
}

export function advancePairRepairState(
    state: PairRepairState,
    comparisons: RankingComparison[],
    random: () => number = Math.random
): PairRepairAdvanceResult {
    return state.kind === "adjacent"
        ? advanceAdjacentRepairState(state, comparisons)
        : advanceBinaryReinsertRepairState(state, comparisons, random);
}

function advanceAdjacentRepairState(
    state: AdjacentRepairState,
    comparisons: RankingComparison[]
): PairRepairAdvanceResult {
    const next: AdjacentRepairState = {
        ...state,
        workingOrderIds: [...state.workingOrderIds],
        currentComparison: null
    };
    const maxSteps = Math.max(next.workingOrderIds.length * 4 + 8, 16);

    for (let step = 0; step < maxSteps; step += 1) {
        if (next.stage === "winner_left") {
            const result = bubbleSubjectLeft(next.workingOrderIds, next.winnerId, comparisons);
            if (result.currentComparison) {
                next.currentComparison = result.currentComparison;
                return { state: next, complete: false };
            }

            next.stage = "loser_right";
            continue;
        }

        const result = bubbleSubjectRight(next.workingOrderIds, next.loserId, comparisons);
        if (result.currentComparison) {
            next.currentComparison = result.currentComparison;
            return { state: next, complete: false };
        }

        return { state: next, complete: true };
    }

    throw new Error("Adjacent repair did not converge");
}

function advanceBinaryReinsertRepairState(
    state: BinaryReinsertRepairState,
    comparisons: RankingComparison[],
    random: () => number
): PairRepairAdvanceResult {
    const next: BinaryReinsertRepairState = {
        ...state,
        workingOrderIds: [...state.workingOrderIds],
        currentComparison: state.currentComparison ? { ...state.currentComparison } : null
    };
    const maxSteps = Math.max(next.workingOrderIds.length * 6 + 24, 32);

    for (let step = 0; step < maxSteps; step += 1) {
        if (next.stage === "place_winner") {
            const result = advanceBinaryPlacement(next, next.winnerId, comparisons, random);
            if (result.needsComparison) {
                return { state: next, complete: false };
            }

            next.workingOrderIds.splice(next.lowerBound, 0, next.winnerId);
            next.winnerIndex = next.lowerBound;
            next.lowerBound = 0;
            next.upperBound = 0;
            next.currentComparison = null;
            next.stage = "check_winner_left";
            continue;
        }

        if (next.stage === "check_winner_left") {
            const result = bubbleSubjectLeft(next.workingOrderIds, next.winnerId, comparisons);
            if (result.currentComparison) {
                next.currentComparison = result.currentComparison;
                return { state: next, complete: false };
            }

            next.stage = "check_winner_right";
            continue;
        }

        if (next.stage === "check_winner_right") {
            const result = bubbleSubjectRight(next.workingOrderIds, next.winnerId, comparisons);
            if (result.currentComparison) {
                next.currentComparison = result.currentComparison;
                return { state: next, complete: false };
            }

            const winnerIndex = next.workingOrderIds.indexOf(next.winnerId);
            next.winnerIndex = winnerIndex;
            next.lowerBound = winnerIndex + 1;
            next.upperBound = next.workingOrderIds.length;
            next.currentComparison = null;
            next.stage = "place_loser";
            continue;
        }

        if (next.stage === "place_loser") {
            const result = advanceBinaryPlacement(next, next.loserId, comparisons, random);
            if (result.needsComparison) {
                return { state: next, complete: false };
            }

            next.workingOrderIds.splice(next.lowerBound, 0, next.loserId);
            next.lowerBound = 0;
            next.upperBound = 0;
            next.currentComparison = null;
            next.stage = "check_loser_left";
            continue;
        }

        if (next.stage === "check_loser_left") {
            const minIndex = next.winnerIndex === null ? 0 : next.winnerIndex + 1;
            const result = bubbleSubjectLeft(
                next.workingOrderIds,
                next.loserId,
                comparisons,
                minIndex
            );
            if (result.currentComparison) {
                next.currentComparison = result.currentComparison;
                return { state: next, complete: false };
            }

            next.stage = "check_loser_right";
            continue;
        }

        const result = bubbleSubjectRight(next.workingOrderIds, next.loserId, comparisons);
        if (result.currentComparison) {
            next.currentComparison = result.currentComparison;
            return { state: next, complete: false };
        }

        return { state: next, complete: true };
    }

    throw new Error("Binary repair did not converge");
}

function advanceBinaryPlacement(
    state: BinaryReinsertRepairState,
    subjectId: string,
    comparisons: RankingComparison[],
    random: () => number
) {
    while (state.lowerBound < state.upperBound) {
        if (state.currentComparison) {
            const pivotId = state.currentComparison.entryAId === subjectId
                ? state.currentComparison.entryBId
                : state.currentComparison.entryAId;
            const pivotIndex = state.workingOrderIds.indexOf(pivotId);
            if (pivotIndex < 0) {
                state.currentComparison = null;
                continue;
            }

            const winnerId = getCachedWinner(comparisons, subjectId, pivotId);
            if (!winnerId) {
                return { needsComparison: true };
            }

            if (winnerId === subjectId) {
                state.upperBound = pivotIndex;
            } else {
                state.lowerBound = pivotIndex + 1;
            }
            state.currentComparison = null;
            continue;
        }

        const pivotIndex = chooseBinaryPivot(state.lowerBound, state.upperBound, random);
        const pivotId = state.workingOrderIds[pivotIndex];
        if (!pivotId) {
            state.lowerBound = state.upperBound;
            break;
        }

        const winnerId = getCachedWinner(comparisons, subjectId, pivotId);
        if (!winnerId) {
            state.currentComparison = {
                entryAId: subjectId,
                entryBId: pivotId
            };
            return { needsComparison: true };
        }

        if (winnerId === subjectId) {
            state.upperBound = pivotIndex;
        } else {
            state.lowerBound = pivotIndex + 1;
        }
    }

    return { needsComparison: false };
}

function bubbleSubjectLeft(
    workingOrderIds: string[],
    subjectId: string,
    comparisons: RankingComparison[],
    minIndex = 0
) {
    while (true) {
        const index = workingOrderIds.indexOf(subjectId);
        if (index <= minIndex) {
            return { currentComparison: null };
        }

        const previousEntryId = workingOrderIds[index - 1];
        const winnerId = getCachedWinner(comparisons, subjectId, previousEntryId);
        if (!winnerId) {
            return {
                currentComparison: {
                    entryAId: subjectId,
                    entryBId: previousEntryId
                }
            };
        }

        if (winnerId !== subjectId) {
            return { currentComparison: null };
        }

        workingOrderIds[index - 1] = subjectId;
        workingOrderIds[index] = previousEntryId;
    }
}

function bubbleSubjectRight(
    workingOrderIds: string[],
    subjectId: string,
    comparisons: RankingComparison[]
) {
    while (true) {
        const index = workingOrderIds.indexOf(subjectId);
        if (index < 0 || index >= workingOrderIds.length - 1) {
            return { currentComparison: null };
        }

        const nextEntryId = workingOrderIds[index + 1];
        const winnerId = getCachedWinner(comparisons, subjectId, nextEntryId);
        if (!winnerId) {
            return {
                currentComparison: {
                    entryAId: subjectId,
                    entryBId: nextEntryId
                }
            };
        }

        if (winnerId !== nextEntryId) {
            return { currentComparison: null };
        }

        workingOrderIds[index] = nextEntryId;
        workingOrderIds[index + 1] = subjectId;
    }
}

function pickRepairGap(maxGap: number, random: () => number) {
    if (maxGap <= 1) {
        return 1;
    }

    if (random() >= 0.88) {
        return 1 + Math.floor(random() * maxGap);
    }

    const p = 0.4;
    const u = Math.min(Math.max(random(), Number.EPSILON), 1 - Number.EPSILON);
    const gap = 1 + Math.floor(Math.log(1 - u) / Math.log(1 - p));
    return Math.max(1, Math.min(maxGap, gap));
}

function sampleNormal(random: () => number) {
    const u1 = Math.min(Math.max(random(), Number.EPSILON), 1 - Number.EPSILON);
    const u2 = Math.min(Math.max(random(), Number.EPSILON), 1 - Number.EPSILON);
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clampIndex(index: number, length: number) {
    return Math.max(0, Math.min(length - 1, index));
}

function normalizeRecentPairs(value: unknown) {
    return Array.isArray(value)
        ? value.filter((pair): pair is string => typeof pair === "string").slice(0, RECENT_REPAIR_PAIR_LIMIT)
        : [];
}

function normalizeComparisons(value: unknown): RankingComparison[] {
    return Array.isArray(value)
        ? value
            .filter((comparison): comparison is RankingComparison =>
                typeof comparison === "object" &&
                comparison !== null &&
                "winnerId" in comparison &&
                "loserId" in comparison &&
                typeof comparison.winnerId === "string" &&
                typeof comparison.loserId === "string"
            )
            .map((comparison) => ({
                winnerId: comparison.winnerId,
                loserId: comparison.loserId
            }))
            .slice(0, 200)
        : [];
}

function normalizeCurrentCheck(value: unknown): RepairCurrentCheck | null {
    if (
        typeof value !== "object" ||
        value === null ||
        !("categoryId" in value) ||
        !("higherEntryId" in value) ||
        !("lowerEntryId" in value) ||
        !("gap" in value) ||
        typeof value.categoryId !== "string" ||
        typeof value.higherEntryId !== "string" ||
        typeof value.lowerEntryId !== "string" ||
        typeof value.gap !== "number"
    ) {
        return null;
    }

    return {
        categoryId: value.categoryId,
        higherEntryId: value.higherEntryId,
        lowerEntryId: value.lowerEntryId,
        gap: value.gap
    };
}

function normalizePairRepairState(value: unknown): PairRepairState | null {
    if (
        typeof value !== "object" ||
        value === null ||
        !("kind" in value) ||
        !("winnerId" in value) ||
        !("loserId" in value) ||
        !("workingOrderIds" in value) ||
        !Array.isArray(value.workingOrderIds) ||
        typeof value.winnerId !== "string" ||
        typeof value.loserId !== "string"
    ) {
        return null;
    }

    const base = {
        winnerId: value.winnerId,
        loserId: value.loserId,
        workingOrderIds: value.workingOrderIds.filter((id): id is string => typeof id === "string"),
        currentComparison: normalizeRepairPrompt("currentComparison" in value ? value.currentComparison : null)
    };

    if (value.kind === "adjacent" && "stage" in value) {
        return {
            kind: "adjacent",
            ...base,
            stage: value.stage === "loser_right" ? "loser_right" : "winner_left"
        };
    }

    if (value.kind === "binary_reinsert" && "stage" in value) {
        const stage = typeof value.stage === "string" &&
            [
                "place_winner",
                "check_winner_left",
                "check_winner_right",
                "place_loser",
                "check_loser_left",
                "check_loser_right"
            ].includes(value.stage)
            ? value.stage as BinaryReinsertRepairState["stage"]
            : "place_winner";

        return {
            kind: "binary_reinsert",
            ...base,
            stage,
            lowerBound: "lowerBound" in value && typeof value.lowerBound === "number" ? value.lowerBound : 0,
            upperBound: "upperBound" in value && typeof value.upperBound === "number" ? value.upperBound : base.workingOrderIds.length,
            winnerIndex: "winnerIndex" in value && typeof value.winnerIndex === "number" ? value.winnerIndex : null
        };
    }

    return null;
}

function normalizeRepairPrompt(value: unknown): RepairComparisonPrompt | null {
    return typeof value === "object" &&
        value !== null &&
        "entryAId" in value &&
        "entryBId" in value &&
        typeof value.entryAId === "string" &&
        typeof value.entryBId === "string"
        ? {
            entryAId: value.entryAId,
            entryBId: value.entryBId
        }
        : null;
}
