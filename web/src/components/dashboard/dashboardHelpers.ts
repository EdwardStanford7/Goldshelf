import { currentDateTimestamp, dateInputToTimestamp } from "@/lib/format";
import type { ToastVariant } from "@/lib/toast";
import type {
    BinarySessionView,
    CancelBinarySessionMode,
    CategoryWithEntries,
    Entry,
    ParsedImport,
    QueuedEntry
} from "@/lib/types";

export interface ReversibleAction {
    id: number;
    undoToastMessage: string;
    redoToastMessage: string;
    variant?: ToastVariant;
    undo: () => Promise<string | void>;
    redo: () => Promise<string | void>;
}

export const UNDO_STACK_LIMIT = 20;
export const IDLE_RESUME_REFRESH_AFTER_MS = 15_000;
export const ACTIVE_FLOW_RESUME_REFRESH_AFTER_MS = 2_000;
export const TRANSIENT_REFRESH_RETRY_DELAYS_MS = [750, 1500, 3000, 5000] as const;
export const SIDEBAR_PANEL_CLASS =
    "grid h-fit min-h-max min-w-0 max-w-full content-start gap-[0.75rem] rounded-md border-2 border-primary/35 bg-card p-4 shadow-floating ring-1 ring-primary/15";

export type MobilePanel = "newEntry" | "queue";
export type EntryDateFilterPreset = "all" | "today" | "last7" | "last30" | "year" | "custom";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const ENTRY_DATE_FILTER_LABELS: Record<EntryDateFilterPreset, string> = {
    all: "All time",
    today: "Today",
    last7: "Last 7 days",
    last30: "Last 30 days",
    year: "This year",
    custom: "Custom range"
};

export function isEntryDateFilterActive(
    preset: EntryDateFilterPreset,
    customFrom: string,
    customTo: string
) {
    return preset !== "all" && (preset !== "custom" || Boolean(customFrom || customTo));
}

/** Apply an optimistic drag order unless it no longer matches the server list. */
export function applyDragOrder<T extends { id: string }>(items: T[], order: string[] | null): T[] {
    if (!order) {
        return items;
    }

    const byId = new Map(items.map((item) => [item.id, item]));
    const ordered = order
        .map((id) => byId.get(id))
        .filter((item): item is T => Boolean(item));
    return ordered.length === items.length ? ordered : items;
}

export function shuffledIds(entries: QueuedEntry[]) {
    const ids = entries.map((entry) => entry.id);
    for (let index = ids.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
    }
    return ids;
}

export function entryDateFilterRange(
    preset: EntryDateFilterPreset,
    customFrom: string,
    customTo: string
) {
    const today = currentDateTimestamp();
    const tomorrow = today + DAY_MS;
    const currentYear = new Date().getFullYear();

    if (preset === "today") return { start: today, end: tomorrow };
    if (preset === "last7") return { start: today - (6 * DAY_MS), end: tomorrow };
    if (preset === "last30") return { start: today - (29 * DAY_MS), end: tomorrow };
    if (preset === "year") return { start: Date.UTC(currentYear, 0, 1), end: Date.UTC(currentYear + 1, 0, 1) };
    if (preset === "custom") {
        const start = dateInputToTimestamp(customFrom);
        const customEnd = dateInputToTimestamp(customTo);
        return { start, end: customEnd === null ? null : customEnd + DAY_MS };
    }

    return { start: null, end: null };
}

export function entryMatchesDateRange(entry: Entry, range: { start: number | null; end: number | null }) {
    return (range.start === null || entry.createdAt >= range.start) &&
        (range.end === null || entry.createdAt < range.end);
}

function countEntriesInRange(entries: Entry[], range: { start: number | null; end: number | null }) {
    return entries.filter((entry) => entryMatchesDateRange(entry, range)).length;
}

