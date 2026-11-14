import type { DashboardData } from "@/lib/types";

const DATABASE_NAME = "goldshelf-client";
const STORE_NAME = "dashboard-snapshots";
const DATABASE_VERSION = 1;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface DashboardSnapshot {
    userId: string;
    revision: string;
    savedAt: number;
    dashboard: DashboardData;
}

function supportsIndexedDb() {
    return typeof window !== "undefined" && "indexedDB" in window;
}

function openDatabase(): Promise<IDBDatabase | null> {
    if (!supportsIndexedDb()) {
        return Promise.resolve(null);
    }

    try {
        return new Promise((resolve) => {
            const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: "userId" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        });
    } catch {
        // Private browsing and restrictive privacy settings can disable it.
        return Promise.resolve(null);
    }
}

async function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
    const database = await openDatabase();
    if (!database) {
        return null;
    }

    try {
        return await new Promise<T | null>((resolve) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const request = run(transaction.objectStore(STORE_NAME));
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => resolve(null);
            transaction.onabort = () => resolve(null);
        });
    } catch {
        return null;
    } finally {
        database.close();
    }
}

/**
 * Returns only a current snapshot for this user. The server revision remains
 * authoritative; this is a local read-through cache, never an offline source
 * for mutations.
 */
export async function readDashboardSnapshot(userId: string, revision: string) {
    const snapshot = await withStore<DashboardSnapshot>("readonly", (store) => store.get(userId));
    if (!snapshot) {
        return null;
    }

    if (
        snapshot.userId !== userId ||
        snapshot.revision !== revision ||
        Date.now() - snapshot.savedAt > MAX_AGE_MS
    ) {
        return null;
    }

    return snapshot.dashboard;
}

export async function saveDashboardSnapshot(dashboard: DashboardData) {
    const snapshot: DashboardSnapshot = {
        userId: dashboard.profile.userId,
        revision: dashboard.revision,
        savedAt: Date.now(),
        dashboard
    };
    await withStore("readwrite", (store) => store.put(snapshot));
}

export async function clearDashboardSnapshot(userId: string) {
    await withStore("readwrite", (store) => store.delete(userId));
}

