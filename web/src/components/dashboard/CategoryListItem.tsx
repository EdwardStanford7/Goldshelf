import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MoreVertical, Pencil, Trash2, Wrench } from "lucide-react";
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
    return `block w-full min-w-0 cursor-pointer rounded-sm border px-[0.8rem] py-[0.55rem] text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${isActive
            ? "border-gold bg-accent"
            : "border-border bg-card hover:border-[color-mix(in_srgb,var(--primary)_45%,var(--border))]"
        }`;
}

export function CategoryListItem({
    category,
    isActive,
    busy,
    canDragReorder,
    listLocked,
    onDelete,
    onRename,
    onRepair,
    onSelect
}: {
    category: CategoryWithEntries;
    isActive: boolean;
    busy: boolean;
    canDragReorder: boolean;
    listLocked: boolean;
    onDelete: () => void;
    onRename: (name: string) => Promise<void>;
    onRepair: () => void;
    onSelect: () => void;
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
        disabled: !canDragReorder || isRenaming || menuOpen
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
            <ContextMenuTrigger asChild disabled={busy}>
                <div
                    ref={setNodeRef}
                    className={`relative min-w-0 ${canDragReorder ? "cursor-grab" : ""} ${isDragging ? "opacity-40" : ""}`.trim()}
                    data-category-id={category.id}
                    style={{ transform: CSS.Transform.toString(transform), transition }}
                    {...listeners}
                >
                    <button
                        className={`${categoryButtonClass(isActive)} ${canDragReorder ? "pr-9" : ""} max-[720px]:pr-10`.trim()}
                        disabled={busy}
                        title="Double-click to rename · Right-click for actions"
                        type="button"
                        onClick={onSelect}
                        onDoubleClick={() => {
                            if (!busy) {
                                startRename();
                            }
                        }}
                    >
                        <strong>{category.name}</strong>
                        <span className="text-muted-foreground"> · {category.entries.length}</span>
                    </button>
                    {canDragReorder ? (
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center justify-center text-muted-foreground max-[720px]:hidden"
                        >
                            <GripVertical className="size-4" />
                        </span>
                    ) : null}
                    <DropdownMenu onOpenChange={setMenuOpen}>
                        <DropdownMenuTrigger asChild>
                            <Button
                                aria-label={`Actions for ${category.name}`}
                                className="absolute top-1/2 right-1.5 z-20 hidden -translate-y-1/2 max-[720px]:inline-flex"
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
                                disabled={busy || listLocked || category.entries.length < 2}
                                onSelect={onRepair}
                            >
                                <Wrench />Repair This Category
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={busy} onSelect={startRename}>
                                <Pencil />Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                variant="destructive"
                                disabled={busy || listLocked}
                                onSelect={onDelete}
                            >
                                <Trash2 />Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem
                    disabled={busy || listLocked || category.entries.length < 2}
                    onSelect={onRepair}
                >
                    <Wrench />Repair This Category
                </ContextMenuItem>
                <ContextMenuItem onSelect={startRename}>
                    <Pencil />Rename
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
            <span className={`${categoryButtonClass(isActive)} block pr-9 shadow-floating`}>
                <strong>{category.name}</strong>
                <span className="text-muted-foreground"> · {category.entries.length}</span>
            </span>
            <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center justify-center text-muted-foreground">
                <GripVertical className="size-4" />
            </span>
        </div>
    );
}
