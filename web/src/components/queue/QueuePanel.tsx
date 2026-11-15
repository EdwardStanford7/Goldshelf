import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { ArrowRight, ListChecks, Search, Square, Swords, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { QueuedEntryRow } from "@/components/queue/QueuedEntryRow";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectTrigger,
    SelectValue
} from "@/components/ui/select";
import { nextMultiSelection } from "@/lib/multiSelect";
import type { QueuedEntry } from "@/lib/types";

const METRIC_CLASS =
    "max-w-full min-w-0 whitespace-nowrap rounded-full border border-border bg-background/60 px-[0.55rem] py-[0.2rem] text-[0.76rem] text-muted-foreground";

export function QueuePanel({
    activeSessionId,
    busy,
    queueRankCategoryId,
    queueRankMode,
    queuedEntries,
    onDelete,
    onDeleteSelected,
    onPickImage,
    onRename,
    onStart,
    onStartQueue,
    onStopQueue
}: {
    activeSessionId: string | null;
    busy: boolean;
    queueRankCategoryId: string | null;
    queueRankMode: boolean;
    queuedEntries: QueuedEntry[];
    onDelete: (entry: QueuedEntry) => Promise<void>;
    onDeleteSelected: (entries: QueuedEntry[]) => Promise<void>;
    onPickImage: (entry: QueuedEntry) => void;
    onRename: (entry: QueuedEntry, name: string) => Promise<void>;
    onStart: (entry: QueuedEntry) => Promise<void>;
    onStartQueue: (categoryId?: string) => Promise<void>;
    onStopQueue: () => void;
}) {
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
    const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [categoryFilterId, setCategoryFilterId] = useState("all");

    const categoryOptions = useMemo(() => {
        const categories = new Map<string, string>();
        for (const entry of queuedEntries) {
            categories.set(entry.categoryId, entry.categoryName);
        }

        return [...categories.entries()]
            .map(([id, name]) => ({ id, name }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }, [queuedEntries]);
    const selectedCategoryId = categoryFilterId === "all" ? null : categoryFilterId;
    const selectedCategoryName = selectedCategoryId
        ? categoryOptions.find((category) => category.id === selectedCategoryId)?.name ?? "Category"
        : null;
    const activeQueueRankCategoryName = queueRankCategoryId
        ? categoryOptions.find((category) => category.id === queueRankCategoryId)?.name ?? "Category"
        : null;
    const scopedQueuedEntries = selectedCategoryId
        ? queuedEntries.filter((entry) => entry.categoryId === selectedCategoryId)
        : queuedEntries;
    const searchTerm = searchQuery.trim().toLowerCase();
    const entryMatchesFilters = (entry: QueuedEntry) => {
        const matchesCategory = !selectedCategoryId || entry.categoryId === selectedCategoryId;
        const matchesSearch = !searchTerm ||
            entry.name.toLowerCase().includes(searchTerm) ||
            entry.categoryName.toLowerCase().includes(searchTerm);
        return matchesCategory && matchesSearch;
    };
    const visibleQueuedEntries = queuedEntries.filter(entryMatchesFilters);
    const displayedEntries = useMemo(
        () => visibleQueuedEntries,
        [visibleQueuedEntries]
    );
    const displayedEntryIds = displayedEntries.map((entry) => entry.id);
    const selectedEntries = queuedEntries.filter((entry) => selectedEntryIds.has(entry.id));

    useEffect(() => {
        const currentIds = new Set(queuedEntries.map((entry) => entry.id));
        setSelectedEntryIds((currentSelectedIds) => {
            const nextSelectedIds = new Set<string>();
            for (const id of currentSelectedIds) {
                if (currentIds.has(id)) {
                    nextSelectedIds.add(id);
                }
            }
            return nextSelectedIds;
        });
        if (selectionAnchorId && !currentIds.has(selectionAnchorId)) {
            setSelectionAnchorId(null);
        }
        if (queuedEntries.length === 0) {
            setSelectionMode(false);
        }
    }, [queuedEntries, selectionAnchorId]);

    useEffect(() => {
        if (categoryFilterId !== "all" && !categoryOptions.some((category) => category.id === categoryFilterId)) {
            setCategoryFilterId("all");
        }
    }, [categoryFilterId, categoryOptions]);

    function handleSelection(entry: QueuedEntry, event: MouseEvent<HTMLElement>, options: { forceAdditive?: boolean } = {}) {
        if (!selectionMode || busy) {
            return;
        }

        const nextSelection = nextMultiSelection({
            anchorId: selectionAnchorId,
            clickedId: entry.id,
            ctrlKey: options.forceAdditive ? true : event.ctrlKey,
            metaKey: event.metaKey,
            orderedIds: displayedEntryIds,
            plainBehavior: "focus-or-toggle",
            selectedIds: selectedEntryIds,
            shiftKey: event.shiftKey
        });
        setSelectedEntryIds(nextSelection.selectedIds);
        setSelectionAnchorId(nextSelection.anchorId);
    }

    async function removeSelected() {
        if (selectedEntries.length === 0 || busy) {
            return;
        }

        await onDeleteSelected(selectedEntries);
        setSelectedEntryIds(new Set());
        setSelectionAnchorId(null);
        setSelectionMode(false);
    }

    function closeSelectionMode() {
        setSelectionMode(false);
        setSelectedEntryIds(new Set());
        setSelectionAnchorId(null);
    }

    return (
        <section className="grid min-w-0 max-w-[88rem] content-start" data-testid="queue-panel">
            <div className="grid min-w-0 items-start gap-5 min-[721px]:grid-cols-[minmax(15rem,0.35fr)_minmax(0,0.65fr)]">
                <aside className="grid content-start gap-4 rounded-2xl border border-border bg-card/70 p-4 shadow-panel">
                    <div className="grid gap-1">
                        <span className="text-xs font-semibold tracking-[0.13em] text-muted-foreground uppercase">Ranking</span>
                        <strong className="font-[family-name:var(--app-font-display)] text-[1.3rem] font-normal">
                            {queueRankMode ? "Ranking in progress" : selectedCategoryName ?? "All categories"}
                        </strong>
                        <p className="m-0 text-sm leading-relaxed text-muted-foreground">
                            {queueRankMode
                                ? "Finish the current comparison on the rankings workspace, or stop this run."
                                : selectedCategoryName
                                    ? `${scopedQueuedEntries.length} queued ${scopedQueuedEntries.length === 1 ? "entry" : "entries"} from this shelf.`
                                    : `${scopedQueuedEntries.length} queued ${scopedQueuedEntries.length === 1 ? "entry" : "entries"} from all shelves.`}
                        </p>
                    </div>
                    <Button
                        className="justify-between"
                        size="lg"
                        variant={queueRankMode ? "outline" : "default"}
                        disabled={queueRankMode ? false : busy || Boolean(activeSessionId) || scopedQueuedEntries.length === 0}
                        type="button"
                        onClick={() => {
                            if (queueRankMode) {
                                onStopQueue();
                            } else {
                                void onStartQueue(selectedCategoryId ?? undefined);
                            }
                        }}
                    >
                        <span className="flex items-center gap-2">
                            {queueRankMode ? <Square /> : <Swords />}
                            {queueRankMode
                                ? activeQueueRankCategoryName
                                    ? `Stop Ranking ${activeQueueRankCategoryName}`
                                    : "Stop Ranking Queue"
                                : selectedCategoryName
                                    ? `Rank ${selectedCategoryName}`
                                    : "Rank Queue"}
                        </span>
                        <ArrowRight className="size-4" />
                    </Button>
                    {!selectionMode ? (
                        <Button
                            aria-label="Select"
                            className="justify-start"
                            disabled={busy || queuedEntries.length === 0}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => setSelectionMode(true)}
                        >
                            <ListChecks data-icon="inline-start" />
                            <span>Select entries</span>
                        </Button>
                    ) : null}
                </aside>

                <section className="grid min-w-0 gap-0 overflow-hidden rounded-2xl border border-border bg-card shadow-panel" aria-label="Queued entries">
                    <div className="grid gap-3 border-b border-border bg-muted/25 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="grid gap-0.5">
                                <strong className="font-[family-name:var(--app-font-display)] text-[1.25rem] font-normal">Queued entries</strong>
                                <span className="text-sm text-muted-foreground">Rank an entry now, or start ranking the queue.</span>
                            </div>
                            {selectionMode ? (
                                <span className={METRIC_CLASS}>{selectedEntries.length} selected</span>
                            ) : null}
                        </div>
                        {queuedEntries.length > 0 ? (
                            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(11rem,0.45fr)]">
                                <label className="relative block">
                                    <span className="sr-only">Search queue</span>
                                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        className="bg-background pl-9"
                                        placeholder="Search queue"
                                        value={searchQuery}
                                        onChange={(event) => setSearchQuery(event.target.value)}
                                    />
                                </label>
                                {categoryOptions.length > 1 ? (
                                    <Select value={categoryFilterId} onValueChange={setCategoryFilterId}>
                                        <SelectTrigger aria-label="Queue category filter" className="bg-background">
                                            <SelectValue placeholder="All categories" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectGroup>
                                                <SelectItem value="all">All categories</SelectItem>
                                                {categoryOptions.map((category) => (
                                                    <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>
                                                ))}
                                            </SelectGroup>
                                        </SelectContent>
                                    </Select>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

                    {selectionMode ? (
                        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/45 px-4 py-3">
                            <Button disabled={busy || selectedEntries.length === 0} size="sm" type="button" variant="destructive" onClick={() => void removeSelected()}>
                                <Trash2 data-icon="inline-start" />
                                <span>Remove selected</span>
                            </Button>
                            <Button
                                disabled={busy || selectedEntries.length === 0}
                                size="sm"
                                type="button"
                                variant="outline"
                                onClick={() => {
                                    setSelectedEntryIds(new Set());
                                    setSelectionAnchorId(null);
                                }}
                            >Clear</Button>
                            <Button disabled={busy} size="sm" type="button" variant="ghost" onClick={closeSelectionMode}>
                                <X data-icon="inline-start" />
                                <span>Done</span>
                            </Button>
                        </div>
                    ) : null}

                    <div className="grid min-w-0 gap-2 p-3 sm:p-4">
                        {queuedEntries.length > 0 && displayedEntries.length > 0 ? visibleQueuedEntries.map((entry) => (
                            <QueuedEntryRow
                                metadataDisabled={busy}
                                entry={entry}
                                key={entry.id}
                                onDelete={onDelete}
                                onPickImage={onPickImage}
                                onRename={onRename}
                                rankLocked={busy || Boolean(activeSessionId)}
                                selected={selectedEntryIds.has(entry.id)}
                                selectionMode={selectionMode}
                                onSelect={(event, options) => handleSelection(entry, event, options)}
                                onStart={onStart}
                            />
                        )) : queuedEntries.length > 0 ? (
                            <EmptyState compact icon={Search} title="No Queue Matches">Try another search or category.</EmptyState>
                        ) : (
                            <EmptyState compact icon={Swords} title="Queue Empty">
                                {activeSessionId
                                    ? "Queue controls will return after the active ranking finishes."
                                    : "Queued entries will appear here after you add them."}
                            </EmptyState>
                        )}
                    </div>
                </section>
            </div>
        </section>
    );
}
