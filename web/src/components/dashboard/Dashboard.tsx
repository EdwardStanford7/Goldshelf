import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
    DndContext,
    DragOverlay,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent
} from "@dnd-kit/core";
import {
    SortableContext,
    arrayMove,
    rectSortingStrategy,
    verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { Library, Menu, Search, Swords, Wrench } from "lucide-react";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { BinaryRankPanel } from "@/components/ranking/BinaryRankPanel";
import { RepairRankPanel } from "@/components/ranking/RepairRankPanel";
import { Button } from "@/components/ui/button";
import { BrandLink } from "@/components/ui/BrandLink";
import { BusyOverlay } from "@/components/ui/BusyOverlay";
import { CategoryDragOverlay, CategoryListItem } from "@/components/dashboard/CategoryListItem";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntryCard, EntryDragOverlay } from "@/components/dashboard/EntryCard";
import { ImagePickerModal } from "@/components/ranking/ImagePickerModal";
import { ImportSpreadsheetToast } from "@/components/queue/ImportSpreadsheetToast";
import { Input } from "@/components/ui/input";
import { QueuePanel } from "@/components/queue/QueuePanel";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectTrigger,
    SelectValue
} from "@/components/ui/select";
import {
    Sheet,
    SheetBody,
    SheetCloseButton,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger
} from "@/components/ui/sheet";
import { showActionToast, showToast, type ToastVariant } from "@/lib/toast";
import { isEditableShortcutTarget, nextPaint } from "@/lib/dom";
import {
    isReorderNoop,
    placementForSortableMove,
    type DropPlacement
} from "@/lib/dragReorder";
import { redirectIfUnauthorized } from "@/lib/errors";
import {
    currentDateTimestamp,
    dateInputToTimestamp,
    errorMessage,
    formatDateTime,
    isTransientRequestFailure
} from "@/lib/format";
import { shouldPromptForImage } from "@/lib/images";
import { parseLegacyWorkbook, writeExportWorkbook } from "@/lib/importExport";
import type { ImagePickerTarget } from "@/lib/posterImage";
import { readInitialShowEntryPercentile, saveShowEntryPercentile } from "@/lib/preferences";
import { orderEntries } from "@/lib/ranking";
import {
    createCategory,
    deleteCategory,
    moveCategoryRelativeToCategory,
    renameCategory
} from "@/server/categories";
import { loadDashboard } from "@/server/dashboard";
import {
    createEntryWithBinaryRanking,
    deleteEntry,
    moveEntryRelativeToEntry,
    renameEntry,
    restoreEntry,
    startRerankEntry,
    switchEntryCategory
} from "@/server/entries";
import { importLegacyEntries } from "@/server/legacyImport";
import {
    createQueuedEntry,
    deleteQueuedEntry,
    deleteQueuedEntries,
    renameQueuedEntry,
    restoreQueuedEntry,
    restoreQueuedEntries,
    startQueuedEntryRanking,
    updateQueueSettings
} from "@/server/queue";
import { cancelBinarySession } from "@/server/rankingSessions";
import { cancelRepairSession, startRepairSession } from "@/server/repairSessions";
import { applyThemeMode, readInitialThemeMode, saveThemeMode, type ThemeMode } from "@/lib/theme";
import type {
    BinarySessionView,
    CancelBinarySessionMode,
    CategoryWithEntries,
    DashboardData,
    Entry,
    QueuedEntry,
    QueueSettings,
    RepairSessionView
} from "@/lib/types";

interface ReversibleAction {
    id: number;
    undoToastMessage: string;
    redoToastMessage: string;
    variant?: ToastVariant;
    undo: () => Promise<string | void>;
    redo: () => Promise<string | void>;
}

const UNDO_STACK_LIMIT = 20;
const RESUME_REFRESH_AFTER_MS = 5 * 60 * 1000;
const TRANSIENT_REFRESH_RETRY_DELAYS_MS = [750, 1500, 3000, 5000] as const;
const SIDEBAR_PANEL_CLASS =
    "grid h-fit min-h-max min-w-0 max-w-full content-start gap-[0.75rem] rounded-md border-2 border-primary/35 bg-card p-4 shadow-floating ring-1 ring-primary/15";

/**
 * Apply an optimistic drag ordering (a list of ids) on top of the canonical
 * items so a reorder shows immediately, before the server refresh lands. Falls
 * back to the canonical order if the id set no longer matches (e.g. after a
 * refresh adds/removes items).
 */
function applyDragOrder<T extends { id: string }>(items: T[], order: string[] | null): T[] {
    if (!order) {
        return items;
    }

    const byId = new Map(items.map((item) => [item.id, item]));
    const ordered = order
        .map((id) => byId.get(id))
        .filter((item): item is T => Boolean(item));
    return ordered.length === items.length ? ordered : items;
}

function orderQueuedEntries(entries: QueuedEntry[]) {
    return [...entries].sort((left, right) =>
        left.availableAt - right.availableAt ||
        left.createdAt - right.createdAt ||
        left.name.localeCompare(right.name)
    );
}

