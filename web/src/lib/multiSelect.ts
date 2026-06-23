export type PlainSelectionBehavior = "toggle" | "focus-or-toggle";

export interface MultiSelectInput {
    orderedIds: string[];
    selectedIds: Set<string>;
    clickedId: string;
    anchorId: string | null;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    plainBehavior?: PlainSelectionBehavior;
}

export function nextMultiSelection({
    orderedIds,
    selectedIds,
    clickedId,
    anchorId,
    shiftKey = false,
    metaKey = false,
    ctrlKey = false,
    plainBehavior = "toggle"
}: MultiSelectInput) {
    const additive = metaKey || ctrlKey;
    const nextAnchorId = clickedId;

    if (shiftKey && anchorId && orderedIds.includes(anchorId) && orderedIds.includes(clickedId)) {
        const anchorIndex = orderedIds.indexOf(anchorId);
        const clickedIndex = orderedIds.indexOf(clickedId);
        const startIndex = Math.min(anchorIndex, clickedIndex);
        const endIndex = Math.max(anchorIndex, clickedIndex);
        const nextSelectedIds = additive ? new Set(selectedIds) : new Set<string>();

        for (const id of orderedIds.slice(startIndex, endIndex + 1)) {
            nextSelectedIds.add(id);
        }

        return {
            anchorId,
            selectedIds: nextSelectedIds
        };
    }

    if (additive || plainBehavior === "toggle") {
        const nextSelectedIds = new Set(selectedIds);
        if (nextSelectedIds.has(clickedId)) {
            nextSelectedIds.delete(clickedId);
        } else {
            nextSelectedIds.add(clickedId);
        }

        return {
            anchorId: nextAnchorId,
            selectedIds: nextSelectedIds
        };
    }

    if (selectedIds.size > 1 || !selectedIds.has(clickedId)) {
        return {
            anchorId: nextAnchorId,
            selectedIds: new Set([clickedId])
        };
    }

    return {
        anchorId: nextAnchorId,
        selectedIds: new Set<string>()
    };
}
