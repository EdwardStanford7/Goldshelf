import { describe, expect, it } from "vitest";
import { sqliteD1 } from "./helpers/sqliteD1";
import { mutationRevision, stageMutation, versionedDb, withVersionedDb } from "../src/server/lib/versionedDb";

describe("versioned mutations", () => {
    it("updates a shelf revision once when a transaction rewrites many entries", async () => {
        const { db, sqlite } = sqliteD1();
        try {
            sqlite.exec(`CREATE TABLE revision_writes (category_id TEXT);
              CREATE TRIGGER count_revisions AFTER UPDATE OF data_revision ON categories
              BEGIN INSERT INTO revision_writes VALUES (NEW.id); END;`);
            await withVersionedDb(db, "user", async () => {
                const scoped = versionedDb(db);
                await scoped.batch(Array.from({ length: 100 }, (_, index) => scoped.prepare(`
                  INSERT INTO entries (id,user_id,category_id,name,rank_position,status,created_at,updated_at)
                  VALUES (?, 'user', 'category', ?, ?, 'active', 1, 1)`).bind(`e${index}`, `Entry ${index}`, index)));
            });
            expect(sqlite.prepare("SELECT COUNT(*) AS n FROM revision_writes").get()?.n).toBe(1);
        } finally { sqlite.close(); }
    });
    it("rejects a write calculated before another request committed", async () => {
        const { db, sqlite } = sqliteD1();
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => { started = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        try {
            const stale = withVersionedDb(db, "user", async () => {
                started(); await gate;
                await versionedDb(db).prepare("UPDATE categories SET name = 'stale' WHERE id = 'category'").run();
            });
            await ready;
            await withVersionedDb(db, "user", async () => {
                await versionedDb(db).prepare("UPDATE categories SET name = 'fresh' WHERE id = 'category'").run();
            });
            release();
            await expect(stale).rejects.toThrow("changed in another request");
            expect(sqlite.prepare("SELECT name FROM categories").get()?.name).toBe("fresh");
            expect(sqlite.prepare("SELECT * FROM mutation_guards").all()).toEqual([]);
        } finally { sqlite.close(); }
    });

    it("rolls a staged undo snapshot back with the failed transition", async () => {
        const { db, sqlite } = sqliteD1();
        try {
            await expect(withVersionedDb(db, "user", async () => {
                const scoped = versionedDb(db);
                stageMutation(scoped.prepare("UPDATE categories SET name = 'snapshot' WHERE id = 'category'"));
                await scoped.batch([scoped.prepare("INSERT INTO categories (id) VALUES ('category')")]);
            })).rejects.toThrow();
            expect(sqlite.prepare("SELECT name FROM categories").get()?.name).toBe("Books");
            expect(sqlite.prepare("SELECT * FROM user_data_versions").all()).toEqual([]);
        } finally { sqlite.close(); }
    });

    it("does not advance versions for read batches and permits account deletion", async () => {
        const { db, sqlite } = sqliteD1();
        try {
            await withVersionedDb(db, "user", async () => {
                const scoped = versionedDb(db);
                await scoped.batch([scoped.prepare("SELECT * FROM categories")]);
                expect(mutationRevision()).toBe(0);
                await scoped.prepare("DELETE FROM categories").run();
                await scoped.prepare('DELETE FROM "user"').run();
                await scoped.prepare("DELETE FROM image_assets").run();
            });
            expect(sqlite.prepare('SELECT * FROM "user"').all()).toEqual([]);
        } finally { sqlite.close(); }
    });
});
