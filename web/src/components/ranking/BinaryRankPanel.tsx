import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, ListPlus, MoreVertical, Pencil, SkipForward, Trash2, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger
} from "@/components/ui/context-menu";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { redirectIfUnauthorized } from "@/lib/errors";
import { errorMessage, isTransientRequestFailure } from "@/lib/format";
import { hasStoredImage, isNoImageKey, shouldPromptForImage } from "@/lib/images";
import { getBinarySession, submitBinaryWinner, undoBinaryMatch } from "@/server/rankingSessions";
import type { BinarySessionView, CancelBinarySessionMode, CategoryWithEntries, Entry } from "@/lib/types";

const RANK_PANEL_CLASS =
    "max-w-full min-w-0 rounded-md border border-border bg-card p-4 shadow-panel";
const STATUS_CLASS =
    "rounded-sm border-l-4 border-l-gold bg-status px-3 py-[0.6rem] whitespace-pre-line";
const POSTER_CLASS =
    "aspect-[4/5] bg-[image:linear-gradient(135deg,var(--poster-start),var(--poster-end))] text-center text-muted-foreground";

export function BinaryRankPanel({
    sessionId,
    imageRefreshVersion,
    onCancel,
    onComplete,
    onUnavailable,
    onNeedImage,
    onPickImage,
    onRename,
    onSkipQueued
}: {
    sessionId: string;
    imageRefreshVersion: number;
    onCancel: (session: BinarySessionView, mode?: CancelBinarySessionMode) => Promise<void>;
    onComplete: (sessionId: string) => Promise<void>;
    onUnavailable: (sessionId: string) => Promise<void>;
    onNeedImage: (entry: Entry, category: Pick<CategoryWithEntries, "id" | "name">) => void;
    onPickImage: (entry: Entry, category: Pick<CategoryWithEntries, "id" | "name">) => void;
    onRename: (entry: Entry, name: string) => Promise<void>;
    onSkipQueued: (session: BinarySessionView) => Promise<void>;
}) {
    const [session, setSession] = useState<BinarySessionView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const pendingTransientLoadRef = useRef(false);
    const [transientLoadRetryToken, setTransientLoadRetryToken] = useState(0);

    useEffect(() => {
        let isCurrent = true;
        setSession(null);
        setError(null);
        getBinarySession({ data: { sessionId } })
            .then((nextSession) => {
                if (!isCurrent) {
                    return;
                }

                if (!nextSession) {
                    void onUnavailable(sessionId);
                    return;
                }

                pendingTransientLoadRef.current = false;
                setSession(nextSession);
            })
            .catch((loadError) => {
                if (isCurrent && !redirectIfUnauthorized(loadError)) {
                    if (isUnavailableSessionError(loadError)) {
                        pendingTransientLoadRef.current = false;
                        void onUnavailable(sessionId);
                        return;
                    }

                    if (isTransientRequestFailure(loadError)) {
                        pendingTransientLoadRef.current = true;
                        setError(null);
                        return;
                    }

                    pendingTransientLoadRef.current = false;
                    setError(errorMessage(loadError));
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [sessionId, imageRefreshVersion, transientLoadRetryToken]);

    useEffect(() => {
        function retryPendingTransientLoad() {
            if (!pendingTransientLoadRef.current) {
                return;
            }

            pendingTransientLoadRef.current = false;
            setTransientLoadRetryToken((token) => token + 1);
        }

        function handleVisibilityChange() {
            if (document.visibilityState === "visible") {
                retryPendingTransientLoad();
            }
        }

        function handlePageShow() {
            retryPendingTransientLoad();
        }

        window.addEventListener("focus", retryPendingTransientLoad);
        window.addEventListener("online", retryPendingTransientLoad);
        window.addEventListener("pageshow", handlePageShow);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("focus", retryPendingTransientLoad);
            window.removeEventListener("online", retryPendingTransientLoad);
            window.removeEventListener("pageshow", handlePageShow);
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
            const result = await submitBinaryWinner({ data: { sessionId, winnerId } });
            if (result.kind === "completed") {
                await onComplete(sessionId);
                return;
            }

            const nextSession = await getBinarySession({ data: { sessionId } });
            if (!nextSession) {
                await onUnavailable(sessionId);
                return;
            }

            setSession(nextSession);
        } catch (submitError) {
            if (!redirectIfUnauthorized(submitError)) {
                if (isUnavailableSessionError(submitError)) {
                    await onUnavailable(sessionId);
                    return;
                }

                setError(errorMessage(submitError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function cancelRanking(mode: CancelBinarySessionMode = "default") {
        if (!session) {
            return;
        }

        setError(null);
        setSubmitting(true);
        try {
            await onCancel(session, mode);
        } catch (cancelError) {
            if (!redirectIfUnauthorized(cancelError)) {
                if (isUnavailableSessionError(cancelError)) {
                    await onUnavailable(sessionId);
                    return;
                }

                setError(errorMessage(cancelError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function skipQueuedRank() {
        if (!session) {
            return;
        }

        setError(null);
        setSubmitting(true);
        try {
            await onSkipQueued(session);
        } catch (skipError) {
            if (!redirectIfUnauthorized(skipError)) {
                if (isUnavailableSessionError(skipError)) {
                    await onUnavailable(sessionId);
                    return;
                }

                setError(errorMessage(skipError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function undoLastMatch() {
        setError(null);
        setSubmitting(true);
        try {
            await undoBinaryMatch({ data: { sessionId } });
            await reloadCurrentSession();
        } catch (undoError) {
            if (!redirectIfUnauthorized(undoError)) {
                if (isUnavailableSessionError(undoError)) {
                    await onUnavailable(sessionId);
                    return;
                }

                setError(errorMessage(undoError));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function reloadCurrentSession() {
        const nextSession = await getBinarySession({ data: { sessionId } });
        if (!nextSession) {
            await onUnavailable(sessionId);
            return null;
        }

        setSession(nextSession);
        return nextSession;
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
            await reloadCurrentSession();
            setRenamingEntryId(null);
        } catch (renameError) {
            if (!redirectIfUnauthorized(renameError)) {
                if (isUnavailableSessionError(renameError)) {
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
        return <section className={RANK_PANEL_CLASS}>Loading ranking...</section>;
    }

    const sessionActionState = {
        canCancelAdd: session.source === "new_entry",
        canQueueNewAdd: session.source === "new_entry" && !session.queuedEntryId,
        canDeleteQueuedAdd: session.source === "new_entry" && Boolean(session.queuedEntryId),
        canSkipQueuedAdd: session.source === "new_entry" && Boolean(session.queuedEntryId),
        canCancelRerank: session.source === "rerank_entry"
    };

    return (
        <section className={`${RANK_PANEL_CLASS} grid content-start gap-[0.9rem]`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-[0.7rem] max-[720px]:flex-col max-[720px]:items-stretch *:max-w-full *:min-w-0">
                <div>
                    <strong>
                        {rankPhaseLabel(session.phase)} · {session.categoryName}
                    </strong>
                    <p className="m-0 mt-[0.2rem] text-muted-foreground">
                        {session.phase === "binary"
                            ? `Range ${session.lowerBound + 1}-${session.upperBound + 1} · ${session.comparisonCount} comparisons`
                            : `${session.comparisonCount} comparisons`}
                    </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    {session.canUndoLastMatch ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={submitting}
                            type="button"
                            onClick={() => void undoLastMatch()}
                        >
                            <Undo2 data-icon="inline-start" />
                            <span>Undo Last Match</span>
                        </Button>
                    ) : null}
                    {sessionActionState.canSkipQueuedAdd ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={submitting}
                            type="button"
                            onClick={() => void skipQueuedRank()}
                        >
                            <SkipForward data-icon="inline-start" />
                            <span>Skip Queued Rank</span>
                        </Button>
                    ) : null}
                    {hasSessionActionMenu(sessionActionState) ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    aria-label="Ranking actions"
                                    disabled={submitting}
                                    size="icon-sm"
                                    type="button"
                                    variant="outline"
                                >
                                    <MoreVertical className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-60">
                                <SessionDropdownActions
                                    disabled={submitting}
                                    state={sessionActionState}
                                    onCancel={() => void cancelRanking()}
                                    onDeleteQueued={() => void cancelRanking("delete_queue")}
                                    onQueueNew={() => void cancelRanking("queue_new")}
                                    onSkipQueued={() => void skipQueuedRank()}
                                />
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                </div>
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-4 max-[720px]:grid-cols-1">
                {[session.subject, session.opponent].map((entry) => (
                    <MatchCard
                        disabled={submitting}
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
                        renderContextActions={() => hasSessionActionMenu(sessionActionState) ? (
                            <>
                                <ContextMenuSeparator />
                                <SessionContextActions
                                    disabled={submitting}
                                    state={sessionActionState}
                                    onCancel={() => void cancelRanking()}
                                    onDeleteQueued={() => void cancelRanking("delete_queue")}
                                    onQueueNew={() => void cancelRanking("queue_new")}
                                    onSkipQueued={() => void skipQueuedRank()}
                                />
                            </>
                        ) : null}
                        renderDropdownActions={() => hasSessionActionMenu(sessionActionState) ? (
                            <>
                                <DropdownMenuSeparator />
                                <SessionDropdownActions
                                    disabled={submitting}
                                    state={sessionActionState}
                                    onCancel={() => void cancelRanking()}
                                    onDeleteQueued={() => void cancelRanking("delete_queue")}
                                    onQueueNew={() => void cancelRanking("queue_new")}
                                    onSkipQueued={() => void skipQueuedRank()}
                                />
                            </>
                        ) : null}
                    />
                ))}
            </div>
        </section>
    );
}

function hasSessionActionMenu(state: SessionActionState) {
    return state.canCancelAdd ||
        state.canCancelRerank ||
        state.canDeleteQueuedAdd ||
        state.canQueueNewAdd ||
        state.canSkipQueuedAdd;
}

interface SessionActionState {
    canCancelAdd: boolean;
    canQueueNewAdd: boolean;
    canDeleteQueuedAdd: boolean;
    canSkipQueuedAdd: boolean;
    canCancelRerank: boolean;
}

function SessionDropdownActions({
    disabled,
    state,
    onCancel,
    onDeleteQueued,
    onQueueNew,
    onSkipQueued
}: {
    disabled: boolean;
    state: SessionActionState;
    onCancel: () => void;
    onDeleteQueued: () => void;
    onQueueNew: () => void;
    onSkipQueued: () => void;
}) {
    return (
        <>
            {state.canSkipQueuedAdd ? (
                <DropdownMenuItem disabled={disabled} onSelect={onSkipQueued}>
                    <SkipForward />Skip Queued Rank
                </DropdownMenuItem>
            ) : null}
            {state.canQueueNewAdd ? (
                <DropdownMenuItem disabled={disabled} onSelect={onQueueNew}>
                    <ListPlus />Cancel Add and Add to Queue
                </DropdownMenuItem>
            ) : null}
            {state.canDeleteQueuedAdd ? (
                <DropdownMenuItem disabled={disabled} variant="destructive" onSelect={onDeleteQueued}>
                    <Trash2 />Cancel Add and Delete from Queue
                </DropdownMenuItem>
            ) : null}
            {state.canCancelAdd || state.canCancelRerank ? (
                <DropdownMenuItem disabled={disabled} onSelect={onCancel}>
                    <XCircle />{state.canCancelRerank ? "Cancel Rerank" : "Cancel Add"}
                </DropdownMenuItem>
            ) : null}
        </>
    );
}

function SessionContextActions({
    disabled,
    state,
    onCancel,
    onDeleteQueued,
    onQueueNew,
    onSkipQueued
}: {
    disabled: boolean;
    state: SessionActionState;
    onCancel: () => void;
    onDeleteQueued: () => void;
    onQueueNew: () => void;
    onSkipQueued: () => void;
}) {
    return (
        <>
            {state.canSkipQueuedAdd ? (
                <ContextMenuItem disabled={disabled} onSelect={onSkipQueued}>
                    <SkipForward />Skip Queued Rank
                </ContextMenuItem>
            ) : null}
            {state.canQueueNewAdd ? (
                <ContextMenuItem disabled={disabled} onSelect={onQueueNew}>
                    <ListPlus />Cancel Add and Add to Queue
                </ContextMenuItem>
            ) : null}
            {state.canDeleteQueuedAdd ? (
                <ContextMenuItem disabled={disabled} variant="destructive" onSelect={onDeleteQueued}>
                    <Trash2 />Cancel Add and Delete from Queue
                </ContextMenuItem>
            ) : null}
            {state.canCancelAdd || state.canCancelRerank ? (
                <ContextMenuItem disabled={disabled} onSelect={onCancel}>
                    <XCircle />{state.canCancelRerank ? "Cancel Rerank" : "Cancel Add"}
                </ContextMenuItem>
            ) : null}
        </>
    );
}

function rankPhaseLabel(phase: BinarySessionView["phase"]) {
    if (phase === "local_repair") {
        return "Local Repair";
    }

    if (phase === "placement_check") {
        return "Placement Check";
    }

    return "Binary Rank";
}

function isUnavailableSessionError(error: unknown) {
    return error instanceof Error && /^Ranking session (not found|has no active matchup)/.test(error.message);
}

function MatchCard({
    disabled,
    entry,
    isRenaming,
    renameValue,
    onCancelRename,
    onChoose,
    onPickImage,
    onRenameValueChange,
    onStartRename,
    onSubmitRename,
    renderContextActions,
    renderDropdownActions
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
    renderContextActions: () => ReactNode;
    renderDropdownActions: () => ReactNode;
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
                <MatchPoster entry={entry} />
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
                        <MatchPoster entry={entry} />
                        <strong className="block p-[0.7rem] pr-11">{entry.name}</strong>
                    </button>
                    <DropdownMenu>
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
                            {renderDropdownActions()}
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
                {renderContextActions()}
            </ContextMenuContent>
        </ContextMenu>
    );
}

function MatchPoster({ entry }: { entry: Entry }) {
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
