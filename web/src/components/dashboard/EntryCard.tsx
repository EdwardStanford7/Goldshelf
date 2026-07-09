import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowRightLeft, GripVertical, Image as ImageIcon, Info, MoreVertical, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger
} from "@/components/ui/context-menu";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectTrigger,
    SelectValue
} from "@/components/ui/select";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { formatDate } from "@/lib/format";
import { hasStoredImage, isNoImageKey } from "@/lib/images";
import type { CategoryWithEntries, Entry } from "@/lib/types";

const POSTER_CLASS =
    "aspect-[4/5] bg-[image:linear-gradient(135deg,var(--poster-start),var(--poster-end))] text-center text-muted-foreground";
const ENTRY_CARD_DRAGGING_CLASS =
    "border-dashed border-primary bg-accent shadow-none [&>*]:opacity-0";

export function EntryCard({
    entry,
    categories,
    canDragReorder,
    listLocked,
    listSize,
    selectedCategoryId,
    showPercentile,
    onDelete,
    onPickImage,
    onRename,
    onRerank,
    onSwitch
}: {
    entry: Entry;
    categories: CategoryWithEntries[];
    canDragReorder: boolean;
    listLocked: boolean;
    listSize: number;
    selectedCategoryId: string;
    showPercentile: boolean;
    onDelete: () => void;
    onPickImage: () => void;
    onRename: (name: string) => Promise<void>;
    onRerank: () => void;
    onSwitch: (targetCategoryId: string) => void;
}) {
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(entry.name);
    const [targetCategoryId, setTargetCategoryId] = useState(selectedCategoryId);
    const [menuOpen, setMenuOpen] = useState(false);
    const [moveControlsOpen, setMoveControlsOpen] = useState(false);
    useEscapeKey(isRenaming, () => { setRenameValue(entry.name); setIsRenaming(false); });

    // The whole card is draggable (`listeners` on the article); a plain click/
    // double-click still works because MouseSensor only starts a drag after an 8px
    // move. The grip is a decorative affordance.
    const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: entry.id,
        disabled: !canDragReorder || isRenaming || moveControlsOpen || menuOpen
    });

    useEffect(() => {
        setIsRenaming(false);
        setRenameValue(entry.name);
        setTargetCategoryId(selectedCategoryId);
        setMoveControlsOpen(false);
    }, [entry.name, selectedCategoryId]);

    async function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        await onRename(renameValue);
        setIsRenaming(false);
    }

    function startRename() {
        setMoveControlsOpen(false);
        setRenameValue(entry.name);
        setIsRenaming(true);
    }

    function stopActionEvent(event: { stopPropagation: () => void }) {
        event.stopPropagation();
    }

    const showDragHandle = canDragReorder && !isRenaming && !moveControlsOpen;
    const position = entry.rankPosition + 1;
    const percentileLabel = percentileForPosition(position, listSize);

    function renderInfoContent() {
        return (
            <EntryInfo
                addedAt={entry.createdAt}
                percentileLabel={percentileLabel}
                position={position}
                total={listSize}
            />
        );
    }

    return (
        <ContextMenu onOpenChange={setMenuOpen}>
            <ContextMenuTrigger asChild>
                <article
                    ref={setNodeRef}
                    className={`relative max-w-full min-w-0 rounded-md border border-border bg-card shadow-panel transition-[border-color,box-shadow,opacity,background-color] duration-150 ease-[ease] ${canDragReorder ? "cursor-grab" : ""
                        } ${isDragging
                            ? ENTRY_CARD_DRAGGING_CLASS
                            : "motion-safe:hover:border-[color-mix(in_srgb,var(--primary)_45%,var(--border))] motion-safe:hover:shadow-floating"
                        }`.trim()}
                    data-entry-id={entry.id}
                    style={{ transform: CSS.Transform.toString(transform), transition }}
                    {...listeners}
                >
                    {showDragHandle ? (
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute top-2 right-2 z-10 flex items-center justify-center rounded-sm border border-overlay-button-line bg-overlay-button p-1 text-overlay-button-ink max-[720px]:hidden"
                        >
                            <GripVertical className="size-4" />
                        </span>
                    ) : null}
                    {!isRenaming && !moveControlsOpen ? (
                        <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    aria-label={`Actions for ${entry.name}`}
                                    className="absolute top-2 right-2 z-20 hidden border-overlay-button-line bg-overlay-button text-overlay-button-ink hover:bg-overlay-button max-[720px]:inline-flex"
                                    size="icon-sm"
                                    type="button"
                                    variant="outline"
                                    onClick={stopActionEvent}
                                    onPointerDown={stopActionEvent}
                                >
                                    <MoreVertical className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger>
                                        <Info />Get Info
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent className="w-52">
                                        {renderInfoContent()}
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuItem onSelect={startRename}>
                                    <Pencil />Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem disabled={listLocked} onSelect={onRerank}>
                                    <RefreshCw />Rerank
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={onPickImage}>
                                    <ImageIcon />
                                    {hasStoredImage(entry.imageKey) ? "Change Image" : "Pick Image"}
                                </DropdownMenuItem>
                                <DropdownMenuItem disabled={listLocked} onSelect={() => setMoveControlsOpen(true)}>
                                    <ArrowRightLeft />Change Category
                                </DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" disabled={listLocked} onSelect={onDelete}>
                                    <Trash2 />Delete
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                    <EntryPoster entry={entry} />
                    <div className="grid min-w-0 gap-[0.55rem] p-[0.65rem]">
                        {isRenaming ? (
                            <form className="grid gap-[0.45rem]" onSubmit={handleRenameSubmit}>
                                <span className="text-sm text-muted-foreground">#{entry.rankPosition + 1}</span>
                                <Input
                                    autoFocus
                                    aria-label={`Rename ${entry.name}`}
                                    value={renameValue}
                                    onChange={(event) => setRenameValue(event.target.value)}
                                />
                                <div className="grid grid-cols-2 gap-[0.45rem]">
                                    <Button size="sm" type="submit">Save</Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        type="button"
                                        onClick={() => {
                                            setRenameValue(entry.name);
                                            setIsRenaming(false);
                                        }}
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            </form>
                        ) : (
                            <div className="flex min-w-0 items-center gap-[0.45rem]">
                                <strong
                                    className="block min-w-0 flex-1 truncate text-[0.70rem] leading-tight wrap-normal"
                                    title={`#${position} ${entry.name} · Double-click to rename · Right-click for actions${canDragReorder ? " · Drag to reorder" : ""}`}
                                    onDoubleClick={startRename}
                                >
                                    #{position} {entry.name}
                                </strong>
                                {showPercentile ? (
                                    <span
                                        className="shrink-0 whitespace-nowrap rounded-full border border-primary/35 px-[0.36rem] py-[0.08rem] text-[0.62rem] leading-tight text-primary"
                                        title={`${position} of ${listSize}`}
                                    >
                                        {percentileLabel}
                                    </span>
                                ) : null}
                            </div>
                        )}
                        {moveControlsOpen ? (
                            <div className="grid gap-[0.55rem] rounded-sm border border-border bg-muted p-[0.65rem]">
                                <strong>Change Category</strong>
                                <div className="grid min-w-0 grid-cols-1 gap-[0.45rem]">
                                    <Select value={targetCategoryId} onValueChange={setTargetCategoryId}>
                                        <SelectTrigger aria-label={`Move ${entry.name}`} className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectGroup>
                                                {categories.map((category) => (
                                                    <SelectItem key={category.id} value={category.id}>
                                                        {category.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectGroup>
                                        </SelectContent>
                                    </Select>
                                    <div className="grid min-w-0 grid-cols-2 gap-[0.45rem]">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            type="button"
                                            onClick={() => setMoveControlsOpen(false)}
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            size="sm"
                                            disabled={listLocked || targetCategoryId === selectedCategoryId}
                                            type="button"
                                            onClick={() => onSwitch(targetCategoryId)}
                                        >
                                            Move
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </article>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <Info />Get Info
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-52">
                        {renderInfoContent()}
                    </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuItem
                    onSelect={startRename}
                >
                    <Pencil />Rename
                </ContextMenuItem>
                <ContextMenuItem disabled={listLocked} onSelect={onRerank}>
                    <RefreshCw />Rerank
                </ContextMenuItem>
                <ContextMenuItem onSelect={onPickImage}>
                    <ImageIcon />
                    {hasStoredImage(entry.imageKey) ? "Change Image" : "Pick Image"}
                </ContextMenuItem>
                <ContextMenuItem disabled={listLocked} onSelect={() => setMoveControlsOpen(true)}>
                    <ArrowRightLeft />Change Category
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" disabled={listLocked} onSelect={onDelete}>
                    <Trash2 />Delete
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

function percentileForPosition(position: number, total: number) {
    if (total <= 0) {
        return "100th";
    }

    const percentile = Math.max(1, Math.min(100, Math.ceil(((total - position + 1) / total) * 100)));
    return `${ordinal(percentile)}`;
}

function ordinal(value: number) {
    const remainder = value % 100;
    if (remainder >= 11 && remainder <= 13) {
        return `${value}th`;
    }

    switch (value % 10) {
        case 1:
            return `${value}st`;
        case 2:
            return `${value}nd`;
        case 3:
            return `${value}rd`;
        default:
            return `${value}th`;
    }
}

function EntryInfo({
    addedAt,
    percentileLabel,
    position,
    total
}: {
    addedAt: number;
    percentileLabel: string;
    position: number;
    total: number;
}) {
    const totalLabel = total > 0 ? String(total) : "0";

    return (
        <div className="grid gap-[0.4rem] px-2 py-1.5 text-xs">
            <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="text-muted-foreground">Added</span>
                <span className="min-w-0 truncate text-right">{formatDate(addedAt)}</span>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="text-muted-foreground">Position</span>
                <span className="min-w-0 truncate text-right">#{position} of {totalLabel}</span>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="text-muted-foreground">Percentile</span>
                <span className="min-w-0 truncate text-right">{percentileLabel}</span>
            </div>
        </div>
    );
}

export function EntryDragOverlay({ entry }: { entry: Entry }) {
    return (
        <article className="relative max-w-full min-w-0 rotate-[0.5deg] cursor-grabbing rounded-md border border-border bg-card shadow-floating">
            <span className="absolute top-2 right-2 z-10 flex items-center justify-center rounded-sm border border-overlay-button-line bg-overlay-button p-1 text-overlay-button-ink">
                <GripVertical className="size-4" />
            </span>
            <EntryPoster entry={entry} />
            <div className="grid min-w-0 gap-[0.55rem] p-[0.65rem]">
                <strong className="block truncate text-[0.70rem] leading-tight wrap-normal">
                    #{entry.rankPosition + 1} {entry.name}
                </strong>
            </div>
        </article>
    );
}

export function EntryPoster({
    entry
}: {
    entry: Entry;
}) {
    const [imageFailed, setImageFailed] = useState(false);

    useEffect(() => {
        setImageFailed(false);
    }, [entry.id, entry.imageKey]);

    return (
        <div className="relative grid overflow-hidden rounded-t-panel">
            {hasStoredImage(entry.imageKey) && !imageFailed ? (
                <img
                    className={`${POSTER_CLASS} block h-auto w-full max-w-full object-cover [grid-area:1/1]`}
                    src={`/api/images/${entry.id}?v=${encodeURIComponent(String(entry.imageKey))}`}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                    onError={() => setImageFailed(true)}
                />
            ) : (
                <div className={`${POSTER_CLASS} grid content-center place-items-center gap-[0.35rem] p-4 [grid-area:1/1]`}>
                    <span className="text-[1rem] leading-tight">{entry.name}</span>
                    <small className="text-[0.95rem] leading-tight text-muted-foreground">{isNoImageKey(entry.imageKey) ? "No image saved" : "No image"}</small>
                </div>
            )}
        </div>
    );
}