export function categoryDateStats(category: CategoryWithEntries) {
    const entries = category.entries;
    const sortedDates = entries.map((entry) => entry.createdAt).sort((left, right) => left - right);
    return {
        total: entries.length,
        today: countEntriesInRange(entries, entryDateFilterRange("today", "", "")),
        last7: countEntriesInRange(entries, entryDateFilterRange("last7", "", "")),
        last30: countEntriesInRange(entries, entryDateFilterRange("last30", "", "")),
        year: countEntriesInRange(entries, entryDateFilterRange("year", "", "")),
        firstAddedAt: sortedDates[0] ?? null,
        newestAddedAt: sortedDates.at(-1) ?? null
    };
}

export interface ImportResult {
    importedCount: number;
    skippedCount: number;
    rankedImportedCount: number;
    rankedSkippedCount: number;
    queuedImportedCount: number;
    queuedSkippedCount: number;
}

export function importResultMessage(result: ImportResult) {
    const importedParts = [
        result.rankedImportedCount > 0 ? `${result.rankedImportedCount} ranked` : "",
        result.queuedImportedCount > 0 ? `${result.queuedImportedCount} queued` : ""
    ].filter(Boolean);
    const skippedParts = [
        result.rankedSkippedCount > 0 ? `${result.rankedSkippedCount} ranked` : "",
        result.queuedSkippedCount > 0 ? `${result.queuedSkippedCount} queued` : ""
    ].filter(Boolean);
    const importedMessage = importedParts.length > 0
        ? `Imported ${importedParts.join(" and ")} entries.`
        : "No new entries imported.";
    return skippedParts.length > 0
        ? `${importedMessage} Skipped ${skippedParts.join(" and ")} duplicates.`
        : importedMessage;
}

export function emptyImportResult(): ImportResult {
    return {
        importedCount: 0,
        skippedCount: 0,
        rankedImportedCount: 0,
        rankedSkippedCount: 0,
        queuedImportedCount: 0,
        queuedSkippedCount: 0
    };
}

export function addImportResult(total: ImportResult, next: ImportResult): ImportResult {
    return {
        importedCount: total.importedCount + next.importedCount,
        skippedCount: total.skippedCount + next.skippedCount,
        rankedImportedCount: total.rankedImportedCount + next.rankedImportedCount,
        rankedSkippedCount: total.rankedSkippedCount + next.rankedSkippedCount,
        queuedImportedCount: total.queuedImportedCount + next.queuedImportedCount,
        queuedSkippedCount: total.queuedSkippedCount + next.queuedSkippedCount
    };
}

export function chunkParsedImport(parsed: ParsedImport, size: number): ParsedImport[] {
    const chunks: ParsedImport[] = [];
    let entryIndex = 0;
    let queuedEntryIndex = 0;
    while (entryIndex < parsed.entries.length || queuedEntryIndex < parsed.queuedEntries.length) {
        const entries = parsed.entries.slice(entryIndex, entryIndex + size);
        entryIndex += entries.length;
        const remaining = size - entries.length;
        const queuedEntries = remaining > 0
            ? parsed.queuedEntries.slice(queuedEntryIndex, queuedEntryIndex + remaining)
            : [];
        queuedEntryIndex += queuedEntries.length;
        chunks.push({ entries, queuedEntries });
    }
    return chunks;
}

export function chunkItems<T>(items: T[], size: number) {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

export function cancelBinarySessionMessage(session: BinarySessionView, mode: CancelBinarySessionMode) {
    if (session.source === "rerank_entry") return `Cancelled reranking ${session.subject.name}.`;
    if (mode === "delete_queue") return `Cancelled ranking ${session.subject.name} and removed it from the queue.`;
    if (mode === "queue_new") return `Cancelled adding ${session.subject.name} and moved it to the queue.`;
    return session.queuedEntryId
        ? `Cancelled ranking ${session.subject.name} and returned it to the queue.`
        : `Cancelled adding ${session.subject.name}.`;
}
