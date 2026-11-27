import { useRef, useState, type MutableRefObject } from "react";
import { shuffledIds } from "./dashboardHelpers";
import type { DashboardData, QueuedEntry, QueueSettings } from "@/lib/types";
export function useQueueRanking({ queuedEntries, queueSettingsRef, activeFlowLocked, beginQueuedEntryRanking, startBusy, finishBusy, setMessage, setErrorMessage }: {
    queuedEntries: QueuedEntry[];
    queueSettingsRef: MutableRefObject<QueueSettings>;
    activeFlowLocked: boolean;
    beginQueuedEntryRanking: (entry: QueuedEntry) => Promise<{ result: { kind: string }; nextDashboard: DashboardData | null }>;
    startBusy: (label: string) => void; finishBusy: () => void;
    setMessage: (message: string | null) => void; setErrorMessage: (error: unknown) => void;
}) {
    const [queueRankMode, setQueueRankMode] = useState(false);
    const queueRankModeRef = useRef(false);
    const [queueRankCategoryId, setQueueRankCategoryId] = useState<string | null>(null);
    const queueRankCategoryIdRef = useRef<string | null>(null);
    const skippedQueueRankIdsRef = useRef<Set<string>>(new Set());
    const queueRankOrderRef = useRef<string[] | null>(null);
    function setQueueRankingActive(isActive: boolean, categoryId: string | null = queueRankCategoryIdRef.current) {
        queueRankModeRef.current = isActive;
        if (isActive) {
            queueRankCategoryIdRef.current = categoryId;
            setQueueRankCategoryId(categoryId);
        } else {
            skippedQueueRankIdsRef.current = new Set();
            queueRankOrderRef.current = null;
            queueRankCategoryIdRef.current = null;
            setQueueRankCategoryId(null);
        }
        setQueueRankMode(isActive);
    }

    function getRankableQueuedEntries(queuedEntries: QueuedEntry[], excludedQueuedEntryIds: Set<string> = new Set()) {
        const categoryScopeId = queueRankCategoryIdRef.current;
        return queuedEntries.filter((entry) =>
            !excludedQueuedEntryIds.has(entry.id) &&
            (!categoryScopeId || entry.categoryId === categoryScopeId)
        );
    }

    function buildQueueRankOrder(queuedEntries: QueuedEntry[], categoryId: string | null) {
        const rankableEntries = queuedEntries.filter((entry) =>
            !categoryId || entry.categoryId === categoryId
        );

        return queueSettingsRef.current.randomizeReadyEntries
            ? shuffledIds(rankableEntries)
            : rankableEntries.map((entry) => entry.id);
    }

    function getNextQueuedEntry(queuedEntries: QueuedEntry[]) {
        const rankableEntries = getRankableQueuedEntries(queuedEntries, skippedQueueRankIdsRef.current);
        if (rankableEntries.length === 0) {
            return null;
        }

        const rankableById = new Map(rankableEntries.map((entry) => [entry.id, entry]));
        const queueRankOrder = queueRankOrderRef.current;
        if (!queueRankOrder) {
            return rankableEntries[0] ?? null;
        }

        for (const queuedEntryId of queueRankOrder) {
            const queuedEntry = rankableById.get(queuedEntryId);
            if (queuedEntry) {
                return queuedEntry;
            }
        }

        const orderedIds = new Set(queueRankOrder);
        const newlyQueuedEntries = rankableEntries.filter((entry) => !orderedIds.has(entry.id));
        if (newlyQueuedEntries.length > 0) {
            queueRankOrder.push(...newlyQueuedEntries.map((entry) => entry.id));
            return newlyQueuedEntries[0] ?? null;
        }

        return null;
    }

    async function startNextQueuedRank(queuedEntries: QueuedEntry[]) {
        if (!queueRankModeRef.current) {
            return;
        }

        const nextEntry = getNextQueuedEntry(queuedEntries);
        if (!nextEntry) {
            const skippedCount = skippedQueueRankIdsRef.current.size;
            const categoryScopeId = queueRankCategoryIdRef.current;
            setQueueRankingActive(false);
            setMessage(categoryScopeId
                ? skippedCount > 0
                    ? "No unskipped queued entries remain in that category."
                    : "No queued entries remain in that category."
                : skippedCount > 0
                    ? "No unskipped queued entries remain."
                    : "No queued entries remain.");
            return;
        }

        startBusy("Starting queued rank...");
        setMessage(null);

        try {
            const { result, nextDashboard } = await beginQueuedEntryRanking(nextEntry);
            if (!nextDashboard) {
                setQueueRankingActive(false);
                return;
            }

            if (result.kind !== "session" && queueRankModeRef.current) {
                await startNextQueuedRank(nextDashboard.queuedEntries);
            }
        } catch (error) {
            setQueueRankingActive(false);
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleStartQueueRank(categoryId?: string) {
        const categoryScopeId = categoryId ?? null;
        skippedQueueRankIdsRef.current = new Set();
        queueRankOrderRef.current = buildQueueRankOrder(queuedEntries, categoryScopeId);
        setQueueRankingActive(true, categoryScopeId);
        await startNextQueuedRank(queuedEntries);
    }

    function handleStopQueueRank() {
        setQueueRankingActive(false);
        setMessage(activeFlowLocked ? "Queue ranking will stop after the current item." : "Queue ranking stopped.");
    }


    return { queueRankMode, queueRankModeRef, queueRankCategoryId, skippedQueueRankIdsRef,
        setQueueRankingActive, startNextQueuedRank, handleStartQueueRank, handleStopQueueRank };
}
