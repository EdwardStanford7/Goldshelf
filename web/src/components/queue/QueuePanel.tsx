import { useEffect, useState } from "react";
import { Square, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { QueuedEntryRow } from "@/components/queue/QueuedEntryRow";
import type { QueuedEntry } from "@/lib/types";

const METRIC_CLASS =
    "max-w-full min-w-0 whitespace-nowrap rounded-full border border-border px-[0.45rem] py-[0.15rem] text-[0.78rem] text-muted-foreground";

export function QueuePanel({
    activeSessionId,
    busy,
    queueRankMode,
    queuedEntries,
    onDelete,
    onPickImage,
    onRename,
    onStart,
    onStartQueue,
    onStopQueue
}: {
    activeSessionId: string | null;
    busy: boolean;
    queueRankMode: boolean;
    queuedEntries: QueuedEntry[];
    onDelete: (entry: QueuedEntry) => Promise<void>;
    onPickImage: (entry: QueuedEntry) => void;
    onRename: (entry: QueuedEntry, name: string) => Promise<void>;
    onStart: (entry: QueuedEntry) => Promise<void>;
    onStartQueue: () => Promise<void>;
    onStopQueue: () => void;
}) {
    const [currentTime, setCurrentTime] = useState(Date.now());

    useEffect(() => {
        const interval = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
        return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
        setCurrentTime(Date.now());
    }, [queuedEntries]);

    const readyEntries = queuedEntries.filter((entry) => entry.availableAt <= currentTime);
    const pendingEntries = queuedEntries.filter((entry) => entry.availableAt > currentTime);

    return (
        <section className="grid h-fit min-h-max min-w-0 max-w-full content-start gap-[0.9rem] rounded-md border-2 border-primary/35 bg-card p-4 shadow-floating ring-1 ring-primary/15">
            <div className="flex flex-wrap items-center justify-between gap-[0.7rem]">
                <strong className="min-w-0 max-w-full">Queue</strong>
                <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-[0.4rem]">
                    <span className={METRIC_CLASS}>{queuedEntries.length} queued</span>
                    <span className={METRIC_CLASS}>{readyEntries.length} ready</span>
                </div>
            </div>
            <div className="grid">
                <Button
                    size="lg"
                    variant={queueRankMode ? "outline" : "default"}
                    disabled={queueRankMode ? false : busy || Boolean(activeSessionId) || readyEntries.length === 0}
                    type="button"
                    onClick={() => {
                        if (queueRankMode) {
                            onStopQueue();
                        } else {
                            void onStartQueue();
                        }
                    }}
                >
                    {queueRankMode ? <Square data-icon="inline-start" /> : <Swords data-icon="inline-start" />}
                    <span>{queueRankMode ? "Stop Ranking Queue" : "Rank Queue"}</span>
                </Button>
            </div>

            {queuedEntries.length > 0 ? (
                <div className="grid max-h-[min(42vh,520px)] min-h-0 min-w-0 gap-[0.55rem] overflow-x-hidden overflow-y-auto pr-[0.15rem] max-[720px]:max-h-none max-[720px]:overflow-y-visible max-[720px]:pr-0">
                    {readyEntries.map((entry) => (
                        <QueuedEntryRow
                            metadataDisabled={busy}
                            entry={entry}
                            isReady
                            key={entry.id}
                            onDelete={onDelete}
                            onPickImage={onPickImage}
                            onRename={onRename}
                            rankLocked={busy || Boolean(activeSessionId)}
                            onStart={onStart}
                        />
                    ))}
                    {pendingEntries.map((entry) => (
                        <QueuedEntryRow
                            metadataDisabled={busy}
                            entry={entry}
                            isReady={false}
                            key={entry.id}
                            onDelete={onDelete}
                            onPickImage={onPickImage}
                            onRename={onRename}
                            rankLocked={busy || Boolean(activeSessionId)}
                            onStart={onStart}
                        />
                    ))}
                </div>
            ) : (
                <EmptyState compact icon={Swords} title="Queue Empty">
                    {activeSessionId
                        ? "Queue controls will return after the active ranking finishes."
                        : "Queued entries will appear here after you add them."}
                </EmptyState>
            )}
        </section>
    );
}
