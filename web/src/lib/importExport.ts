import readXlsxFile from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import type { SheetData as WriteSheetData } from "write-excel-file/universal";
import type {
    CategoryWithEntries,
    ParsedImport,
    ParsedImportEntry,
    ParsedImportQueuedEntry,
    QueuedEntry
} from "./types";

const ENTRY_METADATA_HEADERS = [
    "category",
    "entry",
    "rank_position",
    "added_at"
];
const QUEUE_HEADERS = [
    "category",
    "entry",
    "added_at"
];

export async function parseLegacyWorkbook(
    buffer: ArrayBuffer,
    defaultAddedAt: number | null
): Promise<ParsedImport> {
    const sheets = await readXlsxFile(buffer);
    const sortedSheet = sheets.find((sheet) => sheet.sheet === "Sorted") ??
        sheets.find((sheet) => normalizeHeader(sheet.sheet) !== "queue");
    const rows = sortedSheet?.data ?? [];
    const entries = parseSortedRows(rows, defaultAddedAt);
    const queueSheet = sheets.find((sheet) => normalizeHeader(sheet.sheet) === "queue");
    const queuedEntries = queueSheet ? parseQueueRows(queueSheet.data) : [];

    if (entries.length === 0 && queuedEntries.length === 0) {
        throw new Error("Spreadsheet contains no importable entries. Put category names in the first row and entries below them.");
    }

    return { entries, queuedEntries };
}

function parseSortedRows(
    rows: unknown[][],
    defaultAddedAt: number | null
): ParsedImportEntry[] {
    const headers = rows[0] ?? [];
    const entries: ParsedImportEntry[] = [];

    for (let column = 0; column < headers.length; column += 1) {
        const categoryName = String(headers[column] ?? "").trim();
        if (!categoryName) {
            continue;
        }

        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
            const name = String(rows[rowIndex]?.[column] ?? "").trim();
            if (!name) {
                continue;
            }

            entries.push({
                categoryName,
                name,
                rankPosition: rowIndex - 1,
                createdAt: defaultAddedAt
            });
        }
    }

    return entries;
}

function parseQueueRows(rows: unknown[][]): ParsedImportQueuedEntry[] {
    const headers = rows[0] ?? [];
    const categoryColumn = findHeader(headers, ["category", "category_name"]);
    const entryColumn = findHeader(headers, ["entry", "entry_name", "name"]);
    if (categoryColumn < 0 || entryColumn < 0) {
        return [];
    }

    const addedColumn = findHeader(headers, ["added_at", "added", "created_at", "created", "first_consumed_at", "first_consumed", "consumed_at"]);
    const queuedEntries: ParsedImportQueuedEntry[] = [];

    for (const row of rows.slice(1)) {
        const categoryName = cellText(row[categoryColumn]);
        const name = cellText(row[entryColumn]);
        if (!categoryName || !name) {
            continue;
        }

        queuedEntries.push({
            categoryName,
            name,
            createdAt: addedColumn >= 0 ? timestampCell(row[addedColumn]) : null
        });
    }

    return queuedEntries;
}

export async function writeExportWorkbook(
    categories: CategoryWithEntries[],
    queuedEntries: QueuedEntry[] = []
): Promise<Blob> {
    const entryCount = categories.reduce((count, category) => count + category.entries.length, 0);
    if (entryCount === 0 && queuedEntries.length === 0) {
        throw new Error("Export requires at least one ranked or queued entry");
    }

    const entryMetadata = categories.flatMap((category) =>
        category.entries.map((entry) => ({
            category: category.name,
            entry: entry.name,
            rank_position: entry.rankPosition,
            added_at: entry.createdAt
        }))
    );
    const queueMetadata = [...queuedEntries]
        .sort((left, right) =>
            left.createdAt - right.createdAt ||
            left.name.localeCompare(right.name)
        )
        .map((entry) => ({
            category: entry.categoryName,
            entry: entry.name,
            added_at: entry.createdAt
        }));

    const workbook = writeXlsxFile([
        { sheet: "Sorted", data: sortedSheetData(categories) },
        { sheet: "Entry Metadata", data: objectSheetData(entryMetadata, ENTRY_METADATA_HEADERS) },
        { sheet: "Queue", data: objectSheetData(queueMetadata, QUEUE_HEADERS) }
    ]);

    return workbook.toBlob();
}

function sortedSheetData(categories: CategoryWithEntries[]): WriteSheetData {
    const data: WriteSheetData = [];

    categories.forEach((category, categoryIndex) => {
        setCell(data, 0, categoryIndex, category.name);

        category.entries.forEach((entry, entryIndex) => {
            setCell(data, entryIndex + 1, categoryIndex, entry.name);
        });
    });

    return data;
}

function setCell(data: WriteSheetData, rowIndex: number, columnIndex: number, value: string) {
    const row = data[rowIndex] ?? (data[rowIndex] = []);
    row[columnIndex] = value;
}

function objectSheetData(
    rows: Record<string, string | number | null>[],
    headers: string[]
): WriteSheetData {
    if (headers.length === 0) {
        return [];
    }

    return [
        headers,
        ...rows.map((row) => headers.map((header) => row[header] ?? ""))
    ];
}

function findHeader(
    headers: unknown[],
    candidates: string[]
) {
    const normalizedCandidates = new Set(candidates.map(normalizeHeader));
    return headers.findIndex((header) => normalizedCandidates.has(normalizeHeader(String(header ?? ""))));
}

function normalizeHeader(value: string) {
    return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function cellText(value: unknown) {
    return value instanceof Date ? value.toISOString() : String(value ?? "").trim();
}

function timestampCell(value: unknown) {
    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.floor(value);
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        const numericValue = Number(trimmed);
        if (Number.isFinite(numericValue)) {
            return Math.floor(numericValue);
        }

        const parsedDate = Date.parse(trimmed);
        return Number.isFinite(parsedDate) ? parsedDate : null;
    }

    return null;
}
