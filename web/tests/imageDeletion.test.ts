import { describe, expect, it } from "vitest";
import { sqliteD1 } from "./helpers/sqliteD1";

describe("durable image deletion fences", () => {
    it("rejects reattachment during deletion and after cleanup completes", () => {
        const { sqlite } = sqliteD1();
        const key = `entry-images/sha256/${"a".repeat(64)}`;
        try {
            sqlite.prepare(`INSERT INTO image_assets (content_hash,object_key,content_type,byte_size,created_at,last_referenced_at,deleting)
              VALUES ('hash',?,'image/png',1,1,1,1)`).run(key);
            const attach = () => sqlite.prepare(`INSERT INTO entries (id,user_id,category_id,name,rank_position,status,image_key,created_at,updated_at)
              VALUES ('entry','user','category','Entry',0,'active',?,1,1)`).run(key);
            expect(attach).toThrow("cleanup is in progress");
            sqlite.prepare("DELETE FROM image_assets WHERE object_key = ?").run(key);
            expect(attach).toThrow("cleanup is in progress");
            sqlite.prepare(`INSERT INTO image_assets (content_hash,object_key,content_type,byte_size,created_at,last_referenced_at)
              VALUES ('hash',?,'image/png',1,1,1)`).run(key);
            expect(attach).not.toThrow();
        } finally { sqlite.close(); }
    });
});
