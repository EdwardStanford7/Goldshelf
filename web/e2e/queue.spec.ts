import type { Page } from "@playwright/test";
import { test, expect } from "./base";
import { gotoApp, openAccountMenu, seedUsers, serverFnResponse, signInViaApi, TEST_PASSWORD, winMatchups } from "./helpers";

const QUINN = {
    email: "quinn@e2e.test",
    name: "Quinn",
    categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }]
};

const QUEUE_SCOPE_USER = {
    email: "queue-scope@e2e.test",
    name: "Queue Scope",
    categories: [
        { name: "Movies", entries: ["Arrival"] },
        { name: "Books", entries: [] }
    ],
    queueSettings: { enabled: true, delayDays: 0 },
    queuedEntries: [
        { categoryName: "Movies", name: "Memento" },
        { categoryName: "Books", name: "Hyperion" }
    ]
};

/** Opens the account menu's Settings flyout (queue toggles + delay days). */
async function openQueueSettings(page: Page) {
    const queueToggle = page.getByRole("menuitemcheckbox", { name: "Queue entries" });
    if (await queueToggle.isVisible().catch(() => false)) {
        return;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const accountMenu = await openAccountMenu(page);
        const settingsItem = accountMenu.getByRole("menuitem", { name: "Settings", exact: true });
        await expect(settingsItem).toBeVisible();
        await settingsItem.hover();
        if (await queueToggle.waitFor({ state: "visible", timeout: 1_000 }).then(() => true).catch(() => false)) {
            return;
        }
        await settingsItem.click();
        if (await queueToggle.waitFor({ state: "visible", timeout: 1_000 }).then(() => true).catch(() => false)) {
            return;
        }
    }

    await expect(queueToggle).toBeVisible();
}

/** Closes the account menu by clicking outside of it. */
async function closeAccountMenu(page: Page) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitemcheckbox", { name: "Queue entries" })).toBeHidden();
}

/**
 * Queue settings save quietly in the background: the checkbox flips
 * optimistically, but the dashboard only honors the new settings after the
 * save + refresh round-trip. Entries added before that round-trip lands are
 * routed by the OLD settings, and Playwright is fast enough to win that race
 * (~10ms window). Wrap each settings change so the test waits it out.
 */
async function withSettingsSaved(page: Page, change: () => Promise<void>) {
    const saved = serverFnResponse(page, "updateQueueSettings");
    const refreshed = serverFnResponse(page, "loadDashboard");
    await change();
    await saved;
    await refreshed;
}

/**
 * A queued entry renders its name twice (poster placeholder + row body);
 * target the first so exact-text lookups stay unambiguous. Right-clicks
 * bubble to the row's context-menu handler either way.
 */
function queueItem(page: Page, name: string) {
    return page.getByText(name, { exact: true }).first();
}

async function clickUndoToast(page: Page, message: string) {
    await page
        .getByRole("listitem")
        .filter({ hasText: message })
        .getByRole("button", { name: "Undo" })
        .click();
}

async function downloadExport(page: Page) {
    const downloadPromise = page.waitForEvent("download");
    const accountMenu = await openAccountMenu(page);
    await accountMenu.getByRole("menuitem", { name: "Export xlsx" }).click();
    const download = await downloadPromise;
    const filePath = await download.path();
    if (!filePath) {
        throw new Error("Export download did not provide a local file path");
    }
    return filePath;
}

async function openImportToast(page: Page) {
    if (await page.getByText("Import Spreadsheet").isVisible().catch(() => false)) {
        return;
    }

    const accountMenu = await openAccountMenu(page);
    await accountMenu.getByRole("menuitem", { name: "Import xlsx" }).click();
    await expect(page.getByText("Import Spreadsheet")).toBeVisible();
}

