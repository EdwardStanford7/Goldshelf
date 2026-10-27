import type { ImageSearchCandidate } from "./posterImage";

const SEARCH_CACHE_TTL_MS = 30 * 60 * 1_000;
const MAX_CACHED_SEARCHES = 24;

interface CachedSearch {
    candidates: ImageSearchCandidate[];
    expiresAt: number;
}

const searches = new Map<string, CachedSearch>();

function key(targetId: string, query: string) {
    return `${targetId}:${query.trim().toLowerCase()}`;
}

function evictExpiredSearches(now: number) {
    for (const [searchKey, search] of searches) {
        if (search.expiresAt <= now) {
            searches.delete(searchKey);
        }
    }
}

export function getCachedImageSearch(targetId: string, query: string) {
    const now = Date.now();
    evictExpiredSearches(now);
    const search = searches.get(key(targetId, query));
    return search?.candidates ?? null;
}

export function cacheImageSearch(targetId: string, query: string, candidates: ImageSearchCandidate[]) {
    const now = Date.now();
    evictExpiredSearches(now);
    const searchKey = key(targetId, query);
    searches.delete(searchKey);
    searches.set(searchKey, { candidates, expiresAt: now + SEARCH_CACHE_TTL_MS });

    while (searches.size > MAX_CACHED_SEARCHES) {
        const oldestKey = searches.keys().next().value;
        if (!oldestKey) {
            return;
        }
        searches.delete(oldestKey);
    }
}
