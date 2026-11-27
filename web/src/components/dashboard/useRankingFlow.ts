import { useRef, useState } from "react";
export function useRankingFlow(initialActiveSessionId: string | null, initialActiveRepairSessionId: string | null,
    resetEntryFilters: () => void, stopQueueRanking: () => void) {
    const [activeSessionId, setActiveSessionIdState] = useState<string | null>(initialActiveSessionId);
    const activeSessionIdRef = useRef<string | null>(initialActiveSessionId);
    const closedBinarySessionIdsRef = useRef<Set<string>>(new Set());
    const [activeRepairSessionId, setActiveRepairSessionIdState] = useState<string | null>(initialActiveRepairSessionId);
    const activeRepairSessionIdRef = useRef<string | null>(initialActiveRepairSessionId);
    const closedRepairSessionIdsRef = useRef<Set<string>>(new Set());

    function setActiveBinarySessionId(sessionId: string | null) {
        activeSessionIdRef.current = sessionId;
        if (sessionId) {
            resetEntryFilters();
            setActiveRepairSessionId(null);
        }
        setActiveSessionIdState(sessionId);
    }

    function setActiveRepairSessionId(sessionId: string | null) {
        activeRepairSessionIdRef.current = sessionId;
        if (sessionId) {
            resetEntryFilters();
            setActiveBinarySessionId(null);
            stopQueueRanking();
        }
        setActiveRepairSessionIdState(sessionId);
    }

    function markBinarySessionClosed(sessionId: string | null) {
        if (sessionId) {
            closedBinarySessionIdsRef.current.add(sessionId);
        }
    }

    function markRepairSessionClosed(sessionId: string | null) {
        if (sessionId) {
            closedRepairSessionIdsRef.current.add(sessionId);
        }
    }



    return { activeSessionId, activeSessionIdRef, activeRepairSessionId, activeRepairSessionIdRef,
        closedBinarySessionIdsRef, closedRepairSessionIdsRef, setActiveBinarySessionId, setActiveRepairSessionId,
        markBinarySessionClosed, markRepairSessionClosed };
}
