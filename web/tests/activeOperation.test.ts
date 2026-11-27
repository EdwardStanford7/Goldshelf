import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runIdleMutation } from "../src/server/lib/activeOperation";

// Execute the D1 statements against SQLite so these tests exercise the actual
// constraint and rollback behavior, including the release at batch completion.
function fixture() {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE active_user_operations (
        user_id TEXT PRIMARY KEY, kind TEXT, session_id TEXT UNIQUE, created_at INTEGER);
        CREATE TABLE items (id TEXT PRIMARY KEY); INSERT INTO items VALUES ('original');`);
    const db = {
        prepare(sql: string) {
            let values: unknown[] = [];
            const statement = {
                bind(...args: unknown[]) { values = args; return statement; },
                execute() { return sqlite.prepare(sql).run(...values as (string | number | null)[]); }
            };
            return statement;
        },
        async batch(statements: { execute: () => unknown }[]) {
            sqlite.exec("BEGIN");
            try {
                const result = statements.map((statement) => statement.execute());
                sqlite.exec("COMMIT");
                return result;
            } catch (error) {
                sqlite.exec("ROLLBACK");
                throw error;
            }
        }
    } as unknown as D1Database;
    return { db, sqlite };
}

describe("structural mutation operation lock", () => {
    for (const kind of ["ranking", "repair"]) {
        it(`protects ranked data during ${kind}`, async () => {
            const { db, sqlite } = fixture();
            try {
                sqlite.prepare("INSERT INTO active_user_operations VALUES (?, ?, ?, ?)").run("user", kind, "session", 1);
                await expect(runIdleMutation(db, "user", [db.prepare("DELETE FROM items")])).rejects.toThrow("Finish or cancel");
                expect(sqlite.prepare("SELECT id FROM items").get()?.id).toBe("original");
                expect(sqlite.prepare("SELECT session_id FROM active_user_operations").get()?.session_id).toBe("session");
            } finally { sqlite.close(); }
        });
    }

    it("releases the slot when an edit succeeds", async () => {
        const { db, sqlite } = fixture();
        try {
            await runIdleMutation(db, "user", [db.prepare("DELETE FROM items")]);
            expect(sqlite.prepare("SELECT * FROM items").all()).toEqual([]);
            expect(sqlite.prepare("SELECT * FROM active_user_operations").all()).toEqual([]);
        } finally { sqlite.close(); }
    });

    it("rolls back edits and releases the slot if a later statement fails", async () => {
        const { db, sqlite } = fixture();
        try {
            await expect(runIdleMutation(db, "user", [
                db.prepare("DELETE FROM items"),
                db.prepare("INSERT INTO items VALUES ('duplicate'), ('duplicate')")
            ])).rejects.toThrow();
            expect(sqlite.prepare("SELECT id FROM items").get()?.id).toBe("original");
            expect(sqlite.prepare("SELECT * FROM active_user_operations").all()).toEqual([]);
        } finally { sqlite.close(); }
    });
});
