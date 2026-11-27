import type { DashboardData } from "@/lib/types";

const DATABASE_NAME = "goldshelf-client";
const STORE_NAME = "dashboard-snapshots";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const INVALIDATION_KEY = "goldshelf:private-cache-invalidated";
const blockedUsers = new Set<string>();
let blockAll = false;
let sessionGeneration: string | null = null;
function currentGeneration() {
    try { return window.localStorage.getItem(INVALIDATION_KEY); } catch { return null; }
}
function snapshotsBlocked(userId: string) {
    return blockedUsers.has(userId) || blockAll || currentGeneration() !== sessionGeneration;
}
let invalidationChannel: BroadcastChannel | null = null;
if (typeof window !== "undefined") {
    try {
        invalidationChannel = new BroadcastChannel(INVALIDATION_KEY);
        invalidationChannel.onmessage = (event: MessageEvent<{ userId: string | null }>) => {
            if (event.data.userId) blockedUsers.add(event.data.userId); else blockAll = true;
            window.location.assign("/signin");
        };
    } catch { /* Storage events remain available when channels are disabled. */ }
}

if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
        if (event.key !== INVALIDATION_KEY || !event.newValue) return;
        try {
            const { userId } = JSON.parse(event.newValue) as { userId: string | null };
            if (userId) blockedUsers.add(userId); else blockAll = true;
            window.location.assign("/signin");
        } catch { /* Ignore malformed storage events. */ }
    });
}

export function enableDashboardSnapshots(userId: string) {
    // Called only after a server-authenticated dashboard load.
    blockedUsers.delete(userId);
    blockAll = false;
    sessionGeneration = currentGeneration();
}

async function openDatabase(): Promise<IDBDatabase | null> {
    if (typeof window === "undefined") return null;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (database: IDBDatabase | null) => {
            if (settled) { database?.close(); return; }
            settled = true;
            clearTimeout(timer);
            resolve(database);
        };
        const timer = setTimeout(() => finish(null), 1500);
        try {
            const request = window.indexedDB.open(DATABASE_NAME, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME, { keyPath: "userId" });
                }
            };
            request.onsuccess = () => {
                const database = request.result;
                database.onversionchange = () => database.close();
                // Remove expired records for every user, not just the account
                // currently signed in on this shared browser.
                const cleanup = database.transaction(STORE_NAME, "readwrite");
                const cursor = cleanup.objectStore(STORE_NAME).openCursor();
                cursor.onsuccess = () => {
                    const row = cursor.result;
                    if (!row) return;
                    const savedAt = row.value?.savedAt;
                    if (!Number.isFinite(savedAt) || Date.now() - savedAt > MAX_AGE_MS) row.delete();
                    row.continue();
                };
                finish(database);
            };
            request.onerror = request.onblocked = () => finish(null);
        } catch { finish(null); }
    });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    const database = await openDatabase();
    if (!database) return null;
    try {
        return await new Promise<T | null>((resolve) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const request = run(transaction.objectStore(STORE_NAME));
            const timer = setTimeout(() => { transaction.abort(); resolve(null); }, 3000);
            transaction.oncomplete = () => { clearTimeout(timer); resolve(request.result ?? null); };
            transaction.onabort = transaction.onerror = () => { clearTimeout(timer); resolve(null); };
        });
    } catch { return null; }
    finally { database.close(); }
}

interface DashboardSnapshot { userId: string; savedAt: number; dashboard: DashboardData; }
export async function readDashboardSnapshot(userId: string, _revision?: string) {
    const snapshot = await withStore<DashboardSnapshot>("readonly", (store) => store.get(userId));
    if (!snapshot || snapshotsBlocked(userId)) return null;
    if (snapshot.userId !== userId || snapshot.dashboard?.profile?.userId !== userId ||
        !Array.isArray(snapshot.dashboard?.categories) ||
        !snapshot.dashboard.categories.every((category) => typeof category.id === "string" && Array.isArray(category.entries)) ||
        !Number.isFinite(snapshot.savedAt) ||
        Date.now() - snapshot.savedAt > MAX_AGE_MS) {
        await withStore("readwrite", (store) => store.delete(userId));
        return null;
    }
    return snapshot.dashboard;
}

export async function saveDashboardSnapshot(dashboard: DashboardData) {
    const userId = dashboard.profile.userId;
    if (snapshotsBlocked(userId)) return;
    await withStore<IDBValidKey | undefined>("readwrite", (store) => {
        if (snapshotsBlocked(userId)) return store.delete(userId) as IDBRequest<IDBValidKey | undefined>;
        return store.put({ userId, savedAt: Date.now(), dashboard } satisfies DashboardSnapshot) as IDBRequest<IDBValidKey | undefined>;
    });
}

export async function clearDashboardSnapshot(userId?: string) {
    if (userId) blockedUsers.add(userId); else blockAll = true;
    invalidationChannel?.postMessage({ userId: userId ?? null });
    try {
        window.localStorage.setItem(INVALIDATION_KEY, JSON.stringify({ userId: userId ?? null, nonce: crypto.randomUUID() }));
    } catch { /* Storage may be disabled. */ }
    await withStore("readwrite", (store) => userId ? store.delete(userId) : store.clear());
}
