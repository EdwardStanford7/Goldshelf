import type { FormEvent } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { currentDateTimestamp } from "@/lib/format";
import { Input } from "@/components/ui/input";

export function ImportSpreadsheetToast({
    busy,
    busyLabel,
    disabled,
    onClose,
    onImport
}: {
    busy: boolean;
    busyLabel: string | null;
    disabled: boolean;
    onClose: () => void;
    onImport: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
    const defaultAddedDate = new Date(currentDateTimestamp()).toISOString().slice(0, 10);

    return (
        <form
            className="fixed right-4 bottom-4 z-50 grid w-[min(26rem,calc(100vw-2rem))] grid-cols-[minmax(0,1fr)] items-stretch gap-[0.6rem] rounded-md border border-border bg-card p-[0.65rem] shadow-floating"
            onSubmit={(event) => void onImport(event)}
        >
            <div className="flex items-center justify-between gap-3">
                <strong>Import Spreadsheet</strong>
                <Button
                    aria-label="Close import"
                    disabled={busy}
                    size="icon-sm"
                    title="Close import"
                    type="button"
                    variant="ghost"
                    onClick={onClose}
                >
                    <X />
                </Button>
            </div>
            <label className="grid min-w-0 content-start gap-[0.35rem]">
                <span className="text-muted-foreground">Added date</span>
                <Input defaultValue={defaultAddedDate} disabled={disabled} name="addedAt" type="date" />
            </label>
            <label className="grid min-w-0 content-start gap-[0.35rem]">
                <span className="text-muted-foreground">Workbook</span>
                <Input disabled={disabled} name="workbook" type="file" accept=".xlsx" />
            </label>
            <Button disabled={disabled} type="submit">
                {busyLabel?.startsWith("Import") ? "Importing..." : "Import"}
            </Button>
        </form>
    );
}
