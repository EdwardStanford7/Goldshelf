import { readSheet } from "read-excel-file/universal";
import writeXlsxFile from "write-excel-file/universal";
import { describe, expect, it } from "vitest";
import { parseLegacyWorkbook, writeExportWorkbook } from "../src/lib/importExport";
import type { CategoryWithEntries, Entry, QueuedEntry } from "../src/lib/types";

describe("xlsx export", () => {
    it("does not write blank padding cells in shorter category columns", async () => {
        const blob = await writeExportWorkbook([
            category("Books", [entry("Dune", 0)]),
            category("Movies", [
                entry("Alien", 0),
                entry("Arrival", 1),
                entry("Heat", 2)
            ])
        ]);

        const rows = await readSheet(await blob.arrayBuffer(), "Sorted");

        expect(rows[0]?.[0]).toBe("Books");
        expect(rows[1]?.[0]).toBe("Dune");
        expect(rows[2]?.[0] ?? null).toBeNull();
        expect(rows[3]?.[0] ?? null).toBeNull();
        expect(rows[3]?.[1]).toBe("Heat");
    });

    it("writes queued entries on a Queue sheet", async () => {
        const blob = await writeExportWorkbook(
            [category("Books", [])],
            [queuedEntry("Books", "Dune")]
        );
        const buffer = await blob.arrayBuffer();
        const rows = await readSheet(buffer, "Queue");
        const parsed = await parseLegacyWorkbook(buffer, null);

        expect(rows[0]).toEqual(["category", "entry", "added_at"]);
        expect(rows[1]).toEqual(["Books", "Dune", 1000]);
        expect(parsed.entries).toEqual([]);
        expect(parsed.queuedEntries).toEqual([{
            categoryName: "Books",
            name: "Dune",
            createdAt: 1000
        }]);
    });

    it("rejects exports with no ranked or queued entries", async () => {
        await expect(writeExportWorkbook([category("Books", [])])).rejects.toThrow("at least one ranked or queued entry");
    });
});

describe("xlsx import", () => {
    it("keeps legacy sorted-sheet imports compatible", async () => {
        const blob = await writeXlsxFile([
            { sheet: "Sorted", data: [["Books"], ["Dune"]] }
        ]).toBlob();

        await expect(parseLegacyWorkbook(await blob.arrayBuffer(), 123)).resolves.toEqual({
            entries: [{
                categoryName: "Books",
                name: "Dune",
                rankPosition: 0,
                createdAt: 123
            }],
            queuedEntries: []
        });
    });

    it("parses queue-only workbooks", async () => {
        const blob = await writeXlsxFile([
            {
                sheet: "Queue",
                data: [
                    ["category", "entry", "first_consumed_at", "available_at", "created_at"],
                    ["Movies", "Alien", 111, 222, 333]
                ]
            }
        ]).toBlob();

        await expect(parseLegacyWorkbook(await blob.arrayBuffer(), null)).resolves.toEqual({
            entries: [],
            queuedEntries: [{
                categoryName: "Movies",
                name: "Alien",
                createdAt: 111
            }]
        });
    });

    it("accepts added_at as a queue date alias", async () => {
        const blob = await writeXlsxFile([
            {
                sheet: "Queue",
                data: [
                    ["category", "entry", "added_at", "available_at", "created_at"],
                    ["Books", "Dune", 444, 555, 666]
                ]
            }
        ]).toBlob();

        const parsed = await parseLegacyWorkbook(await blob.arrayBuffer(), null);

        expect(parsed.queuedEntries).toEqual([{
            categoryName: "Books",
            name: "Dune",
            createdAt: 444
        }]);
    });

    it("rejects spreadsheets with no importable entries", async () => {
        const blob = await writeXlsxFile([{ sheet: "Blank", data: [] }]).toBlob();

        await expect(parseLegacyWorkbook(await blob.arrayBuffer(), null)).rejects.toThrow("no importable entries");
    });
});

function category(name: string, entries: Entry[]): CategoryWithEntries {
    return {
        id: name.toLowerCase(),
        name,
        sortOrder: 0,
        createdAt: 0,
        isPublic: false,
        entries
    };
}

function entry(name: string, rankPosition: number): Entry {
    return {
        id: name.toLowerCase(),
        categoryId: "category",
        name,
        rankPosition,
        imageKey: null,
        createdAt: 0
    };
}

function queuedEntry(categoryName: string, name: string): QueuedEntry {
    return {
        id: name.toLowerCase(),
        categoryId: categoryName.toLowerCase(),
        categoryName,
        name,
        imageKey: null,
        createdAt: 1000
    };
}
