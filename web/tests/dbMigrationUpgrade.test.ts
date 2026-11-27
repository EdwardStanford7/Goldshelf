import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("backfills counts and stable search documents when upgrading existing data", () => {
    const sqlite = new DatabaseSync(":memory:");
    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
    try {
        for (const name of names.filter((name) => name < "0036")) sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
        sqlite.exec(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES('user','Reader','reader@test.local',0,1,1);
          INSERT INTO user_profiles(user_id,slug,is_public,created_at,updated_at) VALUES('user','reader',1,1,1);
          INSERT INTO categories(id,user_id,name,sort_order,created_at,updated_at) VALUES('books','user','Books',0,1,1);
          INSERT INTO entries(id,user_id,category_id,name,rank_position,status,created_at,updated_at) VALUES
            ('active','user','books','Active',0,'active',1,1),
            ('ranking','user','books','Ranking',1,'ranking',1,1),
            ('deleted','user','books','Deleted',2,'deleted',1,1);
          INSERT INTO ranking_sessions(id,user_id,category_id,subject_entry_id,source,lower_bound,upper_bound,status,created_at,undo_state)
            VALUES('session','user','books','active','rerank_entry',0,1,'completed',1,'{"expectedRevision":7}');`);
        for (const name of names.filter((name) => name >= "0036")) sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
        expect(sqlite.prepare("SELECT active_entry_count,count_dirty FROM categories").get())
            .toMatchObject({ active_entry_count: 1, count_dirty: 0 });
        expect(sqlite.prepare("SELECT undo_revision FROM ranking_sessions").get()?.undo_revision).toBe(7);
        // The previous Worker writes only undo_state and uses the same guard
        // lifecycle. Both remain correct between migration and code rollout.
        sqlite.exec(`INSERT INTO mutation_guards VALUES('legacy','user',1);
          UPDATE entries SET status='active' WHERE id='ranking';
          DELETE FROM mutation_guards WHERE id='legacy';
          UPDATE ranking_sessions SET undo_state='{"expectedRevision":8}' WHERE id='session'`);
        expect(sqlite.prepare("SELECT active_entry_count,count_dirty FROM categories").get())
            .toMatchObject({ active_entry_count: 2, count_dirty: 0 });
        expect(sqlite.prepare("SELECT undo_revision FROM ranking_sessions").get()?.undo_revision).toBe(8);
        expect(sqlite.prepare("SELECT user_id FROM profile_search WHERE profile_search MATCH 'reader'").all()).toHaveLength(1);
        sqlite.exec("UPDATE user SET name='Bookworm'");
        expect(sqlite.prepare("SELECT user_id FROM profile_search WHERE profile_search MATCH 'bookworm'").all()).toHaveLength(1);
        sqlite.exec('DELETE FROM "user"');
        expect(sqlite.prepare("SELECT COUNT(*) AS n FROM profile_search").get()?.n).toBe(0);
        expect(sqlite.prepare("SELECT COUNT(*) AS n FROM profile_search_ids").get()?.n).toBe(0);
    } finally { sqlite.close(); }
});