function importResultMessage(result: {
    importedCount: number;
    skippedCount: number;
    rankedImportedCount: number;
    rankedSkippedCount: number;
    queuedImportedCount: number;
    queuedSkippedCount: number;
}) {
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

function cancelBinarySessionMessage(
    session: BinarySessionView,
    mode: CancelBinarySessionMode
) {
    if (session.source === "rerank_entry") {
        return `Cancelled reranking ${session.subject.name}.`;
    }

    if (mode === "delete_queue") {
        return `Cancelled ranking ${session.subject.name} and removed it from the queue.`;
    }

    if (mode === "queue_new") {
        return `Cancelled adding ${session.subject.name} and moved it to the queue.`;
    }

    return session.queuedEntryId
        ? `Cancelled ranking ${session.subject.name} and returned it to the queue.`
        : `Cancelled adding ${session.subject.name}.`;
}

export function Dashboard({
    initialDashboard,
    userIsAdmin,
    userImage,
    userName
}: {
    initialDashboard: DashboardData;
    userIsAdmin: boolean;
    userImage: string | null;
    userName: string;
}) {
    const navigate = useNavigate();
    const initialActiveSessionId = initialDashboard.activeBinarySession?.id ?? null;
    const initialActiveRepairSessionId = initialDashboard.activeRepairSession?.id ?? null;
    const [dashboard, setDashboard] = useState(initialDashboard);
    const [selectedCategoryId, setSelectedCategoryId] = useState(
        initialDashboard.activeBinarySession?.categoryId ??
        initialDashboard.activeRepairSession?.categoryId ??
        initialDashboard.categories[0]?.id ??
        ""
    );
    const queueSettingsRef = useRef(initialDashboard.queueSettings);
    const lastResumeRefreshAtRef = useRef(Date.now());
    const resumeRefreshInFlightRef = useRef(false);
    const resumeRetryTimerRef = useRef<number | null>(null);
    const resumeRetryAttemptRef = useRef(0);
    const [entrySearch, setEntrySearch] = useState("");
    const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
    const [activeSessionId, setActiveSessionIdState] = useState<string | null>(initialActiveSessionId);
    const activeSessionIdRef = useRef<string | null>(initialActiveSessionId);
    const closedBinarySessionIdsRef = useRef<Set<string>>(new Set());
    const [activeRepairSessionId, setActiveRepairSessionIdState] = useState<string | null>(initialActiveRepairSessionId);
    const activeRepairSessionIdRef = useRef<string | null>(initialActiveRepairSessionId);
    const closedRepairSessionIdsRef = useRef<Set<string>>(new Set());
    const [queueRankMode, setQueueRankMode] = useState(false);
    const queueRankModeRef = useRef(false);
    const skippedQueueRankIdsRef = useRef<Set<string>>(new Set());
    const [categoryDraftName, setCategoryDraftName] = useState("");
    const [entryDraftName, setEntryDraftName] = useState("");
    const [entryCategoryId, setEntryCategoryId] = useState(
        initialDashboard.activeBinarySession?.categoryId ??
        initialDashboard.activeRepairSession?.categoryId ??
        initialDashboard.categories[0]?.id ??
        ""
    );
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const [busyLabel, setBusyLabel] = useState<string | null>(null);
    const [imagePickerTarget, setImagePickerTarget] = useState<ImagePickerTarget | null>(null);
    const [importToastOpen, setImportToastOpen] = useState(false);
    const [categoryDeleteTarget, setCategoryDeleteTarget] = useState<CategoryWithEntries | null>(null);
    const [imageRefreshVersion, setImageRefreshVersion] = useState(0);
    const [autoImagePromptedIds, setAutoImagePromptedIds] = useState<Set<string>>(() => new Set());
    const [themeMode, setThemeMode] = useState<ThemeMode>(() => readInitialThemeMode());
    const [showEntryPercentile, setShowEntryPercentile] = useState(() => readInitialShowEntryPercentile());
    const [currentUserName, setCurrentUserName] = useState(userName);
    const [currentUserImage, setCurrentUserImage] = useState(userImage);
    const [currentUserImageVersion, setCurrentUserImageVersion] = useState(0);
    // `active*Id` drives the floating DragOverlay; `*DragOrder` is the optimistic
    // post-drop ordering shown until the server refresh lands.
    const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
    const [entryDragOrder, setEntryDragOrder] = useState<string[] | null>(null);
    const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
    const [categoryDragOrder, setCategoryDragOrder] = useState<string[] | null>(null);
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } })
    );
    const mainRef = useRef<HTMLDivElement | null>(null);
    const reversibleActionIdRef = useRef(0);
    const undoStackRef = useRef<ReversibleAction[]>([]);
    const redoStackRef = useRef<ReversibleAction[]>([]);

    const selectedCategory = useMemo(
        () =>
            dashboard.categories.find((category) => category.id === selectedCategoryId) ??
            dashboard.categories[0] ??
            null,
        [dashboard.categories, selectedCategoryId]
    );
    const orderedCategories = useMemo(
        () => applyDragOrder(dashboard.categories, categoryDragOrder),
        [categoryDragOrder, dashboard.categories]
    );
    const displayedEntries = useMemo(() => {
        if (!selectedCategory) {
            return [];
        }

        const searchTerm = entrySearch.trim().toLowerCase();
        const entries = searchTerm
            ? selectedCategory.entries.filter((entry) => entry.name.toLowerCase().includes(searchTerm))
            : selectedCategory.entries;

        return orderEntries(entries);
    }, [entrySearch, selectedCategory]);
    const orderedEntries = useMemo(
        () => applyDragOrder(displayedEntries, entryDragOrder),
        [displayedEntries, entryDragOrder]
    );
    const canDragReorderEntries = Boolean(
        selectedCategory &&
        !activeSessionId &&
        !activeRepairSessionId &&
        !entrySearch.trim() &&
        selectedCategory.entries.length > 1
    );
    const activeFlowId = activeSessionId ?? activeRepairSessionId;
    const activeFlowLocked = Boolean(activeFlowId);
    const forceQueueNewEntry = activeFlowLocked || queueRankMode;
    const canDragReorderCategories = !busy && !activeFlowLocked && dashboard.categories.length > 1;
    const canCreateCategory = categoryDraftName.trim().length > 0;
    const canCreateEntry = entryDraftName.trim().length > 0;

    useEffect(() => {
        setEntryCategoryId(selectedCategory?.id ?? "");
    }, [selectedCategory?.id]);

    useEffect(() => {
        setActiveEntryId(null);
        setEntryDragOrder(null);
    }, [activeRepairSessionId, activeSessionId, entrySearch, selectedCategoryId]);

    useEffect(() => {
        if (!canDragReorderCategories) {
            setActiveCategoryId(null);
            setCategoryDragOrder(null);
        }
    }, [canDragReorderCategories]);

    function setActiveBinarySessionId(sessionId: string | null) {
        activeSessionIdRef.current = sessionId;
        if (sessionId) {
            setEntrySearch("");
            setActiveRepairSessionId(null);
        }
        setActiveSessionIdState(sessionId);
    }

    function setActiveRepairSessionId(sessionId: string | null) {
        activeRepairSessionIdRef.current = sessionId;
        if (sessionId) {
            setEntrySearch("");
            setActiveBinarySessionId(null);
            setQueueRankingActive(false);
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

    useEffect(() => {
        saveThemeMode(themeMode);
        return applyThemeMode(themeMode);
    }, [themeMode]);

    useEffect(() => {
        saveShowEntryPercentile(showEntryPercentile);
    }, [showEntryPercentile]);

    useEffect(() => {
        busyRef.current = busy;
    }, [busy]);

    useEffect(() => {
        setCurrentUserName(userName);
    }, [userName]);

    useEffect(() => {
        setCurrentUserImage(userImage);
        setCurrentUserImageVersion((version) => version + 1);
    }, [userImage]);

    useEffect(() => {
        setActiveEntryId(null);
        setEntryDragOrder(null);
    }, [selectedCategoryId]);

    useEffect(() => {
        if (!canDragReorderEntries) {
            setActiveEntryId(null);
            setEntryDragOrder(null);
        }
    }, [canDragReorderEntries]);

    useEffect(() => {
        if (
            !dashboard.activeBinarySession ||
            activeSessionId ||
            activeRepairSessionId ||
            closedBinarySessionIdsRef.current.has(dashboard.activeBinarySession.id)
        ) {
            return;
        }

        setActiveBinarySessionId(dashboard.activeBinarySession.id);
        setSelectedCategoryId(dashboard.activeBinarySession.categoryId);
    }, [activeRepairSessionId, activeSessionId, dashboard.activeBinarySession]);

    useEffect(() => {
        if (
            !dashboard.activeRepairSession ||
            activeSessionId ||
            activeRepairSessionId ||
            closedRepairSessionIdsRef.current.has(dashboard.activeRepairSession.id)
        ) {
            return;
        }

        setActiveRepairSessionId(dashboard.activeRepairSession.id);
        setSelectedCategoryId(dashboard.activeRepairSession.categoryId);
    }, [activeRepairSessionId, activeSessionId, dashboard.activeRepairSession]);

    async function refresh() {
        const nextDashboard = await loadDashboard();
        lastResumeRefreshAtRef.current = Date.now();
        queueSettingsRef.current = nextDashboard.queueSettings;
        setDashboard(nextDashboard);
        return nextDashboard;
    }

    function clearResumeRetryTimer() {
        if (resumeRetryTimerRef.current !== null) {
            window.clearTimeout(resumeRetryTimerRef.current);
            resumeRetryTimerRef.current = null;
        }
    }

    function resetResumeRetry() {
        resumeRetryAttemptRef.current = 0;
        clearResumeRetryTimer();
    }

    function scheduleResumeRefreshRetry() {
        if (resumeRetryTimerRef.current !== null) {
            return;
        }

        const retryIndex = Math.min(
            resumeRetryAttemptRef.current,
            TRANSIENT_REFRESH_RETRY_DELAYS_MS.length - 1
        );
        const retryDelay = TRANSIENT_REFRESH_RETRY_DELAYS_MS[retryIndex];
        resumeRetryAttemptRef.current = Math.min(
            resumeRetryAttemptRef.current + 1,
            TRANSIENT_REFRESH_RETRY_DELAYS_MS.length - 1
        );
        resumeRetryTimerRef.current = window.setTimeout(() => {
            resumeRetryTimerRef.current = null;
            void refreshAfterResume(true);
        }, retryDelay);
    }

    function handleTransientDashboardRefreshError(error: unknown) {
        if (!isTransientRequestFailure(error)) {
            return false;
        }

        scheduleResumeRefreshRetry();
        return true;
    }

    async function refreshAfterMutation() {
        try {
            return await refresh();
        } catch (error) {
            if (handleTransientDashboardRefreshError(error)) {
                return null;
            }

            throw error;
        }
    }

    function reconcileActiveRankingAfterResume(nextDashboard: DashboardData) {
        const currentSessionId = activeSessionIdRef.current;
        const serverSession = nextDashboard.activeBinarySession;
        if (!currentSessionId) {
            if (serverSession && !closedBinarySessionIdsRef.current.has(serverSession.id)) {
                setActiveBinarySessionId(serverSession.id);
                setSelectedCategoryId(serverSession.categoryId);
            }
            return;
        }

        if (serverSession?.id === currentSessionId) {
            setSelectedCategoryId(serverSession.categoryId);
            return;
        }

        markBinarySessionClosed(currentSessionId);
        setActiveBinarySessionId(null);
        setQueueRankingActive(false);

        if (serverSession && !closedBinarySessionIdsRef.current.has(serverSession.id)) {
            setActiveBinarySessionId(serverSession.id);
            setSelectedCategoryId(serverSession.categoryId);
            return;
        }

        setMessage("That ranking is no longer active.", "danger");
    }

    function reconcileActiveRepairAfterResume(nextDashboard: DashboardData) {
        const currentSessionId = activeRepairSessionIdRef.current;
        const serverSession = nextDashboard.activeRepairSession;
        if (!currentSessionId) {
            if (
                !activeSessionIdRef.current &&
                serverSession &&
                !closedRepairSessionIdsRef.current.has(serverSession.id)
            ) {
                setActiveRepairSessionId(serverSession.id);
                setSelectedCategoryId(serverSession.categoryId);
            }
            return;
        }

        if (serverSession?.id === currentSessionId) {
            setSelectedCategoryId(serverSession.categoryId);
            return;
        }

        markRepairSessionClosed(currentSessionId);
        setActiveRepairSessionId(null);

        if (
            !activeSessionIdRef.current &&
            serverSession &&
            !closedRepairSessionIdsRef.current.has(serverSession.id)
        ) {
            setActiveRepairSessionId(serverSession.id);
            setSelectedCategoryId(serverSession.categoryId);
            return;
        }

        setMessage("That repair mode session is no longer active.", "danger");
    }

    async function refreshAfterResume(force = false) {
        if (
            busyRef.current ||
            resumeRefreshInFlightRef.current ||
            (!force && Date.now() - lastResumeRefreshAtRef.current < RESUME_REFRESH_AFTER_MS)
        ) {
            return;
        }

        resumeRefreshInFlightRef.current = true;
        try {
            const nextDashboard = await refresh();
            resetResumeRetry();
            reconcileActiveRankingAfterResume(nextDashboard);
            reconcileActiveRepairAfterResume(nextDashboard);
        } catch (error) {
            if (redirectIfUnauthorized(error)) {
                return;
            }

            if (!handleTransientDashboardRefreshError(error)) {
                setErrorMessage(error);
            }
        } finally {
            resumeRefreshInFlightRef.current = false;
        }
    }

    useEffect(() => {

        function handleFocus() {
            void refreshAfterResume();
        }

        function handleVisibilityChange() {
            if (document.visibilityState === "visible") {
                void refreshAfterResume();
            }
        }

        function handlePageShow(event: PageTransitionEvent) {
            void refreshAfterResume(event.persisted);
        }

        function handleOnline() {
            void refreshAfterResume(true);
        }

        window.addEventListener("focus", handleFocus);
        window.addEventListener("pageshow", handlePageShow);
        window.addEventListener("online", handleOnline);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            clearResumeRetryTimer();
            window.removeEventListener("focus", handleFocus);
            window.removeEventListener("pageshow", handlePageShow);
            window.removeEventListener("online", handleOnline);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, []);

    function setQueueRankingActive(isActive: boolean) {
        queueRankModeRef.current = isActive;
        if (!isActive) {
            skippedQueueRankIdsRef.current = new Set();
        }
        setQueueRankMode(isActive);
    }

    function startBusy(label: string) {
        busyRef.current = true;
        setBusy(true);
        setBusyLabel(label);
    }

    function finishBusy() {
        busyRef.current = false;
        setBusy(false);
        setBusyLabel(null);
    }

    function scrollMainToTop() {
        window.requestAnimationFrame(() => {
            mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
    }

    function pushToast(toast: {
        message: string;
        variant?: ToastVariant;
        actionLabel?: string;
        onAction?: () => Promise<void> | void;
    }) {
        if (toast.actionLabel && toast.onAction) {
            showActionToast(toast.message, {
                variant: toast.variant,
                actionLabel: toast.actionLabel,
                onAction: toast.onAction
            });
        } else {
            showToast(toast.message, toast.variant);
        }
    }

    function setMessage(message: string | null, variant: ToastVariant = "default") {
        showToast(message, variant);
    }

    function setErrorMessage(error: unknown) {
        if (redirectIfUnauthorized(error)) {
            return;
        }

        setMessage(errorMessage(error), "danger");
    }

    function takeReversibleAction(stack: ReversibleAction[], actionId?: number) {
        const actionIndex = actionId === undefined
            ? stack.length - 1
            : stack.findIndex((action) => action.id === actionId);
        if (actionIndex < 0) {
            return { action: null, nextStack: stack };
        }

        return {
            action: stack[actionIndex],
            nextStack: [
                ...stack.slice(0, actionIndex),
                ...stack.slice(actionIndex + 1)
            ]
        };
    }

    function addReversibleAction(stack: ReversibleAction[], action: ReversibleAction) {
        return [...stack, action].slice(-UNDO_STACK_LIMIT);
    }

    function registerReversibleAction(actionOptions: Omit<ReversibleAction, "id">) {
        const action = {
            ...actionOptions,
            id: reversibleActionIdRef.current + 1
        };
        reversibleActionIdRef.current = action.id;
        undoStackRef.current = addReversibleAction(undoStackRef.current, action);
        redoStackRef.current = [];

        pushToast({
            actionLabel: "Undo",
            message: action.redoToastMessage,
            onAction: () => performUndo(action.id),
            variant: action.variant
        });
    }

    async function performUndo(actionId?: number) {
        if (busyRef.current) {
            return;
        }

        const { action, nextStack } = takeReversibleAction(undoStackRef.current, actionId);
        if (!action) {
            return;
        }

        startBusy("Undoing...");
        setMessage(null);

        try {
            const message = await action.undo();
            undoStackRef.current = nextStack;
            redoStackRef.current = addReversibleAction(redoStackRef.current, action);
            pushToast({
                actionLabel: "Redo",
                message: message ?? action.undoToastMessage,
                onAction: () => performRedo(action.id),
                variant: "success"
            });
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function performRedo(actionId?: number) {
        if (busyRef.current) {
            return;
        }

        const { action, nextStack } = takeReversibleAction(redoStackRef.current, actionId);
        if (!action) {
            return;
        }

        startBusy("Redoing...");
        setMessage(null);

        try {
            const message = await action.redo();
            redoStackRef.current = nextStack;
            undoStackRef.current = addReversibleAction(undoStackRef.current, action);
            pushToast({
                actionLabel: "Undo",
                message: message ?? action.redoToastMessage,
                onAction: () => performUndo(action.id),
                variant: action.variant
            });
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    useEffect(() => {
        function handleUndoRedoShortcut(event: KeyboardEvent) {
            if (
                event.defaultPrevented ||
                event.altKey ||
                !(event.metaKey || event.ctrlKey) ||
                isEditableShortcutTarget(event.target)
            ) {
                return;
            }

            const key = event.key.toLowerCase();
            const isUndo = key === "z" && !event.shiftKey;
            const isRedo = (key === "z" && event.shiftKey) || key === "y";
            if (!isUndo && !isRedo) {
                return;
            }

            event.preventDefault();
            if (isRedo) {
                void performRedo();
            } else {
                void performUndo();
            }
        }

        document.addEventListener("keydown", handleUndoRedoShortcut);
        return () => document.removeEventListener("keydown", handleUndoRedoShortcut);
    }, []);

    const requestImageForMatch = useCallback(
        (entry: Entry, category: Pick<CategoryWithEntries, "id" | "name">) => {
            if (
                !dashboard.queueSettings.promptForMissingImages ||
                !shouldPromptForImage(entry.imageKey) ||
                imagePickerTarget ||
                autoImagePromptedIds.has(entry.id)
            ) {
                return;
            }

            setAutoImagePromptedIds((promptedIds) => new Set(promptedIds).add(entry.id));
            setImagePickerTarget({ kind: "entry", item: entry, category });
        },
        [autoImagePromptedIds, dashboard.queueSettings.promptForMissingImages, imagePickerTarget]
    );

    async function handleImageSaved() {
        setImagePickerTarget(null);
        setImageRefreshVersion((version) => version + 1);
        await refreshAfterMutation();
    }

    async function handleCreateCategory(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const formElement = event.currentTarget;
        startBusy("Adding category...");
        setMessage(null);
        const form = new FormData(formElement);

        try {
            const categoryId = await createCategory({
                data: {
                    name: String(form.get("name") ?? ""),
                    isPublic: form.get("isPublic") === "on"
                }
            });
            formElement.reset();
            setCategoryDraftName("");
            setSelectedCategoryId(categoryId);
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleRenameCategory(categoryId: string, name: string) {
        startBusy("Renaming category...");
        setMessage(null);

        try {
            await renameCategory({ data: { categoryId, name } });
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    function handleCategoryDragStart(event: DragStartEvent) {
        setActiveCategoryId(String(event.active.id));
    }

    function handleCategoryDragCancel() {
        setActiveCategoryId(null);
    }

    function handleCategoryDragEnd(event: DragEndEvent) {
        setActiveCategoryId(null);
        const { active, over } = event;
        if (!over || active.id === over.id) {
            return;
        }

        const ids = dashboard.categories.map((category) => category.id);
        const oldIndex = ids.indexOf(String(active.id));
        const newIndex = ids.indexOf(String(over.id));
        if (oldIndex < 0 || newIndex < 0) {
            return;
        }

        setCategoryDragOrder(arrayMove(ids, oldIndex, newIndex));
        void handleMoveCategoryRelativeToCategory(
            String(active.id),
            String(over.id),
            placementForSortableMove(oldIndex, newIndex)
        );
    }

    async function handleMoveCategoryRelativeToCategory(
        categoryId: string,
        targetCategoryId: string,
        placement: DropPlacement
    ) {
        if (categoryId === targetCategoryId) {
            setCategoryDragOrder(null);
            return;
        }

        const orderedCategoryIds = dashboard.categories.map((category) => category.id);
        const originalCategoryIndex = orderedCategoryIds.indexOf(categoryId);
        if (isReorderNoop(orderedCategoryIds, categoryId, targetCategoryId, placement)) {
            setCategoryDragOrder(null);
            return;
        }

        const previousCategoryId = originalCategoryIndex > 0 ? orderedCategoryIds[originalCategoryIndex - 1] : null;
        const nextCategoryId = originalCategoryIndex >= 0 ? orderedCategoryIds[originalCategoryIndex + 1] ?? null : null;
        startBusy("Reordering categories...");
        setMessage(null);

        try {
            const result = await moveCategoryRelativeToCategoryForHistory(categoryId, targetCategoryId, placement);
            if (result.moved && originalCategoryIndex >= 0) {
                registerReversibleAction({
                    redo: () => moveCategoryRelativeToCategoryForHistory(categoryId, targetCategoryId, placement).then(() => undefined),
                    redoToastMessage: "Reordered categories.",
                    undo: () => restoreCategoryOrderForHistory(categoryId, previousCategoryId, nextCategoryId),
                    undoToastMessage: "Restored the previous category order.",
                    variant: "success"
                });
            }
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
            setCategoryDragOrder(null);
        }
    }

    async function moveCategoryRelativeToCategoryForHistory(
        categoryId: string,
        targetCategoryId: string,
        placement: DropPlacement
    ) {
        const result = await moveCategoryRelativeToCategory({ data: { categoryId, targetCategoryId, placement } });
        await refreshAfterMutation();
        return result;
    }

    async function restoreCategoryOrderForHistory(
        categoryId: string,
        previousCategoryId: string | null,
        nextCategoryId: string | null
    ) {
        if (nextCategoryId) {
            await moveCategoryRelativeToCategoryForHistory(categoryId, nextCategoryId, "before");
            return;
        }

        if (previousCategoryId) {
            await moveCategoryRelativeToCategoryForHistory(categoryId, previousCategoryId, "after");
            return;
        }

        await refresh();
    }

    async function handleDeleteCategory(category: CategoryWithEntries) {
        const nextCategory = dashboard.categories.find((candidate) => candidate.id !== category.id);
        setCategoryDeleteTarget(null);
        startBusy("Deleting category...");
        setMessage(null);

        try {
            await deleteCategory({ data: { categoryId: category.id } });
            setSelectedCategoryId(nextCategory?.id ?? "");
            await refreshAfterMutation();
            pushToast({
                message: `Deleted ${category.name}.`,
                variant: "danger"
            });
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleCreateEntry(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const formElement = event.currentTarget;
        if (dashboard.categories.length === 0) {
            return;
        }

        setMessage(null);
        const form = new FormData(formElement);
        const name = String(form.get("name") ?? "");
        const cleanName = name.trim();
        const targetCategoryId = entryCategoryId || selectedCategory?.id || "";
        const targetCategory = dashboard.categories.find((category) => category.id === targetCategoryId);
        if (!cleanName || !targetCategory) {
            setMessage("Choose a category and enter a name.", "danger");
            return;
        }

        startBusy("Adding entry...");
        const addedAt = currentDateTimestamp();
        const queueSettings = queueSettingsRef.current;

        try {
            const shouldQueueEntry = queueSettings.enabled || forceQueueNewEntry;
            if (shouldQueueEntry) {
                const result = await createQueuedEntry({
                    data: {
                        categoryId: targetCategory.id,
                        name: cleanName,
                        createdAt: addedAt
                    }
                });
                formElement.reset();
                setEntryDraftName("");
                setEntryCategoryId(targetCategory.id);
                setMessage(`Queued ${cleanName} for ranking on ${formatDateTime(result.availableAt)}.`);
                setDashboard((currentDashboard) => ({
                    ...currentDashboard,
                    queuedEntries: orderQueuedEntries([
                        ...currentDashboard.queuedEntries.filter((entry) => entry.id !== result.queuedEntry.id),
                        result.queuedEntry
                    ])
                }));
                if (queueSettings.promptForMissingImages) {
                    setImagePickerTarget({
                        kind: "queue",
                        item: {
                            id: result.queuedEntry.id,
                            name: result.queuedEntry.name,
                            imageKey: result.queuedEntry.imageKey
                        },
                        category: targetCategory
                    });
                }
                return;
            }

            const result = await createEntryWithBinaryRanking({
                data: {
                    categoryId: targetCategory.id,
                    name: cleanName,
                    createdAt: addedAt
                }
            });
            formElement.reset();
            setEntryDraftName("");
            setEntryCategoryId(targetCategory.id);

            setSelectedCategoryId(targetCategory.id);
            if (result.kind === "session") {
                setActiveBinarySessionId(result.sessionId);
            }

            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleQueueSettings(settings: QueueSettings, options: { quiet?: boolean } = {}) {
        const previousSettings = queueSettingsRef.current;
        queueSettingsRef.current = settings;
        setDashboard((currentDashboard) => ({
            ...currentDashboard,
            queueSettings: settings
        }));
        if (!options.quiet) {
            startBusy("Saving queue settings...");
        }
        setMessage(null);

        try {
            const savedSettings = await updateQueueSettings({ data: settings });
            queueSettingsRef.current = savedSettings;
            setDashboard((currentDashboard) => ({
                ...currentDashboard,
                queueSettings: savedSettings
            }));
            await refreshAfterMutation();
        } catch (error) {
            queueSettingsRef.current = previousSettings;
            setDashboard((currentDashboard) => ({
                ...currentDashboard,
                queueSettings: previousSettings
            }));
            setErrorMessage(error);
        } finally {
            if (!options.quiet) {
                finishBusy();
            }
        }
    }

    function getReadyQueuedEntries(queuedEntries: QueuedEntry[], excludedQueuedEntryIds: Set<string> = new Set()) {
        const currentTime = Date.now();
        return queuedEntries
            .filter((entry) => entry.availableAt <= currentTime && !excludedQueuedEntryIds.has(entry.id))
            .sort((left, right) => left.availableAt - right.availableAt || left.createdAt - right.createdAt);
    }

    function getNextReadyQueuedEntry(queuedEntries: QueuedEntry[]) {
        const readyEntries = getReadyQueuedEntries(queuedEntries, skippedQueueRankIdsRef.current);
        if (readyEntries.length === 0) {
            return null;
        }

        if (!queueSettingsRef.current.randomizeReadyEntries) {
            return readyEntries[0] ?? null;
        }

        return readyEntries[Math.floor(Math.random() * readyEntries.length)] ?? null;
    }

    async function beginQueuedEntryRanking(entry: QueuedEntry, overrideDelay: boolean) {
        const result = await startQueuedEntryRanking({
            data: {
                queuedEntryId: entry.id,
                overrideDelay
            }
        });

        setSelectedCategoryId(entry.categoryId);
        if (result.kind === "session") {
            setActiveBinarySessionId(result.sessionId);
        } else {
            setMessage(`${entry.name} was added as the first ranked entry in ${entry.categoryName}.`);
        }

        const nextDashboard = await refreshAfterMutation();
        return { result, nextDashboard };
    }

    async function startNextQueuedRank(queuedEntries: QueuedEntry[]) {
        if (!queueRankModeRef.current) {
            return;
        }

        const nextEntry = getNextReadyQueuedEntry(queuedEntries);
        if (!nextEntry) {
            const skippedCount = skippedQueueRankIdsRef.current.size;
            setQueueRankingActive(false);
            setMessage(skippedCount > 0
                ? "No unskipped ready queued entries remain."
                : "No ready queued entries remain.");
            return;
        }

        startBusy("Starting queued rank...");
        setMessage(null);

        try {
            const { result, nextDashboard } = await beginQueuedEntryRanking(nextEntry, false);
            if (!nextDashboard) {
                setQueueRankingActive(false);
                return;
            }

            if (result.kind !== "session" && queueRankModeRef.current) {
                await startNextQueuedRank(nextDashboard.queuedEntries);
            }
        } catch (error) {
            setQueueRankingActive(false);
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleStartQueuedEntry(entry: QueuedEntry) {
        setQueueRankingActive(false);
        startBusy("Starting queued rank...");
        setMessage(null);

        try {
            await beginQueuedEntryRanking(entry, true);
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleStartQueueRank() {
        skippedQueueRankIdsRef.current = new Set();
        setQueueRankingActive(true);
        await startNextQueuedRank(dashboard.queuedEntries);
    }

    function handleStopQueueRank() {
        setQueueRankingActive(false);
        setMessage(activeFlowLocked ? "Queue ranking will stop after the current item." : "Queue ranking stopped.");
    }

    async function removeQueuedEntryForHistory(entry: QueuedEntry) {
        await deleteQueuedEntry({ data: { queuedEntryId: entry.id } });
        await refreshAfterMutation();
    }

    async function restoreQueuedEntryForHistory(entry: QueuedEntry) {
        await restoreQueuedEntry({ data: { queuedEntryId: entry.id } });
        await refreshAfterMutation();
    }

    function queuedEntriesLabel(count: number) {
        return `${count} queued ${count === 1 ? "entry" : "entries"}`;
    }

    function restoredQueuedEntriesMessage(restoredCount: number, skippedCount: number) {
        const restoredMessage = restoredCount > 0
            ? `Restored ${queuedEntriesLabel(restoredCount)}.`
            : "No queued entries were restored.";
        return skippedCount > 0
            ? `${restoredMessage} Skipped ${skippedCount} ${skippedCount === 1 ? "entry" : "entries"} that could not be restored.`
            : restoredMessage;
    }

    async function removeQueuedEntriesForHistory(entries: QueuedEntry[]) {
        const result = await deleteQueuedEntries({
            data: { queuedEntryIds: entries.map((entry) => entry.id) }
        });
        await refreshAfterMutation();
        return result;
    }

    async function restoreQueuedEntriesForHistory(entries: QueuedEntry[]) {
        const result = await restoreQueuedEntries({
            data: { queuedEntryIds: entries.map((entry) => entry.id) }
        });
        await refreshAfterMutation();
        return result;
    }

    async function handleDeleteQueuedEntry(entry: QueuedEntry) {
        startBusy("Removing queued entry...");
        setMessage(null);

        try {
            await removeQueuedEntryForHistory(entry);
            registerReversibleAction({
                redo: () => removeQueuedEntryForHistory(entry),
                redoToastMessage: `Removed ${entry.name} from the queue.`,
                undo: () => restoreQueuedEntryForHistory(entry),
                undoToastMessage: `Restored ${entry.name} to the queue.`,
                variant: "danger"
            });
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleDeleteQueuedEntries(entries: QueuedEntry[]) {
        if (entries.length === 0) {
            return;
        }

        startBusy(`Removing ${queuedEntriesLabel(entries.length)}...`);
        setMessage(null);

        try {
            const result = await removeQueuedEntriesForHistory(entries);
            registerReversibleAction({
                redo: async () => {
                    const redoResult = await removeQueuedEntriesForHistory(entries);
                    return `Removed ${queuedEntriesLabel(redoResult.deletedCount)}.`;
                },
                redoToastMessage: `Removed ${queuedEntriesLabel(result.deletedCount)}.`,
                undo: async () => {
                    const undoResult = await restoreQueuedEntriesForHistory(entries);
                    return restoredQueuedEntriesMessage(undoResult.restoredCount, undoResult.skippedCount);
                },
                undoToastMessage: `Restored ${queuedEntriesLabel(entries.length)}.`,
                variant: "danger"
            });
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleRenameQueuedEntry(entry: QueuedEntry, name: string) {
        startBusy("Renaming queued entry...");
        setMessage(null);

        try {
            await renameQueuedEntry({ data: { queuedEntryId: entry.id, name } });
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleRerank(entryId: string) {
        startBusy("Preparing rerank...");
        setMessage(null);

        try {
            const result = await startRerankEntry({ data: { entryId } });
            if (result.kind === "session") {
                setActiveBinarySessionId(result.sessionId);
                scrollMainToTop();
            }
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    function handleEntryDragStart(event: DragStartEvent) {
        setActiveEntryId(String(event.active.id));
    }

    function handleEntryDragCancel() {
        setActiveEntryId(null);
    }

    function handleEntryDragEnd(event: DragEndEvent) {
        setActiveEntryId(null);
        const { active, over } = event;
        if (!over || active.id === over.id) {
            return;
        }

        const ids = displayedEntries.map((entry) => entry.id);
        const oldIndex = ids.indexOf(String(active.id));
        const newIndex = ids.indexOf(String(over.id));
        if (oldIndex < 0 || newIndex < 0) {
            return;
        }

        setEntryDragOrder(arrayMove(ids, oldIndex, newIndex));
        void handleMoveEntryRelativeToEntry(
            String(active.id),
            String(over.id),
            placementForSortableMove(oldIndex, newIndex)
        );
    }

    async function handleMoveEntryRelativeToEntry(
        entryId: string,
        targetEntryId: string,
        placement: DropPlacement
    ) {
        if (entryId === targetEntryId) {
            setEntryDragOrder(null);
            return;
        }

        const orderedEntryIds = selectedCategory ? orderEntries(selectedCategory.entries).map((entry) => entry.id) : [];
        const originalEntryIndex = orderedEntryIds.indexOf(entryId);
        if (isReorderNoop(orderedEntryIds, entryId, targetEntryId, placement)) {
            setEntryDragOrder(null);
            return;
        }

        const previousEntryId = originalEntryIndex > 0 ? orderedEntryIds[originalEntryIndex - 1] : null;
        const nextEntryId = originalEntryIndex >= 0 ? orderedEntryIds[originalEntryIndex + 1] ?? null : null;
        startBusy("Reordering entries...");
        setMessage(null);

        try {
            const result = await moveEntryRelativeToEntryForHistory(entryId, targetEntryId, placement);
            if (result.moved && originalEntryIndex >= 0) {
                registerReversibleAction({
                    redo: () => moveEntryRelativeToEntryForHistory(entryId, targetEntryId, placement).then(() => undefined),
                    redoToastMessage: "Reordered entries.",
                    undo: () => restoreEntryOrderForHistory(entryId, previousEntryId, nextEntryId),
                    undoToastMessage: "Restored the previous order.",
                    variant: "success"
                });
            }
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
            setEntryDragOrder(null);
        }
    }

    async function moveEntryRelativeToEntryForHistory(
        entryId: string,
        targetEntryId: string,
        placement: DropPlacement
    ) {
        const result = await moveEntryRelativeToEntry({ data: { entryId, targetEntryId, placement } });
        await refreshAfterMutation();
        return result;
    }

    async function restoreEntryOrderForHistory(
        entryId: string,
        previousEntryId: string | null,
        nextEntryId: string | null
    ) {
        if (nextEntryId) {
            await moveEntryRelativeToEntryForHistory(entryId, nextEntryId, "before");
            return;
        }

        if (previousEntryId) {
            await moveEntryRelativeToEntryForHistory(entryId, previousEntryId, "after");
            return;
        }

        await refresh();
    }

    async function handleRename(entryId: string, name: string) {
        startBusy("Renaming entry...");
        setMessage(null);

        try {
            await renameEntry({ data: { entryId, name } });
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function deleteEntryForHistory(entry: Entry) {
        await deleteEntry({ data: { entryId: entry.id } });
        await refreshAfterMutation();
    }

    async function restoreEntryForHistory(entry: Entry) {
        await restoreEntry({ data: { entryId: entry.id } });
        await refreshAfterMutation();
    }

    async function handleDelete(entry: Entry) {
        startBusy("Deleting entry...");
        setMessage(null);

        try {
            await deleteEntryForHistory(entry);
            registerReversibleAction({
                redo: () => deleteEntryForHistory(entry),
                redoToastMessage: `Deleted ${entry.name}.`,
                undo: () => restoreEntryForHistory(entry),
                undoToastMessage: `Restored ${entry.name}.`,
                variant: "danger"
            });
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleSwitch(entryId: string, targetCategoryId: string) {
        startBusy("Moving entry...");
        setMessage(null);

        try {
            const result = await switchEntryCategory({ data: { entryId, targetCategoryId } });
            if (result.kind === "session") {
                setActiveBinarySessionId(result.sessionId);
            }
            setSelectedCategoryId(targetCategoryId);
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleCancelBinarySession(
        session: BinarySessionView,
        mode: CancelBinarySessionMode = "default"
    ) {
        startBusy(
            session.source === "rerank_entry"
                ? "Cancelling rerank..."
                : "Cancelling add..."
        );
        setMessage(null);
        setQueueRankingActive(false);

        try {
            await cancelBinarySession({ data: { sessionId: session.id, mode } });
            markBinarySessionClosed(session.id);
            setActiveBinarySessionId(null);
            setMessage(cancelBinarySessionMessage(session, mode));
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleSkipQueuedBinarySession(session: BinarySessionView) {
        if (!session.queuedEntryId) {
            return;
        }

        startBusy("Skipping queued rank...");
        setMessage(null);

        try {
            skippedQueueRankIdsRef.current.add(session.queuedEntryId);
            await cancelBinarySession({ data: { sessionId: session.id, mode: "default" } });
            markBinarySessionClosed(session.id);
            setActiveBinarySessionId(null);
            const nextDashboard = await refreshAfterMutation();
            if (queueRankModeRef.current && nextDashboard) {
                await startNextQueuedRank(nextDashboard.queuedEntries);
            } else {
                setMessage(`Skipped ${session.subject.name} and returned it to the queue.`);
            }
        } catch (error) {
            skippedQueueRankIdsRef.current.delete(session.queuedEntryId);
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleStartRepair(categoryId: string | null, closeDrawer = false) {
        setQueueRankingActive(false);
        startBusy(categoryId ? "Starting category repair..." : "Starting repair mode...");
        setMessage(null);

        try {
            const result = await startRepairSession({ data: { categoryId } });
            setActiveRepairSessionId(result.sessionId);
            setSelectedCategoryId(result.categoryId);
            if (closeDrawer) {
                setMobileDrawerOpen(false);
                scrollMainToTop();
            } else {
                scrollMainToTop();
            }
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    async function handleCancelRepairSession(session: RepairSessionView) {
        startBusy("Cancelling repair mode...");
        setMessage(null);

        try {
            await cancelRepairSession({ data: { sessionId: session.id } });
            markRepairSessionClosed(session.id);
            setActiveRepairSessionId(null);
            setMessage("Repair mode exited.");
            await refreshAfterMutation();
        } catch (error) {
            setErrorMessage(error);
        } finally {
            finishBusy();
        }
    }

    function handleOpenProfile() {
        void navigate({ to: "/profile" });
    }

    async function handleMissingBinarySession(sessionId: string) {
        if (
            closedBinarySessionIdsRef.current.has(sessionId) ||
            activeSessionIdRef.current !== sessionId
        ) {
            return;
        }

        markBinarySessionClosed(sessionId);
        setActiveBinarySessionId(null);
        setQueueRankingActive(false);
        const nextDashboard = await refreshAfterMutation();
        if (!nextDashboard) {
            return;
        }

        if (
            nextDashboard.activeBinarySession &&
            !closedBinarySessionIdsRef.current.has(nextDashboard.activeBinarySession.id)
        ) {
            setActiveBinarySessionId(nextDashboard.activeBinarySession.id);
            setSelectedCategoryId(nextDashboard.activeBinarySession.categoryId);
            return;
        }

        setMessage("That ranking is no longer active.", "danger");
    }

    async function handleMissingRepairSession(sessionId: string) {
        if (
            closedRepairSessionIdsRef.current.has(sessionId) ||
            activeRepairSessionIdRef.current !== sessionId
        ) {
            return;
        }

        markRepairSessionClosed(sessionId);
        setActiveRepairSessionId(null);
        const nextDashboard = await refreshAfterMutation();
        if (!nextDashboard) {
            return;
        }

        if (
            nextDashboard.activeRepairSession &&
            !closedRepairSessionIdsRef.current.has(nextDashboard.activeRepairSession.id)
        ) {
            setActiveRepairSessionId(nextDashboard.activeRepairSession.id);
            setSelectedCategoryId(nextDashboard.activeRepairSession.categoryId);
            return;
        }

        setMessage("That repair mode session is no longer active.", "danger");
    }

    async function handleImport(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const formElement = event.currentTarget;
        startBusy("Reading spreadsheet...");
        setMessage(null);
        const form = new FormData(formElement);
        const file = form.get("workbook");

        if (!(file instanceof File) || file.size === 0) {
            pushToast({
                message: "Choose an .xlsx file to import.",
                variant: "danger"
            });
            finishBusy();
            return false;
        }

        try {
            await nextPaint();
            const addedAt = dateInputToTimestamp(String(form.get("addedAt") ?? ""));
            const buffer = await file.arrayBuffer();
            setBusyLabel("Parsing spreadsheet...");
            await nextPaint();
            const parsed = await parseLegacyWorkbook(buffer, addedAt);
            const parsedCount = parsed.entries.length + parsed.queuedEntries.length;
            if (parsedCount === 0) {
                throw new Error("Spreadsheet contains no importable entries. Put category names in the first row and entries below them.");
            }
            setBusyLabel(`Importing ${parsedCount} entries...`);
            await nextPaint();
            const result = await importLegacyEntries({ data: parsed });
            setBusyLabel("Refreshing dashboard...");
            pushToast({
                message: importResultMessage(result),
                variant: "success"
            });
            formElement.reset();
            await refreshAfterMutation();
            return true;
        } catch (error) {
            pushToast({
                message: errorMessage(error),
                variant: "danger"
            });
            return false;
        } finally {
            finishBusy();
        }
    }

    async function handleExport() {
        startBusy("Preparing export...");
        setMessage(null);
        try {
            await nextPaint();
            const entryCount = dashboard.categories.reduce(
                (count, category) => count + category.entries.length,
                0
            );
            const exportCount = entryCount + dashboard.queuedEntries.length;
            if (exportCount === 0) {
                pushToast({
                    message: "Nothing to export yet. Add or import entries first."
                });
                return;
            }
            const blob = await writeExportWorkbook(dashboard.categories, dashboard.queuedEntries);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "Rankings.xlsx";
            anchor.click();
            URL.revokeObjectURL(url);
            pushToast({
                message: "Export downloaded.",
                variant: "success"
            });
        } catch (error) {
            pushToast({
                message: errorMessage(error),
                variant: "danger"
            });
        } finally {
            finishBusy();
        }
    }

    function selectCategory(categoryId: string, closeDrawer = false) {
        setSelectedCategoryId(categoryId);
        if (closeDrawer) {
            setMobileDrawerOpen(false);
            scrollMainToTop();
        }
    }

    async function handleCreateCategoryFromDrawer(event: FormEvent<HTMLFormElement>) {
        await handleCreateCategory(event);
        setMobileDrawerOpen(false);
        scrollMainToTop();
    }

    async function handleCreateEntryFromDrawer(event: FormEvent<HTMLFormElement>) {
        await handleCreateEntry(event);
        setMobileDrawerOpen(false);
        scrollMainToTop();
    }

    async function handleStartQueuedEntryFromDrawer(entry: QueuedEntry) {
        setMobileDrawerOpen(false);
        await handleStartQueuedEntry(entry);
        scrollMainToTop();
    }

    async function handleStartQueueRankFromDrawer() {
        setMobileDrawerOpen(false);
        await handleStartQueueRank();
        scrollMainToTop();
    }

    function handleStopQueueRankFromDrawer() {
        setMobileDrawerOpen(false);
        handleStopQueueRank();
    }

    const accountMenuProps = {
        busy,
        listLocked: activeFlowLocked,
        settings: dashboard.queueSettings,
        onExport: handleExport,
        onOpenImport: () => setImportToastOpen(true),
        onOpenProfile: handleOpenProfile,
        onSaveSettings: handleQueueSettings,
        onShowEntryPercentileChange: setShowEntryPercentile,
        onThemeChange: setThemeMode,
        showEntryPercentile,
        themeMode,
        userIsAdmin,
        userImage: currentUserImage,
        userImageVersion: currentUserImageVersion,
        userName: currentUserName
    };

    function renderNewCategoryPanel(onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>) {
        return (
            <section className={SIDEBAR_PANEL_CLASS}>
                <strong className="min-w-0 max-w-full">New Category</strong>
                <form
                    className="grid min-w-0 gap-[0.7rem] *:max-w-full *:min-w-0"
                    onSubmit={onSubmit}
                >
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 max-[720px]:grid-cols-1">
                        <Input
                            disabled={busy}
                            name="name"
                            placeholder="New category"
                            required
                            value={categoryDraftName}
                            onChange={(event) => setCategoryDraftName(event.target.value)}
                        />
                        <Button
                            size="lg"
                            disabled={busy || !canCreateCategory}
                            type="submit"
                        >
                            Add
                        </Button>
                    </div>
                    <label className="inline-flex w-fit items-center gap-[0.45rem] text-[0.86rem] text-muted-foreground">
                        <input
                            className="w-auto"
                            disabled={busy}
                            name="isPublic"
                            type="checkbox"
                        />
                        <span>Show on profile</span>
                    </label>
                </form>
            </section>
        );
    }

    function renderCategoryList(closeOnSelect = false, closeOnRepair = false) {
        const hasRepairableCategory = dashboard.categories.some((category) => category.entries.length >= 2);
        return (
            <section className={SIDEBAR_PANEL_CLASS}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <strong className="min-w-0 max-w-full">Categories</strong>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || activeFlowLocked || !hasRepairableCategory}
                        type="button"
                        onClick={() => void handleStartRepair(null, closeOnRepair)}
                    >
                        <Wrench data-icon="inline-start" />
                        <span>Repair Mode</span>
                    </Button>
                </div>
                <DndContext
                    sensors={sensors}
                    onDragStart={handleCategoryDragStart}
                    onDragEnd={handleCategoryDragEnd}
                    onDragCancel={handleCategoryDragCancel}
                >
                    <SortableContext
                        items={orderedCategories.map((category) => category.id)}
                        strategy={verticalListSortingStrategy}
                    >
                        <div className="m-0 grid max-h-[min(26vh,18rem)] min-h-0 min-w-0 gap-[0.45rem] overflow-x-hidden overflow-y-auto pr-[0.15rem] max-[720px]:max-h-none max-[720px]:overflow-y-visible max-[720px]:pr-0">
                            {orderedCategories.map((category) => (
                                <CategoryListItem
                                    category={category}
                                    isActive={category.id === selectedCategory?.id}
                                    key={category.id}
                                    busy={busy}
                                    canDragReorder={canDragReorderCategories}
                                    listLocked={activeFlowLocked}
                                    onDelete={() => setCategoryDeleteTarget(category)}
                                    onRename={(name) => handleRenameCategory(category.id, name)}
                                    onRepair={() => void handleStartRepair(category.id, closeOnRepair)}
                                    onSelect={() => selectCategory(category.id, closeOnSelect)}
                                />
                            ))}
                            {dashboard.categories.length === 0 ? (
                                <EmptyState
                                    compact
                                    icon={Library}
                                    title="No Categories"
                                >
                                    Add a category to start building a ranked list.
                                </EmptyState>
                            ) : null}
                        </div>
                    </SortableContext>
                    <DragOverlay>
                        {activeCategoryId
                            ? (() => {
                                const activeCategory = dashboard.categories.find(
                                    (category) => category.id === activeCategoryId
                                );
                                return activeCategory ? (
                                    <CategoryDragOverlay
                                        category={activeCategory}
                                        isActive={activeCategory.id === selectedCategory?.id}
                                    />
                                ) : null;
                            })()
                            : null}
                    </DragOverlay>
                </DndContext>
            </section>
        );
    }

    function renderNewEntryPanel(onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>) {
        if (!selectedCategory) {
            return null;
        }

        return (
            <section className={SIDEBAR_PANEL_CLASS}>
                <strong className="min-w-0 max-w-full">New Entry</strong>
                <form className="grid max-w-full min-w-0 gap-2" onSubmit={onSubmit}>
                    <Input
                        disabled={busy}
                        name="name"
                        placeholder="New entry"
                        required
                        value={entryDraftName}
                        onChange={(event) => setEntryDraftName(event.target.value)}
                    />
                    <div className="grid min-w-0 grid-cols-[minmax(10.5rem,1fr)_auto] gap-2 max-[720px]:grid-cols-1">
                        <Select
                            disabled={busy}
                            value={entryCategoryId || selectedCategory.id}
                            onValueChange={setEntryCategoryId}
                        >
                            <SelectTrigger aria-label="Category" className="w-full min-w-0">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    {dashboard.categories.map((category) => (
                                        <SelectItem key={category.id} value={category.id}>
                                            {category.name}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                        <Button
                            size="lg"
                            disabled={busy || !canCreateEntry}
                            type="submit"
                        >
                            {forceQueueNewEntry ? "Queue" : "Add"}
                        </Button>
                    </div>
                </form>
            </section>
        );
    }

    function renderQueuePanel(options: { drawer?: boolean } = {}) {
        const drawer = Boolean(options.drawer);
        return (
            <QueuePanel
                activeSessionId={activeFlowId}
                busy={busy}
                queueRankMode={queueRankMode}
                queuedEntries={dashboard.queuedEntries}
                onDelete={handleDeleteQueuedEntry}
                onDeleteSelected={handleDeleteQueuedEntries}
                onPickImage={(entry) => setImagePickerTarget({
                    kind: "queue",
                    item: entry,
                    category: {
                        id: entry.categoryId,
                        name: entry.categoryName
                    }
                })}
                onStartQueue={drawer ? handleStartQueueRankFromDrawer : handleStartQueueRank}
                onRename={handleRenameQueuedEntry}
                onStart={drawer ? handleStartQueuedEntryFromDrawer : handleStartQueuedEntry}
                onStopQueue={drawer ? handleStopQueueRankFromDrawer : handleStopQueueRank}
            />
        );
    }

    function renderDesktopSidebar() {
        return (
            <>
                <div className="relative flex items-center justify-between gap-3">
                    <BrandLink />
                </div>

                {renderNewCategoryPanel(handleCreateCategory)}
                {renderCategoryList(false)}
                {renderNewEntryPanel(handleCreateEntry)}
                {renderQueuePanel()}
            </>
        );
    }

    function renderMobileDrawerTools() {
        const hasCategories = dashboard.categories.length > 0;
        return (
            <>
                {hasCategories ? renderCategoryList(true, true) : renderNewCategoryPanel(handleCreateCategoryFromDrawer)}
                {renderNewEntryPanel(handleCreateEntryFromDrawer)}
                {renderQueuePanel({ drawer: true })}
                {hasCategories ? renderNewCategoryPanel(handleCreateCategoryFromDrawer) : renderCategoryList(true, true)}
            </>
        );
    }

    return (
        <main
            className="grid h-dvh min-h-screen w-full max-w-full min-w-0 grid-cols-[clamp(300px,24vw,360px)_minmax(0,1fr)] overflow-hidden max-[720px]:h-auto max-[720px]:min-h-dvh max-[720px]:grid-cols-1 max-[720px]:grid-rows-[auto_minmax(0,1fr)] max-[720px]:overflow-visible"
            aria-busy={busy}
        >
            {busy ? <BusyOverlay label={busyLabel ?? "Working..."} /> : null}
            {importToastOpen ? (
                <ImportSpreadsheetToast
                    busy={busy}
                    busyLabel={busyLabel}
                    disabled={busy || activeFlowLocked}
                    onClose={() => setImportToastOpen(false)}
                    onImport={async (event) => {
                        const imported = await handleImport(event);
                        if (imported) {
                            setImportToastOpen(false);
                        }
                    }}
                />
            ) : null}
            {imagePickerTarget ? (
                <ImagePickerModal
                    target={imagePickerTarget}
                    onClose={() => setImagePickerTarget(null)}
                    onSaved={handleImageSaved}
                />
            ) : null}
            {categoryDeleteTarget ? (
                <ConfirmDialog
                    confirmLabel="Delete Category"
                    title={`Delete ${categoryDeleteTarget.name}?`}
                    variant="danger"
                    onCancel={() => setCategoryDeleteTarget(null)}
                    onConfirm={() => void handleDeleteCategory(categoryDeleteTarget)}
                >
                    This permanently removes {categoryDeleteTarget.entries.length} ranked {categoryDeleteTarget.entries.length === 1 ? "entry" : "entries"},
                    {" "}
                    {dashboard.queuedEntries.filter((entry) => entry.categoryId === categoryDeleteTarget.id).length} queued {dashboard.queuedEntries.filter((entry) => entry.categoryId === categoryDeleteTarget.id).length === 1 ? "entry" : "entries"},
                    {" "}and stored images for this category.
                </ConfirmDialog>
            ) : null}
            <aside
                className="grid h-dvh max-h-dvh min-h-0 min-w-0 auto-rows-max content-start gap-[1.15rem] overflow-x-hidden overflow-y-auto border-r border-border bg-sidebar p-4 max-[720px]:hidden"
                data-testid="dashboard-sidebar"
            >
                {renderDesktopSidebar()}
            </aside>

            <div
                className="sticky top-0 z-40 hidden border-b border-border bg-background/95 px-3 pb-3 pt-[max(0.65rem,env(safe-area-inset-top))] shadow-sm backdrop-blur max-[720px]:grid"
                data-testid="mobile-dashboard-header"
            >
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                    <AccountMenu
                        {...accountMenuProps}
                        contentAlign="start"
                        triggerClassName="flex h-10 w-10 flex-none items-center justify-center rounded-full p-0"
                    />
                    <div className="grid min-w-0 gap-[0.05rem] text-center">
                        <h1 className="m-0 truncate text-[1.08rem] font-bold">{selectedCategory?.name ?? "Categories"}</h1>
                        <p className="m-0 truncate text-[0.82rem] text-muted-foreground">
                            {selectedCategory
                                ? `${displayedEntries.length}${entrySearch.trim() ? ` of ${selectedCategory.entries.length}` : ""} entries`
                                : "Create a category to start ranking."}
                        </p>
                    </div>
                    <Sheet open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen}>
                        <SheetTrigger asChild>
                            <Button
                                aria-label="Open tools"
                                data-testid="mobile-tools-trigger"
                                size="icon-lg"
                                type="button"
                                variant="outline"
                            >
                                <Menu className="size-5" />
                            </Button>
                        </SheetTrigger>
                        <SheetContent side="right" className="max-[420px]:w-[calc(100vw-0.75rem)]">
                            <SheetHeader>
                                <BrandLink />
                                <SheetTitle className="sr-only">Dashboard tools</SheetTitle>
                                <SheetDescription className="sr-only">
                                    Category, entry, and queue controls for the mobile dashboard.
                                </SheetDescription>
                                <SheetCloseButton />
                            </SheetHeader>
                            <SheetBody>
                                <div className="grid content-start gap-3">
                                    {renderMobileDrawerTools()}
                                </div>
                            </SheetBody>
                        </SheetContent>
                    </Sheet>
                </div>
                {selectedCategory && !activeFlowLocked ? (
                    <div className="mt-2 grid min-w-0">
                        <Input
                            aria-label="Search entries"
                            value={entrySearch}
                            placeholder="Search entries"
                            onChange={(event) => setEntrySearch(event.target.value)}
                        />
                    </div>
                ) : null}
            </div>

            <section
                className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background max-[720px]:block max-[720px]:overflow-visible"
            >
                <div
                    className="z-40 flex min-h-0 flex-nowrap items-center gap-[0.7rem] border-b border-border bg-background px-[clamp(0.9rem,2.4vw,1.75rem)] py-[0.8rem] shadow-sm max-[720px]:hidden *:max-w-full *:min-w-0"
                    data-testid="dashboard-topbar"
                >
                    <div className="grid max-w-[min(34rem,42vw)] min-w-0 flex-[0_1_auto] gap-[0.15rem]">
                        <h1 className="m-0 truncate text-2xl font-bold">{selectedCategory?.name ?? "Categories"}</h1>
                        <p className="m-0 text-muted-foreground">
                            {selectedCategory
                                ? `${displayedEntries.length}${entrySearch.trim() ? ` of ${selectedCategory.entries.length}` : ""} entries`
                                : "Create a category to start ranking."}
                        </p>
                    </div>
                    {selectedCategory && !activeFlowLocked ? (
                        <div className="mr-auto grid w-[min(26rem,100%)] max-w-104 min-w-0 flex-[0_1_26rem] gap-2 max-[720px]:w-full max-[720px]:max-w-none">
                            <Input
                                aria-label="Search entries"
                                value={entrySearch}
                                placeholder="Search entries"
                                onChange={(event) => setEntrySearch(event.target.value)}
                            />
                        </div>
                    ) : null}
                    <AccountMenu
                        {...accountMenuProps}
                    />
                </div>

                <div
                    className="grid min-h-0 min-w-0 content-start gap-[0.85rem] overflow-x-hidden overflow-y-auto px-[clamp(0.9rem,2.4vw,1.75rem)] py-4 max-[720px]:gap-3 max-[720px]:overflow-y-visible max-[720px]:px-3 max-[720px]:py-3"
                    data-testid="dashboard-scroll-region"
                    ref={mainRef}
                >
                    {dashboard.categories.length === 0 ? (
                        <EmptyState
                            icon={Library}
                            title="Create Your First Category"
                        >
                            Categories keep each ranked list separate. Use the sidebar form to add one.
                        </EmptyState>
                    ) : null}

                    {activeSessionId ? (
                        <BinaryRankPanel
                            imageRefreshVersion={imageRefreshVersion}
                            sessionId={activeSessionId}
                            onCancel={handleCancelBinarySession}
                            onComplete={async (sessionId) => {
                                markBinarySessionClosed(sessionId);
                                if (activeSessionIdRef.current === sessionId) {
                                    setActiveBinarySessionId(null);
                                }
                                const nextDashboard = await refreshAfterMutation();
                                if (queueRankModeRef.current && nextDashboard) {
                                    await startNextQueuedRank(nextDashboard.queuedEntries);
                                } else if (queueRankModeRef.current) {
                                    setQueueRankingActive(false);
                                }
                            }}
                            onUnavailable={handleMissingBinarySession}
                            onNeedImage={requestImageForMatch}
                            onPickImage={(entry, category) => setImagePickerTarget({
                                kind: "entry",
                                item: entry,
                                category
                            })}
                            onRename={(entry, name) => handleRename(entry.id, name)}
                            onSkipQueued={handleSkipQueuedBinarySession}
                        />
                    ) : null}

                    {!activeSessionId && activeRepairSessionId ? (
                        <RepairRankPanel
                            imageRefreshVersion={imageRefreshVersion}
                            sessionId={activeRepairSessionId}
                            onCancel={handleCancelRepairSession}
                            onComplete={async (sessionId) => {
                                markRepairSessionClosed(sessionId);
                                if (activeRepairSessionIdRef.current === sessionId) {
                                    setActiveRepairSessionId(null);
                                }
                                await refreshAfterMutation();
                                setMessage("Repair mode finished.");
                            }}
                            onUnavailable={handleMissingRepairSession}
                            onNeedImage={requestImageForMatch}
                            onPickImage={(entry, category) => setImagePickerTarget({
                                kind: "entry",
                                item: entry,
                                category
                            })}
                            onRename={(entry, name) => handleRename(entry.id, name)}
                        />
                    ) : null}

                    <DndContext
                        sensors={sensors}
                        onDragStart={handleEntryDragStart}
                        onDragEnd={handleEntryDragEnd}
                        onDragCancel={handleEntryDragCancel}
                    >
                        <SortableContext
                            items={orderedEntries.map((entry) => entry.id)}
                            strategy={rectSortingStrategy}
                        >
                            <section
                                className={`grid min-w-0 gap-3 ${entrySearch.trim()
                                    ? "grid-cols-[repeat(auto-fill,minmax(min(100%,16.5rem),1fr))]"
                                    : "grid-cols-[repeat(auto-fit,minmax(min(100%,16.5rem),1fr))]"
                                    }`}
                            >
                                {selectedCategory ? orderedEntries.map((entry) => (
                                    <EntryCard
                                        entry={entry}
                                        categories={dashboard.categories}
                                        key={entry.id}
                                        canDragReorder={canDragReorderEntries}
                                        listLocked={activeFlowLocked}
                                        listSize={selectedCategory.entries.length}
                                        selectedCategoryId={selectedCategory.id}
                                        showPercentile={showEntryPercentile}
                                        onDelete={() => handleDelete(entry)}
                                        onPickImage={() => setImagePickerTarget({
                                            kind: "entry",
                                            item: entry,
                                            category: selectedCategory
                                        })}
                                        onRename={(name) => handleRename(entry.id, name)}
                                        onRerank={() => handleRerank(entry.id)}
                                        onSwitch={(targetCategoryId) => handleSwitch(entry.id, targetCategoryId)}
                                    />
                                )) : null}
                            </section>
                        </SortableContext>
                        <DragOverlay>
                            {activeEntryId
                                ? (() => {
                                    const activeEntry = displayedEntries.find((entry) => entry.id === activeEntryId);
                                    return activeEntry ? <EntryDragOverlay entry={activeEntry} /> : null;
                                })()
                                : null}
                        </DragOverlay>
                    </DndContext>
                    {selectedCategory && displayedEntries.length === 0 ? (
                        <EmptyState
                            icon={entrySearch.trim() ? Search : Swords}
                            title={entrySearch.trim() ? "No Matches" : "No Entries Yet"}
                        >
                            {entrySearch.trim()
                                ? "Try a different search term or clear the search field."
                                : dashboard.queueSettings.enabled
                                    ? "Add entries from the sidebar to queue them for ranking."
                                    : "Add an entry from the sidebar to start ranking this category."}
                        </EmptyState>
                    ) : null}
                </div>
            </section>
        </main>
    );
}
