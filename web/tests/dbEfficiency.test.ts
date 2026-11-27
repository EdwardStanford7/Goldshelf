import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "./helpers/sqliteD1";

const state = vi.hoisted(() => ({ db: null as D1Database | null }));
vi.mock("cloudflare:workers", () => ({ env: { IMAGES: {} } }));
vi.mock("../src/server/lib/db", () => ({
    getDb: () => state.db!, now: () => 99,
    all: async (s: D1PreparedStatement) => (await s.all()).results,
    first: async (s: D1PreparedStatement) => s.first()
}));
import { getActiveEntryAtRank, rewriteCategoryOrderStatements } from "../src/server/stores/entryStore";
import { readSharedShelf } from "../src/server/stores/sharedShelfStore";
import { releaseImageReferences } from "../src/server/lib/imageAssets";
import { pruneSessionPayloadsStatement } from "../src/server/lib/sessionRetention";
import { withVersionedDb, versionedDb } from "../src/server/lib/versionedDb";

const fixtures: ReturnType<typeof sqliteD1>[] = [];
function fixture() {
    const f = sqliteD1(); fixtures.push(f); state.db = f.db; return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) f.sqlite.close(); state.db = null; });
function addEntries(f: ReturnType<typeof sqliteD1>, count: number) {
    const insert = f.sqlite.prepare(`INSERT INTO entries(id,user_id,category_id,name,rank_position,status,created_at,updated_at)
      VALUES (?,'user','category',?,?,'active',1,1)`);
    for (let i = 0; i < count; i++) insert.run(`e${i}`, `Entry ${i}`, i);
}