test.describe("Queue", () => {
    test("new accounts default to a ready zero-day queue and settings apply before refresh", async ({
        page
    }) => {
        await gotoApp(page, "/signin");
        await page.getByRole("link", { name: "Create an account" }).click();
        await page.getByLabel("Name").fill("Default Queue");
        await page.getByLabel("Email").fill("queue-default@e2e.test");
        await page.getByRole("textbox", { name: /^Password/ }).fill(TEST_PASSWORD);
        await page.getByRole("button", { name: "Create account" }).click();
        await expect(page.getByText("Create Your First Category")).toBeVisible({ timeout: 15_000 });

        await openQueueSettings(page);
        await expect(page.getByRole("menuitemcheckbox", { name: "Queue entries" })).toHaveAttribute("aria-checked", "true");
        await expect(page.getByRole("menuitemcheckbox", { name: "Randomize ready queue" })).toHaveAttribute("aria-checked", "false");
        await expect(page.getByLabel("Delay days")).toHaveValue("0");

        await withSettingsSaved(page, () => page.getByRole("menuitemcheckbox", { name: "Randomize ready queue" }).click());
        await closeAccountMenu(page);

        await page.getByPlaceholder("New category").fill("Books");
        await page.getByPlaceholder("New category").press("Enter");
        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();

        await page.getByPlaceholder("New entry").fill("Dune");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(/Queued Dune for ranking on/)).toBeVisible();
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
        await expect(page.getByText("1 ready")).toBeVisible();
        await page.getByRole("button", { name: "Close", exact: true }).click();

        await queueItem(page, "Dune").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rank Now" }).click();
        await expect(page.getByText("#1 Dune")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("Queue Empty")).toBeVisible();

        await openQueueSettings(page);
        await page.getByRole("menuitemcheckbox", { name: "Queue entries" }).click();
        await closeAccountMenu(page);

        await page.getByPlaceholder("New entry").fill("Hyperion");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });
    });

    test("full queue lifecycle: enable, delay, rename, rank now, undo delete, rank queue, disable", async ({
        page,
        context
    }) => {
        test.setTimeout(120_000);
        await seedUsers([QUINN]);
        await signInViaApi(context, QUINN.email);
        await gotoApp(page);
        await expect(page.getByText("#1 Arrival")).toBeVisible();
        await expect(page.getByText("Queue Empty")).toBeVisible();

        // --- Enable the queue with the default delay (3 days). ---
        await openQueueSettings(page);
        await withSettingsSaved(page, () => page.getByRole("menuitemcheckbox", { name: "Queue entries" }).click());
        await closeAccountMenu(page);

        // --- New entries now land in the queue, not ready yet. ---
        await page.getByPlaceholder("New entry").fill("Solaris");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(/Queued Solaris for ranking on/)).toBeVisible();
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
        await expect(page.getByText("0 ready")).toBeVisible();
        await expect(page.getByRole("button", { name: "Rank Queue" })).toBeDisabled();

        // --- Queue state survives a reload (server-side persistence). ---
        await gotoApp(page);
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
        await expect(queueItem(page, "Solaris")).toBeVisible();

        // --- Rename the queued entry from its context menu. ---
        await queueItem(page, "Solaris").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByLabel("Rename Solaris").fill("Stalker");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(queueItem(page, "Stalker")).toBeVisible();
        await expect(queueItem(page, "Solaris")).toBeHidden();

        // --- "Rank Now" overrides the delay and starts a binary session. ---
        await queueItem(page, "Stalker").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rank Now" }).click();
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Stalker");

        await expect(page.getByText("#1 Stalker")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#2 Arrival")).toBeVisible();
        await expect(page.getByText("#3 Dune")).toBeVisible();
        await expect(page.getByText("0 queued")).toBeVisible();

        // --- With a zero-day delay, queued entries are ready immediately. ---
        await openQueueSettings(page);
        await withSettingsSaved(page, () => page.getByLabel("Delay days").fill("0"));
        await closeAccountMenu(page);

        await page.getByPlaceholder("New entry").fill("Memento");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText("1 queued")).toBeVisible();

        await page.getByPlaceholder("New entry").fill("Klute");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText("2 queued", { exact: true })).toBeVisible();
        await expect(page.getByText("2 ready")).toBeVisible();
        await expect(page.getByRole("button", { name: "Rank Queue" })).toBeEnabled();

        // --- Removing a queued entry is reversible via the undo toast. ---
        await queueItem(page, "Klute").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Remove" }).click();
        await expect(page.getByText("Removed Klute from the queue.")).toBeVisible();
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();

        await clickUndoToast(page, "Removed Klute from the queue.");
        await expect(page.getByText("Restored Klute to the queue.")).toBeVisible();
        await expect(page.getByText("2 queued")).toBeVisible();

        // --- "Rank Queue" chains ranking sessions for every ready entry. ---
        await page.getByRole("button", { name: "Rank Queue" }).click();
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Memento");
        // The second session starts automatically once the first finishes.
        await winMatchups(page, "Klute");

        await expect(page.getByText("No ready queued entries remain.")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#1 Klute")).toBeVisible();
        await expect(page.getByText("#2 Memento")).toBeVisible();
        await expect(page.getByText("#3 Stalker")).toBeVisible();
        await expect(page.getByText("#4 Arrival")).toBeVisible();
        await expect(page.getByText("#5 Dune")).toBeVisible();
        await expect(page.getByText("Queue Empty")).toBeVisible();

        // --- Disabling the queue routes new entries straight to ranking. ---
        await openQueueSettings(page);
        await withSettingsSaved(page, () => page.getByRole("menuitemcheckbox", { name: "Queue entries" }).click());
        await closeAccountMenu(page);

        await page.getByPlaceholder("New entry").fill("Tron");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("Queue Empty")).toBeVisible();
        await winMatchups(page, "Tron");
        await expect(page.getByText("#1 Tron")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#6 Dune")).toBeVisible();
    });

    test("queue search filters rows and category filter scopes rank queue", async ({ page, context }) => {
        await seedUsers([QUEUE_SCOPE_USER]);
        await signInViaApi(context, QUEUE_SCOPE_USER.email);
        await gotoApp(page);
        await expect(page.getByText("2 queued", { exact: true })).toBeVisible();
        await expect(page.getByText("2 ready")).toBeVisible();

        await page.getByPlaceholder("Search queue").fill("meme");
        await expect(queueItem(page, "Memento")).toBeVisible();
        await expect(queueItem(page, "Hyperion")).toBeHidden();
        await page.getByPlaceholder("Search queue").clear();

        await page.getByLabel("Queue category filter").click();
        await page.getByRole("option", { name: "Books" }).click();
        await expect(queueItem(page, "Hyperion")).toBeVisible();
        await expect(queueItem(page, "Memento")).toBeHidden();
        await expect(page.getByRole("button", { name: "Rank Books" })).toBeEnabled();

        await page.getByRole("button", { name: "Rank Books" }).click();
        await expect(page.getByText("No ready queued entries remain in that category.")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
        await expect(page.getByText("#1 Hyperion")).toBeVisible();
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
    });

    test("queue ranking can skip the current queued entry for the current run", async ({
        context,
        page
    }) => {
        await seedUsers([{
            email: "queue-skip@e2e.test",
            name: "Queue Skip",
            queueSettings: {
                enabled: true,
                delayDays: 0,
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }],
            queuedEntries: [
                { categoryName: "Movies", name: "Memento", availableAt: 1, createdAt: 1 },
                { categoryName: "Movies", name: "Klute", availableAt: 2, createdAt: 2 }
            ]
        }]);
        await signInViaApi(context, "queue-skip@e2e.test");
        await gotoApp(page);

        await page.getByRole("button", { name: "Rank Queue" }).click();
        await expect(page.getByRole("button", { name: "Memento" })).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Skip Queued Rank" }).click();
        await expect(page.getByRole("button", { name: "Klute" })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("button", { name: "Memento" })).toBeHidden();

        await winMatchups(page, "Klute");
        await expect(page.getByText("No unskipped ready queued entries remain.")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("1 queued")).toBeVisible();
        await expect(queueItem(page, "Memento")).toBeVisible();
        await expect(page.getByText("#1 Klute")).toBeVisible();
    });

    test("queue selection mode batch removes and restores queued entries", async ({
        context,
        page
    }) => {
        await seedUsers([{
            email: "queue-batch@e2e.test",
            name: "Queue Batch",
            queueSettings: {
                enabled: true,
                delayDays: 0,
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }],
            queuedEntries: [
                { categoryName: "Movies", name: "Memento", availableAt: 1, createdAt: 1 },
                { categoryName: "Movies", name: "Klute", availableAt: 2, createdAt: 2 },
                { categoryName: "Movies", name: "Solaris", availableAt: 3, createdAt: 3 },
                { categoryName: "Movies", name: "Stalker", availableAt: 4, createdAt: 4 }
            ]
        }]);
        await signInViaApi(context, "queue-batch@e2e.test");
        await gotoApp(page);
        await expect(page.getByText("4 queued", { exact: true })).toBeVisible();

        await page.getByRole("button", { name: "Select", exact: true }).click();
        await expect(page.getByText("0 selected")).toBeVisible();
        await page.getByRole("checkbox", { name: "Select queued Memento" }).click();
        await page.getByRole("checkbox", { name: "Select queued Solaris" }).click({ modifiers: ["Shift"] });
        await expect(page.getByText("3 selected")).toBeVisible();
        await page.getByRole("checkbox", { name: "Select queued Klute" }).click({ modifiers: ["Meta"] });
        await expect(page.getByText("2 selected")).toBeVisible();
        await page.getByRole("checkbox", { name: "Select queued Stalker" }).click();
        await expect(page.getByText("3 selected")).toBeVisible();
        await page.getByRole("checkbox", { name: "Select queued Stalker" }).click();
        await expect(page.getByText("2 selected")).toBeVisible();

        await page.getByRole("button", { name: "Remove selected" }).click();
        await expect(page.getByText("Removed 2 queued entries.")).toBeVisible();
        await expect(page.getByText("2 queued", { exact: true })).toBeVisible();
        await expect(queueItem(page, "Memento")).toBeHidden();
        await expect(queueItem(page, "Solaris")).toBeHidden();
        await expect(queueItem(page, "Klute")).toBeVisible();
        await expect(queueItem(page, "Stalker")).toBeVisible();

        await clickUndoToast(page, "Removed 2 queued entries.");
        await expect(page.getByText("Restored 2 queued entries.")).toBeVisible();
        await expect(page.getByText("4 queued", { exact: true })).toBeVisible();
        await expect(queueItem(page, "Memento")).toBeVisible();
        await expect(queueItem(page, "Solaris")).toBeVisible();
    });

    test("active add ranking actions can queue new adds or remove queued adds", async ({
        context,
        page
    }) => {
        await seedUsers([{
            email: "cancel-options@e2e.test",
            name: "Cancel Options",
            queueSettings: {
                enabled: false,
                delayDays: 0,
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }],
            queuedEntries: [
                { categoryName: "Movies", name: "Solaris", availableAt: 1, createdAt: 1 }
            ]
        }]);
        await signInViaApi(context, "cancel-options@e2e.test");
        await gotoApp(page);

        await page.getByPlaceholder("New entry").fill("Zeta");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("New Entry")).toBeVisible();
        await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();

        await page.getByPlaceholder("New entry").fill("Blade Runner");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(/Queued Blade Runner for ranking on/)).toBeVisible();
        await expect(page.getByText("2 queued", { exact: true })).toBeVisible();
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible();

        await queueItem(page, "Blade Runner").click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Rank Now" })).toBeDisabled();
        await expect(page.getByRole("menuitem", { name: "Remove" })).toBeEnabled();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Select", exact: true }).click();
        await page.getByRole("checkbox", { name: "Select queued Blade Runner" }).click();
        await expect(page.getByText("1 selected")).toBeVisible();
        await page.getByRole("button", { name: "Remove selected" }).click();
        await expect(page.getByText("Removed 1 queued entry.")).toBeVisible();
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible();

        await page.getByRole("button", { name: "Ranking actions" }).click();
        await page.getByRole("menuitem", { name: "Cancel Add and Add to Queue" }).click();
        await expect(page.getByText("Cancelled adding Zeta and moved it to the queue.")).toBeVisible();
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeHidden();
        await expect(page.getByText("2 queued", { exact: true })).toBeVisible();
        await expect(queueItem(page, "Zeta")).toBeVisible();
        await expect(queueItem(page, "Blade Runner")).toBeHidden();

        await queueItem(page, "Solaris").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rank Now" }).click();
        await expect(page.getByRole("button", { name: "Solaris" })).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Ranking actions" }).click();
        await page.getByRole("menuitem", { name: "Cancel Add and Delete from Queue" }).click();
        await expect(page.getByText("Cancelled ranking Solaris and removed it from the queue.")).toBeVisible();
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
        await expect(queueItem(page, "Zeta")).toBeVisible();
        await expect(queueItem(page, "Solaris")).toBeHidden();
    });

    test("spreadsheet export and import preserves queued entries and skips duplicates", async ({
        context,
        page
    }) => {
        await seedUsers([{
            email: "sheet-export@e2e.test",
            name: "Sheet Export",
            categories: [{ name: "Books" }],
            queuedEntries: [{ categoryName: "Books", name: "Dune", availableAt: 0, createdAt: 0 }]
        }]);
        await signInViaApi(context, "sheet-export@e2e.test");
        await gotoApp(page);
        await expect(page.getByText("1 queued")).toBeVisible();
        const workbookPath = await downloadExport(page);

        await context.clearCookies();
        await seedUsers([{ email: "sheet-import@e2e.test", name: "Sheet Import" }]);
        await signInViaApi(context, "sheet-import@e2e.test");
        await gotoApp(page);
        await expect(page.getByText("Create Your First Category")).toBeVisible({ timeout: 15_000 });

        await openImportToast(page);
        await page.locator('input[name="workbook"]').setInputFiles(workbookPath);
        await page.getByRole("button", { name: "Import", exact: true }).click();
        await expect(page.getByText(/Imported 1 queued/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
        await expect(queueItem(page, "Dune")).toBeVisible();

        await openImportToast(page);
        await page.locator('input[name="workbook"]').setInputFiles(workbookPath);
        await page.getByRole("button", { name: "Import", exact: true }).click();
        await expect(page.getByText(/No new entries imported\. Skipped 1 queued/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
    });

    test("new entry category selector routes queued entries to the selected category", async ({
        context,
        page
    }) => {
        await seedUsers([{
            email: "queue-selector@e2e.test",
            name: "Queue Selector",
            queueSettings: { enabled: true, delayDays: 0 },
            categories: [
                { name: "Movies", entries: ["Arrival"] },
                { name: "Books" }
            ]
        }]);
        await signInViaApi(context, "queue-selector@e2e.test");
        await gotoApp(page);
        await expect(page.getByRole("heading", { name: "Movies" })).toBeVisible();

        await page.getByPlaceholder("New entry").fill("Dune");
        await page.getByRole("combobox", { name: "Category" }).click();
        await page.getByRole("option", { name: "Books" }).click();
        await page.getByPlaceholder("New entry").press("Enter");

        await expect(page.getByText(/Queued Dune for ranking on/)).toBeVisible();
        await expect(page.getByText("Books · Ready")).toBeVisible();
        await expect(page.getByText("1 queued", { exact: true })).toBeVisible();
    });
});
