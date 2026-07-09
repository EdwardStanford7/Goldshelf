import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, MoreVertical, Pencil, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger
} from "@/components/ui/context-menu";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { redirectIfUnauthorized } from "@/lib/errors";
import { errorMessage, isTransientRequestFailure } from "@/lib/format";
import { hasStoredImage, isNoImageKey, shouldPromptForImage } from "@/lib/images";
import type { CategoryWithEntries, Entry, RepairSessionView } from "@/lib/types";
import {
    getRepairSession,
    skipRepairMatchup,
    submitRepairWinner,
    undoRepairMatch
} from "@/server/repairSessions";

const REPAIR_PANEL_CLASS =
    "max-w-full min-w-0 rounded-md border border-border bg-card p-4 shadow-panel";
const STATUS_CLASS =
    "rounded-sm border-l-4 border-l-gold bg-status px-3 py-[0.6rem] whitespace-pre-line";
const POSTER_CLASS =
    "aspect-[4/5] bg-[image:linear-gradient(135deg,var(--poster-start),var(--poster-end))] text-center text-muted-foreground";
const TRANSIENT_SESSION_RETRY_DELAYS_MS = [750, 1500, 3000, 5000] as const;

export function RepairRankPanel({
    sessionId,
    imageRefreshVersion,
    onCancel,
    onComplete,
    onNeedImage,
    onPickImage,
    onRename,
    onUnavailable
}: {
    sessionId: string;
    imageRefreshVersion: number;
    onCancel: (session: RepairSessionView) => Promise<void>;
    onComplete: (sessionId: string) => Promise<void>;
    onNeedImage: (entry: Entry, category: Pick<CategoryWithEntries, "id" | "name">) => void;
    onPickImage: (entry: Entry, category: Pick<CategoryWithEntries, "id" | "name">) => void;
    onRename: (entry: Entry, name: string) => Promise<void>;
    onUnavailable: (sessionId: string) => Promise<void>;
}) {
    const [session, setSession] = useState<RepairSessionView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [recovering, setRecovering] = useState(false);
    const pendingTransientLoadRef = useRef(false);
    const transientLoadRetryTimerRef = useRef<number | null>(null);
    const transientLoadRetryAttemptRef = useRef(0);
    const [transientLoadRetryToken, setTransientLoadRetryToken] = useState(0);

    function clearTransientLoadRetryTimer() {
        if (transientLoadRetryTimerRef.current !== null) {
            window.clearTimeout(transientLoadRetryTimerRef.current);
            transientLoadRetryTimerRef.current = null;
        }
    }

    function resetTransientLoadRetry() {
        pendingTransientLoadRef.current = false;
        setRecovering(false);
        transientLoadRetryAttemptRef.current = 0;
        clearTransientLoadRetryTimer();
    }

    function retryPendingTransientLoad() {
        if (!pendingTransientLoadRef.current) {
            return;
        }

        clearTransientLoadRetryTimer();
        pendingTransientLoadRef.current = false;
        setTransientLoadRetryToken((token) => token + 1);
    }

    function scheduleTransientLoadRetry() {
        pendingTransientLoadRef.current = true;
        setRecovering(true);
        if (transientLoadRetryTimerRef.current !== null) {
            return;
        }

        const retryIndex = Math.min(
            transientLoadRetryAttemptRef.current,
            TRANSIENT_SESSION_RETRY_DELAYS_MS.length - 1
        );
        const retryDelay = TRANSIENT_SESSION_RETRY_DELAYS_MS[retryIndex];
        transientLoadRetryAttemptRef.current = Math.min(
            transientLoadRetryAttemptRef.current + 1,
            TRANSIENT_SESSION_RETRY_DELAYS_MS.length - 1
        );
        transientLoadRetryTimerRef.current = window.setTimeout(() => {
            transientLoadRetryTimerRef.current = null;
            retryPendingTransientLoad();
        }, retryDelay);
    }

    useEffect(() => {
        let isCurrent = true;
        setSession(null);
        setError(null);
        getRepairSession({ data: { sessionId } })
            .then((nextSession) => {
                if (!isCurrent) {
                    return;
                }

                if (!nextSession) {
                    void onUnavailable(sessionId);
                    return;
                }

                resetTransientLoadRetry();
                setSession(nextSession);
            })
            .catch((loadError) => {
                if (isCurrent && !redirectIfUnauthorized(loadError)) {
                    if (isUnavailableRepairError(loadError)) {
                        pendingTransientLoadRef.current = false;
                        void onUnavailable(sessionId);
                        return;
                    }

                    if (isTransientRequestFailure(loadError)) {
                        scheduleTransientLoadRetry();
                        setError(null);
                        return;
                    }

                    resetTransientLoadRetry();
                    setError(errorMessage(loadError));
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [sessionId, imageRefreshVersion, transientLoadRetryToken]);

    useEffect(() => {
        function handleVisibilityChange() {
            if (document.visibilityState === "visible") {
                retryPendingTransientLoad();
            }
        }

        window.addEventListener("focus", retryPendingTransientLoad);
        window.addEventListener("online", retryPendingTransientLoad);
        window.addEventListener("pageshow", retryPendingTransientLoad);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            clearTransientLoadRetryTimer();
            window.removeEventListener("focus", retryPendingTransientLoad);
            window.removeEventListener("online", retryPendingTransientLoad);
            window.removeEventListener("pageshow", retryPendingTransientLoad);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, []);

    useEffect(() => {
        if (!session) {
            return;
        }

        const missingImageEntry = shouldPromptForImage(session.subject.imageKey)
            ? session.subject
            : shouldPromptForImage(session.opponent.imageKey)
                ? session.opponent
                : null;

        if (missingImageEntry) {
            onNeedImage(missingImageEntry, {
                id: session.categoryId,
                name: session.categoryName
            });
        }
    }, [session, onNeedImage]);

    useEffect(() => {
        if (
            session &&
            renamingEntryId &&
            renamingEntryId !== session.subject.id &&
            renamingEntryId !== session.opponent.id
        ) {
            setRenamingEntryId(null);
        }
    }, [renamingEntryId, session]);

    async function chooseWinner(winnerId: string) {
        setError(null);
        setSubmitting(true);
        try {
            const result = await submitRepairWinner({ data: { sessionId, winnerId } });
            if (result.kind === "completed") {
                await onComplete(sessionId);
                return;
            }

            await reloadCurrentSession({ retryTransient: true });
        } catch (submitError) {
            if (!redirectIfUnauthorized(submitError)) {
                if (isUnavailableRepairError(submitError)) {
                    await onUnavailable(sessionId);
                    return;
                }

                if (isTransientRequestFailure(submitError)) {
                    scheduleTransientLoadRetry();
                    setError(null);
                    return;
                }

                setError(errorMessage(submitError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function skipCheck() {
        setError(null);
        setSubmitting(true);
        try {
            const result = await skipRepairMatchup({ data: { sessionId } });
            if (result.kind === "completed") {
                await onComplete(sessionId);
                return;
            }

            await reloadCurrentSession({ retryTransient: true });
        } catch (skipError) {
            if (!redirectIfUnauthorized(skipError)) {
                if (isTransientRequestFailure(skipError)) {
                    scheduleTransientLoadRetry();
                    setError(null);
                    return;
                }

                setError(errorMessage(skipError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function cancelRepair() {
        if (!session) {
            return;
        }

        setError(null);
        setSubmitting(true);
        try {
            await onCancel(session);
        } catch (cancelError) {
            if (!redirectIfUnauthorized(cancelError)) {
                if (isUnavailableRepairError(cancelError)) {
                    await onUnavailable(sessionId);
                    return;
                }

                setError(errorMessage(cancelError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function undoLastMatch() {
        setError(null);
        setSubmitting(true);
        try {
            await undoRepairMatch({ data: { sessionId } });
            await reloadCurrentSession({ retryTransient: true });
        } catch (undoError) {
            if (!redirectIfUnauthorized(undoError)) {
                if (isUnavailableRepairError(undoError)) {
                    await onUnavailable(sessionId);
                    return;
                }

                setError(errorMessage(undoError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function reloadCurrentSession(options: { retryTransient?: boolean } = {}) {
        try {
            const nextSession = await getRepairSession({ data: { sessionId } });
            if (!nextSession) {
                await onUnavailable(sessionId);
                return null;
            }

            resetTransientLoadRetry();
            setSession(nextSession);
            return nextSession;
        } catch (loadError) {
            if (options.retryTransient && isTransientRequestFailure(loadError)) {
                scheduleTransientLoadRetry();
                setError(null);
                return null;
            }

            throw loadError;
        }
    }

    async function submitRename(entry: Entry) {
        const cleanName = renameValue.trim();
        if (!cleanName || cleanName === entry.name) {
            setRenameValue(entry.name);
            setRenamingEntryId(null);
            return;
        }

        setError(null);
        setSubmitting(true);
        try {
            await onRename(entry, cleanName);
            await reloadCurrentSession({ retryTransient: true });
            setRenamingEntryId(null);
        } catch (renameError) {
            if (!redirectIfUnauthorized(renameError)) {
                if (isUnavailableRepairError(renameError)) {
                    await onUnavailable(sessionId);
                    return;
                }

                setError(errorMessage(renameError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    function startRename(entry: Entry) {
        setRenameValue(entry.name);
        setRenamingEntryId(entry.id);
    }

    if (error) {
        return <div className={STATUS_CLASS}>{error}</div>;
    }

    if (!session) {
        return <section className={REPAIR_PANEL_CLASS}>Loading repair mode...</section>;
    }

    const controlsDisabled = submitting || recovering;

    return (
        <section className={`${REPAIR_PANEL_CLASS} grid content-start gap-[0.9rem]`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-[0.7rem] max-[720px]:flex-col max-[720px]:items-stretch *:max-w-full *:min-w-0">
                <div>
                    <strong>
                        {repairPhaseLabel(session.phase)} · {session.categoryName}
                    </strong>
                    <p className="m-0 mt-[0.2rem] text-muted-foreground">
                        {repairSubtitle(session)}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {session.canUndoLastMatch ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={controlsDisabled}
                            type="button"
                            onClick={() => void undoLastMatch()}
                        >
                            <Undo2 data-icon="inline-start" />
                            <span>Undo Last Match</span>
                        </Button>
                    ) : null}
                    {session.phase === "checking" ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={controlsDisabled}
                            type="button"
                            onClick={() => void skipCheck()}
                        >
                            Skip
                        </Button>
                    ) : null}
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={controlsDisabled}
                        type="button"
                        onClick={() => void cancelRepair()}
                    >
                        Exit Repair Mode
                    </Button>
                </div>
            </div>
            {recovering ? (
                <div className={STATUS_CLASS}>Reconnecting...</div>
            ) : null}
            <div className="grid min-w-0 grid-cols-2 gap-4 max-[720px]:grid-cols-1">
                {[session.subject, session.opponent].map((entry) => (
                    <RepairMatchCard
                        disabled={controlsDisabled}
                        entry={entry}
                        isRenaming={renamingEntryId === entry.id}
                        key={entry.id}
                        renameValue={renameValue}
                        onCancelRename={() => {
                            setRenameValue(entry.name);
                            setRenamingEntryId(null);
                        }}
                        onChoose={() => void chooseWinner(entry.id)}
                        onPickImage={() => onPickImage(entry, {
                            id: session.categoryId,
                            name: session.categoryName
                        })}
                        onRenameValueChange={setRenameValue}
                        onStartRename={() => startRename(entry)}
                        onSubmitRename={() => void submitRename(entry)}
                    />
                ))}
            </div>
        </section>
    );
}

function repairPhaseLabel(phase: RepairSessionView["phase"]) {
    return phase === "checking" ? "Repair Check" : "Local Repair";
}

function repairSubtitle(session: RepairSessionView) {
    const counts = `${session.comparisonCount} comparisons · ${session.repairCount} repairs`;
    if (session.phase === "checking") {
        return `Spot check · ${counts}`;
    }

    return session.strategy === "binary_reinsert"
        ? `Re-placing entries · ${counts}`
        : `Repairing placement · ${counts}`;
}

function isUnavailableRepairError(error: unknown) {
    return error instanceof Error && /^Repair session (not found|has no active matchup)/.test(error.message);
}

function RepairMatchCard({
    disabled,
    entry,
    isRenaming,
    renameValue,
    onCancelRename,
    onChoose,
    onPickImage,
    onRenameValueChange,
    onStartRename,
    onSubmitRename
}: {
    disabled: boolean;
    entry: Entry;
    isRenaming: boolean;
    renameValue: string;
    onCancelRename: () => void;
    onChoose: () => void;
    onPickImage: () => void;
    onRenameValueChange: (value: string) => void;
    onStartRename: () => void;
    onSubmitRename: () => void;
}) {
    function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        onSubmitRename();
    }

    function stopActionEvent(event: { stopPropagation: () => void }) {
        event.stopPropagation();
    }

    if (isRenaming) {
        return (
            <article className="overflow-hidden rounded-md border border-border bg-card text-left">
                <RepairMatchPoster entry={entry} />
                <form className="grid gap-[0.6rem] p-[0.7rem]" onSubmit={handleRenameSubmit}>
                    <Input
                        autoFocus
                        aria-label={`Rename ${entry.name}`}
                        disabled={disabled}
                        value={renameValue}
                        onChange={(event) => onRenameValueChange(event.target.value)}
                    />
                    <div className="grid grid-cols-2 gap-[0.45rem]">
                        <Button size="sm" disabled={disabled} type="submit">Save</Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            type="button"
                            onClick={onCancelRename}
                        >
                            Cancel
                        </Button>
                    </div>
                </form>
            </article>
        );
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <article className="relative overflow-hidden rounded-md border border-border bg-card transition-colors hover:border-primary">
                    <button
                        className="block w-full cursor-pointer text-left disabled:cursor-not-allowed disabled:opacity-55"
                        disabled={disabled}
                        type="button"
                        onClick={onChoose}
                    >
                        <RepairMatchPoster entry={entry} />
                        <strong className="block p-[0.7rem] pr-11">{entry.name}</strong>
                    </button>
                    <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                            <Button
                                aria-label={`Actions for ${entry.name}`}
                                className="absolute top-2 right-2 z-20 hidden border-overlay-button-line bg-overlay-button text-overlay-button-ink hover:bg-overlay-button max-[720px]:inline-flex"
                                disabled={disabled}
                                size="icon-sm"
                                type="button"
                                variant="outline"
                                onClick={stopActionEvent}
                                onPointerDown={stopActionEvent}
                            >
                                <MoreVertical className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem disabled={disabled} onSelect={onStartRename}>
                                <Pencil />Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={disabled} onSelect={onPickImage}>
                                <ImageIcon />
                                {hasStoredImage(entry.imageKey) ? "Change Image" : "Pick Image"}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </article>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem disabled={disabled} onSelect={onStartRename}>
                    <Pencil />Rename
                </ContextMenuItem>
                <ContextMenuItem disabled={disabled} onSelect={onPickImage}>
                    <ImageIcon />
                    {hasStoredImage(entry.imageKey) ? "Change Image" : "Pick Image"}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

function RepairMatchPoster({ entry }: { entry: Entry }) {
    const [imageFailed, setImageFailed] = useState(false);

    useEffect(() => {
        setImageFailed(false);
    }, [entry.id, entry.imageKey]);

    if (hasStoredImage(entry.imageKey) && !imageFailed) {
        return (
            <img
                className={`${POSTER_CLASS} block h-auto w-full max-w-full object-cover`}
                src={`/api/images/${entry.id}?v=${encodeURIComponent(String(entry.imageKey))}`}
                alt=""
                decoding="async"
                onError={() => setImageFailed(true)}
            />
        );
    }

    return (
        <div className={`${POSTER_CLASS} grid content-center place-items-center gap-[0.35rem] p-4`}>
            <span className="text-[1rem] leading-tight">{entry.name}</span>
            <small className="text-[0.95rem] leading-tight text-muted-foreground">{isNoImageKey(entry.imageKey) ? "No image saved" : "No image"}</small>
        </div>
    );
}
