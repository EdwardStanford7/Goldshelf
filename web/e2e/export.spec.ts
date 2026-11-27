import { readFile } from "node:fs/promises";
import { test, expect } from "./base";
import { gotoApp, isServerFnRequest, seedUsers, signInViaApi } from "./helpers";
import type { Route } from "@playwright/test";
import { securityPolicy } from "../src/lib/securityPolicy";
import { parseLegacyWorkbook } from "../src/lib/importExport";
import { EXPORT_TIMEOUT_MS } from "../src/lib/exportTimeout";

test("a large spreadsheet exports under the production security policy", async ({ page, context }) => {
    const title = (index: number) => `Entry ${index}: ${"A book with a moderately long title. ".repeat(3)}`;
    await seedUsers([{ email: "large-export@e2e.test", name: "Large Export", categories: [
        { name: "Books", entries: Array.from({ length: 600 }, (_, i) => title(i)) },
        { name: "Films", entries: Array.from({ length: 600 }, (_, i) => title(i + 600)) }
    ], queuedEntries: [{ categoryName: "Books", name: "Queued Book" }, { categoryName: "Films", name: "Queued Film" }] }]);
    await signInViaApi(context, "large-export@e2e.test");
    await page.route("**/*", async (route) => {
        if (!route.request().isNavigationRequest()) return route.continue();
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": securityPolicy() } });
    });
    await gotoApp(page);
    let workers = 0;
    page.on("worker", () => workers++);
    const downloaded = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByRole("button", { name: "Import & export", exact: true }).click();
    await page.getByRole("button", { name: "Export xlsx", exact: true }).click();
    const download = await downloaded;
    const path = await download.path();
    expect(path).toBeTruthy();
    const bytes = await readFile(path!);
    const workbook = await parseLegacyWorkbook(new Uint8Array(bytes).buffer, null);
    expect(workbook.entries).toHaveLength(1200);
    expect(workbook.queuedEntries).toHaveLength(2);
    expect(new Set(workbook.entries.map((entry) => entry.categoryName))).toEqual(new Set(["Books", "Films"]));
    expect(workers).toBeGreaterThan(0);
    await expect(page.locator("main[aria-busy=true]")).toHaveCount(0);
});

test("a stalled export stops loading and reports an error", async ({ page, context }) => {
    await seedUsers([{ email: "stalled-export@e2e.test", name: "Stalled Export",
        categories: [{ name: "Books", entries: ["Dune"] }] }]);
    await signInViaApi(context, "stalled-export@e2e.test");
    await gotoApp(page);
    await page.clock.install();
    let pending: Route | undefined;
    await page.route("**/_serverFn/**", (route) => {
        if (isServerFnRequest(route.request().url(), "loadDashboard")) { pending = route; return; }
        return route.continue();
    });
    const requested = page.waitForRequest((request) => isServerFnRequest(request.url(), "loadDashboard"));
    await page.getByRole("button", { name: "Import & export", exact: true }).click();
    await page.getByRole("button", { name: "Export xlsx", exact: true }).click();
    await requested;
    await expect(page.getByText("Loading export data...", { exact: true })).toBeVisible();
    await page.clock.fastForward(EXPORT_TIMEOUT_MS + 1);
    await expect(page.getByText("Export took too long. Please try again.", { exact: true })).toBeVisible();
    await expect(page.locator("main[aria-busy=true]")).toHaveCount(0);
    await pending?.abort();
});