describe("database work and invariants", () => {
    it("locates a binary pivot with one rank-index lookup", async () => {
        const f = fixture(); addEntries(f, 1000);
        expect((await getActiveEntryAtRank("user", "category", 711))?.id).toBe("e711");
        expect(f.queries).toHaveLength(1);
        const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${f.queries[0]}`).all("user", "category", 711);
        expect(plan.some((row) => String(row.detail).includes("rank_position=?"))).toBe(true);
        expect(await getActiveEntryAtRank("someone-else", "category", 711)).toBeNull();
    });

    it("updates membership counts once for a bulk insert and never rewrites counts on rank-only edits", async () => {
        const f = fixture();
        const dirtyPlan = f.sqlite.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM categories WHERE user_id=? AND data_revision=? AND count_dirty=1")
            .all("user", "token");
        expect(dirtyPlan.some((row) => String(row.detail).includes("idx_categories_dirty_counts"))).toBe(true);
        f.sqlite.exec(`CREATE TABLE count_writes(id TEXT);
          CREATE TRIGGER count_count_writes AFTER UPDATE OF active_entry_count ON categories
          BEGIN INSERT INTO count_writes VALUES(NEW.id); END;`);
        await withVersionedDb(f.db, "user", async () => {
            const db = versionedDb(f.db);
            const rows = Array.from({ length: 500 }, (_, i) => [`e${i}`, `Entry ${i}`, i]);
            await db.prepare(`INSERT INTO entries(id,user_id,category_id,name,rank_position,status,created_at,updated_at)
              SELECT json_extract(value,'$[0]'),'user','category',json_extract(value,'$[1]'),
                json_extract(value,'$[2]'),'active',1,1 FROM json_each(?)`).bind(JSON.stringify(rows)).run();
        });
        expect(f.sqlite.prepare("SELECT active_entry_count, count_dirty FROM categories").get())
            .toMatchObject({ active_entry_count: 500, count_dirty: 0 });
        expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM count_writes").get()?.n).toBe(2); // one stamp, one final count
        f.sqlite.exec("DELETE FROM count_writes");
        await withVersionedDb(f.db, "user", async () => {
            const db = versionedDb(f.db);
            await db.batch(rewriteCategoryOrderStatements(db, "user", "category",
                Array.from({ length: 500 }, (_, i) => `e${499 - i}`), 2));
        });
        expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM count_writes").get()?.n).toBe(1); // revision stamp only
        expect(f.sqlite.prepare("SELECT active_entry_count FROM categories").get()?.active_entry_count).toBe(500);
        expect(f.sqlite.prepare("SELECT rank_position FROM entries WHERE id='e0'").get()?.rank_position).toBe(499);
        const sql = f.queries.find((query) => query.includes("WITH requested_order"))!;
        const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(JSON.stringify(Array.from({ length: 500 }, (_, i) => `e${499 - i}`)), 2, "user", "category");
        expect(plan.filter((row) => String(row.detail).includes("SCAN json_each"))).toHaveLength(1);
        expect(plan.some((row) => String(row.detail).includes("CORRELATED SCALAR"))).toBe(false);
    });

    it("keeps counts correct across moves, status transitions, rollback, and unscoped cleanup", async () => {
        const f = fixture(); addEntries(f, 3);
        f.sqlite.exec(`INSERT INTO categories(id,user_id,name,sort_order,created_at,updated_at)
          VALUES('other','user','Other',1,1,1)`);
        await withVersionedDb(f.db, "user", async () => {
            const db = versionedDb(f.db);
            await db.batch([
                db.prepare("UPDATE entries SET category_id='other' WHERE id='e0'"),
                db.prepare("UPDATE entries SET status='ranking' WHERE id='e1'")
            ]);
        });
        expect(f.sqlite.prepare("SELECT active_entry_count AS n FROM categories ORDER BY id").all().map((row) => row.n)).toEqual([1, 1]);
        await expect(withVersionedDb(f.db, "user", () => {
            const db = versionedDb(f.db);
            return db.batch([db.prepare("DELETE FROM entries"), db.prepare("INSERT INTO categories(id) VALUES('category')")]);
        })).rejects.toThrow();
        expect(f.sqlite.prepare("SELECT SUM(active_entry_count) AS n FROM categories").get()?.n).toBe(2);
        f.sqlite.exec("DELETE FROM entries WHERE id='e0'; UPDATE entries SET status='active' WHERE id='e1'");
        expect(f.sqlite.prepare("SELECT active_entry_count FROM categories WHERE id='category'").get()?.active_entry_count).toBe(2);
        expect(f.sqlite.prepare("SELECT active_entry_count FROM categories WHERE id='other'").get()?.active_entry_count).toBe(0);
    });

    it("releases a hundred image keys in one guarded transaction and retains live references", async () => {
        const f = fixture(); addEntries(f, 1);
        const keys = Array.from({ length: 100 }, (_, i) => `legacy-image-${i}`);
        const insert = f.sqlite.prepare(`INSERT INTO image_assets(content_hash,object_key,content_type,byte_size,created_at,last_referenced_at)
          VALUES(?,?,'image/png',1,1,1)`);
        keys.forEach((key) => insert.run(key, key));
        f.sqlite.prepare('UPDATE "user" SET image=? WHERE id=\'user\'').run(keys[0]);
        f.sqlite.prepare("UPDATE entries SET image_key=? WHERE id='e0'").run(keys[1]);
        await withVersionedDb(f.db, "user", async () => {
            state.db = versionedDb(f.db);
            await releaseImageReferences([...keys, ...keys, null]);
        });
        expect(f.metrics.batches).toBe(1);
        expect(f.queries.filter((sql) => sql.startsWith("UPDATE image_assets"))).toHaveLength(1);
        expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM image_assets WHERE unreferenced_at=99").get()?.n).toBe(98);
        const plan = f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM "user" WHERE image=?').all(keys[0]);
        expect(plan.some((row) => String(row.detail).includes("idx_user_stored_image"))).toBe(true);
    });

    it("prunes only obsolete closed payloads, preserving valid Undo and recovery metadata", async () => {
        const f = fixture(); addEntries(f, 1);
        f.sqlite.exec("INSERT INTO user_data_versions VALUES('user',7)");
        const insert = f.sqlite.prepare(`INSERT INTO ranking_sessions(id,user_id,category_id,subject_entry_id,source,
          lower_bound,upper_bound,status,created_at,completed_at,undo_state,undo_revision,operation_state)
          VALUES(?,'user','category','e0','rerank_entry',0,1,?,1,1,?,?,'{}')`);
        insert.run("old", "completed", '{"expectedRevision":6}', 6);
        insert.run("valid", "completed", '{"expectedRevision":7}', 7);
        insert.run("cancelled", "cancelled", '{"expectedRevision":7}', 7);
        insert.run("active", "active", '{"expectedRevision":6}', 6);
        await pruneSessionPayloadsStatement(f.db, "ranking_sessions").run();
        expect(f.sqlite.prepare("SELECT id FROM ranking_sessions WHERE undo_state IS NOT NULL ORDER BY id").all().map((row) => row.id))
            .toEqual(["active", "valid"]);
        expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ranking_sessions").get()?.n).toBe(4);
    });

    it("updates FTS by stable document id only when indexed text changes", () => {
        const f = fixture();
        f.sqlite.exec("INSERT INTO user_profiles(user_id,slug,is_public,created_at,updated_at) VALUES('user','reader',1,1,1)");
        const id = f.sqlite.prepare("SELECT rowid FROM profile_search").get()?.rowid;
        const before = Number(f.sqlite.prepare("SELECT total_changes() AS n").get()?.n);
        f.sqlite.exec("UPDATE user_profiles SET slug=slug,is_public=0; UPDATE user SET name=name");
        expect(Number(f.sqlite.prepare("SELECT total_changes() AS n").get()?.n) - before).toBe(2);
        f.sqlite.exec("UPDATE user SET name='New Name'; UPDATE user_profiles SET slug='new-reader'");
        expect(f.sqlite.prepare("SELECT rowid,name,slug FROM profile_search").get()).toMatchObject({ rowid: id, name: "New Name", slug: "new-reader" });
        f.sqlite.exec("DELETE FROM user_profiles");
        expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM profile_search").get()?.n).toBe(0);
        expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM profile_search_ids").get()?.n).toBe(0);
    });

    it("rechecks current audience and blocks before returning a lazily loaded shelf", async () => {
        const f = fixture(); addEntries(f, 2);
        f.sqlite.exec(`INSERT INTO user_profiles(user_id,slug,is_public,created_at,updated_at) VALUES('user','reader',1,1,1);
          UPDATE categories SET visibility='public'`);
        expect((await readSharedShelf(f.db, "reader", "category"))?.entries).toHaveLength(2);
        f.sqlite.exec("UPDATE categories SET visibility='followers'");
        expect(await readSharedShelf(f.db, "reader", "category")).toBeNull();
        f.sqlite.exec(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('viewer','Viewer','viewer@test.local',0,1,1);
          INSERT INTO user_follows(follower_user_id,followed_user_id,status,created_at,accepted_at) VALUES('viewer','user','accepted',1,1)`);
        expect((await readSharedShelf(f.db, "reader", "category", "viewer"))?.entryCount).toBe(2);
        f.sqlite.exec("INSERT INTO user_blocks(blocker_user_id,blocked_user_id,created_at) VALUES('user','viewer',1)");
        expect(await readSharedShelf(f.db, "reader", "category", "viewer")).toBeNull();
        f.sqlite.exec("UPDATE categories SET visibility='private'");
        expect(await readSharedShelf(f.db, "reader", "category", "user")).toBeNull();
    });
});
