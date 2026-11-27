import { describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "./helpers/sqliteD1";
vi.mock("../src/server/lib/db", () => ({
    all: async (statement: D1PreparedStatement) => (await statement.all()).results,
    first: async (statement: D1PreparedStatement) => statement.first()
}));
import { saveRankingMatchUndoState, restoreRankingMatchUndoState, type RankingUndoSourceRow } from "../src/server/engine/sessionUndo";
import { versionedDb, withVersionedDb } from "../src/server/lib/versionedDb";

async function completedRanking() {
    const fixture = sqliteD1();
    const { sqlite, db } = fixture;
    const insert = sqlite.prepare(`INSERT INTO entries (id,user_id,category_id,name,rank_position,status,created_at,updated_at)
      VALUES (?, 'user', 'category', ?, ?, 'active', 1, 1)`);
    for (let index = 0; index < 200; index++) insert.run(`e${index}`, `Entry ${index}`, index);
    sqlite.exec(`INSERT INTO ranking_sessions (id,user_id,category_id,subject_entry_id,source,lower_bound,upper_bound,status,created_at)
      VALUES ('session','user','category','e0','rerank_entry',0,199,'active',1)`);
    await withVersionedDb(db, "user", async () => {
        const scoped = versionedDb(db);
        const row = sqlite.prepare("SELECT * FROM ranking_sessions").get() as unknown as RankingUndoSourceRow;
        await saveRankingMatchUndoState(scoped, "user", row);
        await scoped.batch([
            scoped.prepare("UPDATE entries SET rank_position = 199 - rank_position"),
            scoped.prepare("UPDATE ranking_sessions SET status = 'completed' WHERE id = 'session'")
        ]);
    });
    const snapshot = sqlite.prepare("SELECT undo_state FROM ranking_sessions").get()?.undo_state as string;
    return { ...fixture, snapshot };
}

describe("ranking undo integrity", () => {
    it("atomically restores a large category and reopens its session", async () => {
        const { sqlite, db, snapshot } = await completedRanking();
        try {
            await withVersionedDb(db, "user", () => restoreRankingMatchUndoState(versionedDb(db), "user", snapshot, { claimActiveOperation: true }));
            expect(sqlite.prepare("SELECT rank_position FROM entries WHERE id = 'e0'").get()?.rank_position).toBe(0);
            expect(sqlite.prepare("SELECT rank_position FROM entries WHERE id = 'e199'").get()?.rank_position).toBe(199);
            expect(sqlite.prepare("SELECT status FROM ranking_sessions").get()?.status).toBe("active");
            expect(sqlite.prepare("SELECT session_id FROM active_user_operations").get()?.session_id).toBe("session");
        } finally { sqlite.close(); }
    });
    it("rejects an old snapshot after a newer edit", async () => {
        const { sqlite, db, snapshot } = await completedRanking();
        try {
            await withVersionedDb(db, "user", async () => {
                await versionedDb(db).prepare("UPDATE entries SET status = 'deleted' WHERE id = 'e0'").run();
            });
            await expect(withVersionedDb(db, "user", () =>
                restoreRankingMatchUndoState(versionedDb(db), "user", snapshot, { claimActiveOperation: true })))
                .rejects.toThrow("data has changed");
            expect(sqlite.prepare("SELECT status FROM entries WHERE id = 'e0'").get()?.status).toBe("deleted");
            expect(sqlite.prepare("SELECT * FROM active_user_operations").all()).toEqual([]);
        } finally { sqlite.close(); }
    });
});
