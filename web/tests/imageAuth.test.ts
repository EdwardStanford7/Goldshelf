import { expect, it, vi } from "vitest";
import { sqliteD1 } from "./helpers/sqliteD1";
const state = vi.hoisted(() => ({ db: null as D1Database | null,
    getSession: vi.fn(async (_input: unknown) => ({ user: { id: "user" } })) }));
vi.mock("cloudflare:workers", () => ({ env: { get DB() { return state.db; } } }));
vi.mock("../src/server/lib/auth", () => ({ auth: { api: { getSession: state.getSession } } }));
import { imageRequestSession, versionedImageHandlers } from "../src/server/lib/imageMutationScope";

it("shares image authentication within one Request and rechecks the next Request", async () => {
    const { db, sqlite } = sqliteD1(); state.db = db;
    try {
        const handler = versionedImageHandlers({ POST: async ({ request }: { request: Request }) => {
            const session = await imageRequestSession(request);
            return Response.json({ id: session?.user.id });
        } }).POST;
        const request = new Request("https://goldshelf.test/api/profile-image", { method: "POST" });
        expect((await handler({ request })).ok).toBe(true);
        expect(state.getSession).toHaveBeenCalledTimes(1);
        await handler({ request: new Request(request) });
        expect(state.getSession).toHaveBeenCalledTimes(2);
    } finally { sqlite.close(); state.db = null; }
});
