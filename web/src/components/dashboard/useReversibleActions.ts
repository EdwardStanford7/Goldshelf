import { useEffect, useRef, type MutableRefObject } from "react";
import { isEditableShortcutTarget } from "@/lib/dom";
import { showActionToast, showToast, type ToastVariant } from "@/lib/toast";
import { UNDO_STACK_LIMIT, type ReversibleAction } from "./dashboardHelpers";
export function pushDashboardToast(toast: { message: string; variant?: ToastVariant; actionLabel?: string; onAction?: () => Promise<void> | void }) {
    if (toast.actionLabel && toast.onAction) showActionToast(toast.message, { variant: toast.variant, actionLabel: toast.actionLabel, onAction: toast.onAction });
    else showToast(toast.message, toast.variant);
}
export function useReversibleActions({ busyRef, startBusy, finishBusy, onError }: {
    busyRef: MutableRefObject<boolean>; startBusy: (label: string) => void; finishBusy: () => void; onError: (error: unknown) => void;
}) {
    const reversibleActionIdRef = useRef(0);
    const undoStackRef = useRef<ReversibleAction[]>([]);
    const redoStackRef = useRef<ReversibleAction[]>([]);
    const pushToast = pushDashboardToast;
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
            onError(error);
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
            onError(error);
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


    return { registerReversibleAction };
}
