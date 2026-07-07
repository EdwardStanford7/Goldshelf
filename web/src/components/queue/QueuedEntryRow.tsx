import type { FormEvent, MouseEvent } from "react";
import { useEffect, useState } from "react";
import { Image as ImageIcon, MoreVertical, Pencil, Swords, Trash2 } from "lucide-react";
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
import { hasStoredImage, isNoImageKey } from "@/lib/images";
import type { QueuedEntry } from "@/lib/types";

export function QueuedEntryRow({
    entry,
    metadataDisabled,
    onDelete,
    onPickImage,
    onRename,
    rankLocked,
    selected = false,
    selectionMode = false,
    onSelect,
    onStart
}: {
    entry: QueuedEntry;
    metadataDisabled: boolean;
    onDelete: (entry: QueuedEntry) => Promise<void>;
    onPickImage: (entry: QueuedEntry) => void;
    onRename: (entry: QueuedEntry, name: string) => Promise<void>;
    rankLocked: boolean;
    selected?: boolean;
    selectionMode?: boolean;
    onSelect?: (event: MouseEvent<HTMLElement>, options?: { forceAdditive?: boolean }) => void;
    onStart: (entry: QueuedEntry) => Promise<void>;
}) {
    const [isRenaming, setIsRenaming] = useState(false);
    const [name, setName] = useState(entry.name);
    useEscapeKey(isRenaming, () => { setName(entry.name); setIsRenaming(false); });

    useEffect(() => {
        setName(entry.name);
        setIsRenaming(false);
    }, [entry.name]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        await onRename(entry, name);
        setIsRenaming(false);
    }

    function startRename() {
        setName(entry.name);
        setIsRenaming(true);
    }

    function stopActionEvent(event: { stopPropagation: () => void }) {
        event.stopPropagation();
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild disabled={metadataDisabled || selectionMode}>
                <div
                    className={`relative grid min-w-0 ${selectionMode ? "grid-cols-[auto_54px_minmax(0,1fr)] cursor-pointer" : "grid-cols-[54px_minmax(0,1fr)]"} items-start gap-[0.55rem] rounded-sm border p-[0.65rem] max-[720px]:pr-10 ${selected
                        ? "border-primary bg-accent"
                        : "border-border bg-muted"
                        }`}
                    onClick={(event) => {
                        if (selectionMode) {
                            onSelect?.(event);
                        }
                    }}
                >
                    {selectionMode ? (
                        <input
                            aria-label={`Select queued ${entry.name}`}
                            checked={selected}
                            className="mt-1 w-auto"
                            onClick={(event) => {
                                event.stopPropagation();
                                onSelect?.(event, { forceAdditive: !event.shiftKey });
                            }}
                            readOnly
                            type="checkbox"
                        />
                    ) : null}
                    {!isRenaming && !selectionMode ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    aria-label={`Actions for queued ${entry.name}`}
                                    className="absolute top-2 right-1.5 z-20 hidden max-[720px]:inline-flex"
                                    disabled={metadataDisabled}
                                    size="icon-sm"
                                    type="button"
                                    variant="ghost"
                                    onClick={stopActionEvent}
                                    onPointerDown={stopActionEvent}
                                >
                                    <MoreVertical className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem disabled={rankLocked} onSelect={() => void onStart(entry)}>
                                    <Swords />Rank Now
                                </DropdownMenuItem>
                                <DropdownMenuItem disabled={metadataDisabled} onSelect={startRename}>
                                    <Pencil />Rename
                                </DropdownMenuItem>
                                <DropdownMenuItem disabled={metadataDisabled} onSelect={() => onPickImage(entry)}>
                                    <ImageIcon />
                                    {hasStoredImage(entry.imageKey) ? "Change image" : "Pick image"}
                                </DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" disabled={metadataDisabled} onSelect={() => void onDelete(entry)}>
                                    <Trash2 />Remove
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : null}
                    <QueuedPoster entry={entry} />
                    <div className="grid min-w-0 gap-[0.55rem]">
                        {isRenaming ? (
                            <form className="grid gap-[0.45rem]" onSubmit={handleSubmit}>
                                <Input
                                    autoFocus
                                    aria-label={`Rename ${entry.name}`}
                                    disabled={metadataDisabled}
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                />
                                <div className="grid grid-cols-2 gap-[0.45rem]">
                                    <Button size="sm" disabled={metadataDisabled} type="submit">Save</Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={metadataDisabled}
                                        type="button"
                                        onClick={() => {
                                            setName(entry.name);
                                            setIsRenaming(false);
                                        }}
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            </form>
                        ) : (
                            <div
                                title="Double-click to rename · Right-click for actions"
                                onDoubleClick={() => {
                                    if (!metadataDisabled && !selectionMode) {
                                        startRename();
                                    }
                                }}
                            >
                                <strong>{entry.name}</strong>
                                <p className="m-0 mt-[0.2rem] text-muted-foreground">{entry.categoryName}</p>
                            </div>
                        )}
                    </div>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem disabled={rankLocked} onSelect={() => void onStart(entry)}>
                    <Swords />Rank Now
                </ContextMenuItem>
                <ContextMenuItem
                    disabled={metadataDisabled}
                    onSelect={startRename}
                >
                    <Pencil />Rename
                </ContextMenuItem>
                <ContextMenuItem disabled={metadataDisabled} onSelect={() => onPickImage(entry)}>
                    <ImageIcon />
                    {hasStoredImage(entry.imageKey) ? `Change image` : `Pick image`}
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" disabled={metadataDisabled} onSelect={() => void onDelete(entry)}>
                    <Trash2 />Remove
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

function QueuedPoster({ entry }: { entry: QueuedEntry }) {
    const [imageFailed, setImageFailed] = useState(false);

    useEffect(() => {
        setImageFailed(false);
    }, [entry.id, entry.imageKey]);

    if (hasStoredImage(entry.imageKey) && !imageFailed) {
        return (
            <img
                className="block aspect-4/5 h-auto w-13.5 overflow-hidden rounded-[5px] border border-border object-cover"
                src={`/api/queued-images/${entry.id}?v=${encodeURIComponent(String(entry.imageKey))}`}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => setImageFailed(true)}
            />
        );
    }

    return (
        <div className="grid aspect-4/5 w-13.5 content-center place-items-center gap-[0.35rem] overflow-hidden rounded-[5px] border border-border bg-[linear-gradient(135deg,var(--poster-start),var(--poster-end))] text-center text-[0.8rem] text-muted-foreground">
            <span className="text-[1rem] leading-tight">{entry.name}</span>
            {isNoImageKey(entry.imageKey) ? <small className="text-[0.78rem] leading-tight text-muted-foreground">No image</small> : null}
        </div>
    );
}
