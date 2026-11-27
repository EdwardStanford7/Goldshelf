import { afterEach, expect, it, vi } from "vitest";
import { enableDashboardSnapshots, readDashboardSnapshot } from "../src/lib/dashboardCache";

afterEach(() => vi.unstubAllGlobals());
it("falls back cleanly when IndexedDB.open throws synchronously", async () => {
    vi.stubGlobal("window", { indexedDB: { open() { throw new Error("Storage disabled"); } } });
    enableDashboardSnapshots("user");
    await expect(readDashboardSnapshot("user")).resolves.toBeNull();
});
