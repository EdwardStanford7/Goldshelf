import { describe, expect, it } from "vitest";
import { sqliteD1 } from "./helpers/sqliteD1";
import { followRequestStatement } from "../src/server/stores/followStore";

function fixture() {
    const fixture = sqliteD1();
    fixture.sqlite.exec(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt)
      VALUES ('owner','Owner','owner@test.local',0,1,1);
      INSERT INTO user_profiles (user_id,slug,is_public,created_at,updated_at)
      VALUES ('owner','owner',1,1,1)`);
    return fixture;
}

describe("follow privacy at commit", () => {
    it("requires approval if the owner became private after the initial read", async () => {
        const { sqlite, db } = fixture();
        try {
            expect(sqlite.prepare("SELECT is_public FROM user_profiles").get()?.is_public).toBe(1);
            const statement = followRequestStatement(db, "user", "owner", 2);
            sqlite.exec("UPDATE user_profiles SET is_public = 0 WHERE user_id = 'owner'");
            await statement.run();
            expect(sqlite.prepare("SELECT status, accepted_at FROM user_follows").get()).toMatchObject({ status: "pending", accepted_at: null });
        } finally { sqlite.close(); }
    });
    it("cannot recreate a follow after a concurrent block", async () => {
        const { sqlite, db } = fixture();
        try {
            const statement = followRequestStatement(db, "user", "owner", 2);
            sqlite.exec("INSERT INTO user_blocks (blocker_user_id,blocked_user_id,created_at) VALUES ('owner','user',2)");
            await statement.run();
            expect(sqlite.prepare("SELECT * FROM user_follows").all()).toEqual([]);
        } finally { sqlite.close(); }
    });
});
