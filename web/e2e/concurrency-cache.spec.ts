import type { Page } from "@playwright/test";
import { test, expect } from "./base";
import { ACTIVE_RANKING_LABEL, gotoApp, isServerFnRequest, openQueueWorkspace, seedUsers, serverFnResponse, signInViaApi } from "./helpers";

async function cachedCategoryCount(page: Page) {
    return page.evaluate(() => new Promise<number>((resolve) => {
        const request = indexedDB.open("goldshelf-client", 1);
        request.onerror = () => resolve(-1);
        request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction("dashboard-snapshots", "readonly");
            const read = transaction.objectStore("dashboard-snapshots").getAll();
            transaction.oncomplete = () => {
                const count = read.result.flatMap((snapshot) => snapshot.dashboard.categories)
                    .filter((category: { entries: unknown[] }) => category.entries.length > 0).length;
                db.close(); resolve(count);
            };
        };
    }));
}

test("a stale matchup answer from another tab is rejected and refreshed", async ({ page, context }) => {
    await seedUsers([{
        email: "match-version@e2e.test", name: "Match Version",
        categories: [{ name: "Books", entries: Array.from({ length: 100 }, (_, index) => `Book ${index}`) }],
        queuedEntries: [{ categoryName: "Books", name: "Zeta" }],
        queueSettings: { enabled: true, promptForMissingImages: false }
    }]);
    await signInViaApi(context, "match-version@e2e.test");
    await gotoApp(page);
    await openQueueWorkspace(page);
    await page.getByText("Zeta", { exact: true }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rank Now" }).click();
    await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible();
    const other = await context.newPage();
    await gotoApp(other);
    await expect(other.getByRole("button", { name: /^Zeta\b/ })).toBeVisible();
    const saved = serverFnResponse(page, "submitBinaryWinner");
    await page.getByRole("button", { name: /^Zeta\b/ }).click();
    await saved;
    await expect(page.getByText(/1 comparisons/)).toBeVisible();
    await other.getByRole("button", { name: /^Zeta\b/ }).click();
    await expect(other.getByText("This comparison changed in another tab. The current comparison has been loaded.")).toBeVisible();
    await expect(other.getByText(/1 comparisons/)).toBeVisible();
    await other.close();
});

test("unchanged shelves are restored locally after a reload without entry refetches", async ({ page, context }) => {
    await seedUsers([{
        email: "snapshot-reuse@e2e.test", name: "Snapshot Reuse",
        categories: [{ name: "Movies", entries: ["Arrival"] }, { name: "Books", entries: ["Hyperion"] }]
    }]);
    await signInViaApi(context, "snapshot-reuse@e2e.test");
    let loads = 0;
    page.on("request", (request) => { if (isServerFnRequest(request.url(), "loadCategoryEntries")) loads++; });
    await gotoApp(page);
    await page.getByRole("button", { name: /^Books · 1/ }).click();
    await expect(page.getByText("#1 Hyperion")).toBeVisible();
    await expect.poll(() => cachedCategoryCount(page)).toBe(2);
    const before = loads;
    await gotoApp(page);
    await expect(page.getByText("#1 Arrival")).toBeVisible();
    await page.getByRole("button", { name: /^Books · 1/ }).click();
    await expect(page.getByText("#1 Hyperion")).toBeVisible();
    expect(loads).toBe(before);
});

for (const blockStorage of [false, true]) test(`signing out clears private snapshots and signs out another open tab${blockStorage ? " when localStorage writes are disabled" : ""}`, async ({ page, context }) => {
    await seedUsers([{ email: "cache-signout@e2e.test", name: "Cache Signout", categories: [{ name: "Private", entries: ["Secret"] }] }]);
    await signInViaApi(context, "cache-signout@e2e.test");
    await gotoApp(page);
    await expect.poll(() => cachedCategoryCount(page)).toBe(1);
    const other = await context.newPage();
    await gotoApp(other);
    await gotoApp(page, "/profile");
    if (blockStorage) await page.evaluate(() => {
        Storage.prototype.setItem = () => { throw new Error("Storage disabled for test"); };
    });
    await page.getByRole("button", { name: "Sign Out", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(other).toHaveURL(/\/signin$/);
    await expect.poll(() => cachedCategoryCount(page)).toBe(0);
    await other.close();
});
