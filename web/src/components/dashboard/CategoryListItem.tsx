import type { FormEvent, MouseEvent } from "react";
import { useEffect, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Globe2, GripVertical, Lock, MoreVertical, Pencil, Trash2, Wrench } from "lucide-react";
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
import { useEscapeKey } from "@/hooks/useEscapeKey";
import type { CategoryWithEntries } from "@/lib/types";

function categoryButtonClass(isActive: boolean) {
    return `flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${isActive
            ? "border-transparent bg-secondary font-semibold text-foreground"
            : "border-transparent bg-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
        }`;
}

export function CategoryListItem({
    category,
    isActive,
    busy,
    canDragReorder,
    listLocked,
    selectionMode = false,
    selected = false,
    onDelete,
    onRename,
    onRepair,
    onSelect,
    onSelection,
    onToggleVisibility
}: {
    category: CategoryWithEntries;
    isActive: boolean;
    busy: boolean;
    canDragReorder: boolean;
    listLocked: boolean;
    selectionMode?: boolean;
    selected?: boolean;
    onDelete: () => void;
    onRename: (name: string) => Promise<void>;
    onRepair: () => void;
    onSelect: () => void;
    onSelection?: (event: MouseEvent<HTMLElement>, options?: { forceAdditive?: boolean }) => void;
    onToggleVisibility: () => void;
}) {
    const [isRenaming, setIsRenaming] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [name, setName] = useState(category.name);
    useEscapeKey(isRenaming, () => { setName(category.name); setIsRenaming(false); });

    // The whole row is draggable: `listeners` go on the wrapper so a press-and-drag
    // anywhere reorders, while a plain click still selects (MouseSensor only starts a
    // drag after an 8px move). The grip is a decorative affordance. We don't spread
    // `attributes` (it would add role="button" to the wrapper and collide with the
    // inner category button e2e selects by name).
    const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: category.id,
        disabled: !canDragReorder || selectionMode || isRenaming || menuOpen
    });

    useEffect(() => {
        setName(category.name);
        setIsRenaming(false);
    }, [category.name]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        await onRename(name);
        setIsRenaming(false);
    }

    function startRename() {
        setName(category.name);
        setIsRenaming(true);
    }

    function stopActionEvent(event: { stopPropagation: () => void }) {
        event.stopPropagation();
    }

    if (isRenaming) {
        return (
            <form className="grid gap-[0.45rem] rounded-sm border border-border bg-muted p-[0.55rem]" onSubmit={handleSubmit}>
                <Input
                    autoFocus
                    aria-label={`Rename ${category.name}`}
                    disabled={busy}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                />
                <div className="grid grid-cols-2 gap-[0.45rem]">
                    <Button size="sm" disabled={busy} type="submit">Save</Button>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        type="button"
                        onClick={() => {
                            setName(category.name);
                            setIsRenaming(false);
                        }}
                    >
                        Cancel
                    </Button>
                </div>
            </form>
        );
    }

    return (
        <ContextMenu onOpenChange={setMenuOpen}>
            <ContextMenuTrigger asChild disabled={busy || selectionMode}>
                <div
                    ref={setNodeRef}
                    className={`group relative min-w-0 ${canDragReorder && !selectionMode ? "cursor-grab" : ""} ${selectionMode ? "cursor-pointer" : ""} ${isDragging ? "opacity-40" : ""}`.trim()}
                    onClick={(event) => {
                        if (selectionMode) {
                            onSelection?.(event);
                        }
                    }}
                    data-category-id={category.id}
                    style={{ transform: CSS.Transform.toString(transform), transition }}
                    {...listeners}
                >
                    <button
                        className={`${categoryButtonClass(isActive)} ${selectionMode ? "pl-9" : ""} ${selectionMode ? "" : "pr-9"}`.trim()}
                        disabled={busy}
                        title={`Double-click to rename · Open the menu for more actions${canDragReorder && !selectionMode ? " · Drag to reorder" : ""}`}
                        type="button"
                        onClick={() => {
                            if (!selectionMode) {
                                onSelect();
                            }
                        }}
                        onDoubleClick={() => {
                            if (!busy && !selectionMode) {
                                startRename();
                            }
                        }}
                    >
                        <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="truncate">{category.name}</span>
                            {category.visibility === "private" ? <Lock aria-hidden="true" className="size-3 shrink-0 opacity-60"><title>Hidden from profile</title></Lock> : null}
                        </span>
                        <span className="sr-only"> · </span>
                        <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{category.entryCount}</span>
                    </button>
                    {selectionMode ? (
                        <input
                            aria-label={`Select category ${category.name}`}
                            checked={selected}
                            className="absolute top-1/2 left-2 z-10 w-auto -translate-y-1/2"
                            onClick={(event) => {
                                event.stopPropagation();
                                onSelection?.(event, { forceAdditive: !event.shiftKey });
                            }}
                            readOnly
                            type="checkbox"
                        />
                    ) : null}
                    {!selectionMode ? <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
                        <DropdownMenuTrigger asChild>
                            <Button
                                aria-label={`Actions for ${category.name}`}
                                className="absolute top-1/2 right-1 z-20 -translate-y-1/2 transition-opacity focus-visible:opacity-100 min-[721px]:opacity-0 min-[721px]:group-hover:opacity-100 min-[721px]:data-[state=open]:opacity-100"
                                disabled={busy}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                                onClick={stopActionEvent}
                                onPointerDown={stopActionEvent}
                            >
                                <MoreVertical className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem
                                disabled={busy || listLocked || category.entryCount < 2}
                                onSelect={onRepair}
                            >
                                <Wrench />Repair This Category
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={busy} onSelect={startRename}>
                                <Pencil />Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={busy} onSelect={onToggleVisibility}>
                                {category.isPublic ? <Lock /> : <Globe2 />}
                                {category.isPublic ? "Hide from Profile" : "Show on Profile"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                variant="destructive"
                                disabled={busy || listLocked}
                                onSelect={onDelete}
                            >
                                <Trash2 />Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu> : null}
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem
                    disabled={busy || listLocked || category.entryCount < 2}
                    onSelect={onRepair}
                >
                    <Wrench />Repair This Category
                </ContextMenuItem>
                <ContextMenuItem onSelect={startRename}>
                    <Pencil />Rename
                </ContextMenuItem>
                <ContextMenuItem disabled={busy} onSelect={onToggleVisibility}>
                    {category.isPublic ? <Lock /> : <Globe2 />}
                    {category.isPublic ? "Hide from Profile" : "Show on Profile"}
                </ContextMenuItem>
                <ContextMenuItem
                    variant="destructive"
                    disabled={busy || listLocked}
                    onSelect={onDelete}
                >
                    <Trash2 />Delete
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

export function CategoryDragOverlay({
    category,
    isActive
}: {
    category: CategoryWithEntries;
    isActive: boolean;
}) {
    return (
        <div className="relative min-w-0 rotate-[0.5deg] cursor-grabbing">
            <span className={`${categoryButtonClass(isActive)} bg-card pr-9 shadow-floating`}>
                <span className="min-w-0 flex-1 truncate">{category.name}</span>
                <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{category.entryCount}</span>
            </span>
            <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center justify-center text-muted-foreground">
                <GripVertical className="size-4" />
            </span>
        </div>
    );
}
