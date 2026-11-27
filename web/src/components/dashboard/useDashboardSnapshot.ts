import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { enableDashboardSnapshots, readDashboardSnapshot, saveDashboardSnapshot } from "@/lib/dashboardCache";
import type { DashboardData } from "@/lib/types";
function mergeCachedCategoryEntries(current: DashboardData, cached: DashboardData): DashboardData {
    if (
        current.profile.userId !== cached.profile.userId
    ) {
        return current;
    }

    const cachedCategories = new Map(cached.categories.map((category) => [category.id, category]));
    return {
        ...current,
        categories: current.categories.map((category) => {
            const cachedCategory = cachedCategories.get(category.id);
            return cachedCategory &&
                category.entries.length !== category.entryCount &&
                category.revision !== undefined && cachedCategory.revision === category.revision &&
                cachedCategory.entryCount === category.entryCount &&
                cachedCategory.entries.length === cachedCategory.entryCount
                ? { ...category, entries: cachedCategory.entries }
                : category;
        })
    };
}


export function useDashboardSnapshot(initialDashboard: DashboardData, dashboard: DashboardData, setDashboard: Dispatch<SetStateAction<DashboardData>>) {
    const dashboardSnapshotWriteTimerRef = useRef<number | null>(null);
    const [dashboardSnapshotReady, setDashboardSnapshotReady] = useState(false);
    const appliedInitial = useRef({ userId: initialDashboard.profile.userId, revision: initialDashboard.revision });
    // Keep fully loaded categories across reloads without trusting them over a
    // server response. A matching revision makes this a local read-through
    // cache for category switches; mutations and stale snapshots never win.
    useEffect(() => {
        let disposed = false;
        setDashboardSnapshotReady(false);
        // useState already contains the initial payload. Reapplying a fresh
        // object during hydration can keep replaying a pending state update.
        // Only reconcile when the router actually supplies a new revision.
        if (appliedInitial.current.userId !== initialDashboard.profile.userId ||
            appliedInitial.current.revision !== initialDashboard.revision) {
            appliedInitial.current = { userId: initialDashboard.profile.userId, revision: initialDashboard.revision };
            setDashboard((current) => mergeCachedCategoryEntries(initialDashboard, current));
        }
        enableDashboardSnapshots(initialDashboard.profile.userId);
        void readDashboardSnapshot(initialDashboard.profile.userId, initialDashboard.revision)
            .then((cachedDashboard) => {
                if (!disposed && cachedDashboard) {
                    setDashboard((currentDashboard) => mergeCachedCategoryEntries(currentDashboard, cachedDashboard));
                }
            })
            .finally(() => {
                if (!disposed) {
                    setDashboardSnapshotReady(true);
                }
            });

        return () => {
            disposed = true;
        };
    }, [initialDashboard.profile.userId, initialDashboard.revision]);

    // Debouncing avoids an IndexedDB write for every small optimistic state
    // update while still making the current tab's loaded lists durable.
    useEffect(() => {
        if (!dashboardSnapshotReady) {
            return;
        }
        if (dashboardSnapshotWriteTimerRef.current !== null) {
            window.clearTimeout(dashboardSnapshotWriteTimerRef.current);
        }
        dashboardSnapshotWriteTimerRef.current = window.setTimeout(() => {
            dashboardSnapshotWriteTimerRef.current = null;
            void saveDashboardSnapshot(dashboard);
        }, 300);

        return () => {
            if (dashboardSnapshotWriteTimerRef.current !== null) {
                window.clearTimeout(dashboardSnapshotWriteTimerRef.current);
                dashboardSnapshotWriteTimerRef.current = null;
            }
        };
    }, [dashboard, dashboardSnapshotReady]);


    return dashboardSnapshotReady;
}
