import type { Page } from "@playwright/test";
import { test, expect } from "./base";
import { ACTIVE_RANKING_LABEL, gotoApp, openDesktopNewEntry, openNewCategoryDialog, openQueueWorkspace, queueCount, seedUsers, serverFnResponse, signInViaApi, TEST_PASSWORD, winMatchups } from "./helpers";

const QUINN = {
    email: "quinn@e2e.test",
    name: "Quinn",
    queueSettings: { enabled: false },
    categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }]
};

const QUEUE_SCOPE_USER = {
    email: "queue-scope@e2e.test",
    name: "Queue Scope",
    categories: [
        { name: "Movies", entries: ["Arrival"] },
        { name: "Books", entries: [] }
    ],
    queueSettings: { enabled: true },
    queuedEntries: [
        { categoryName: "Movies", name: "Memento" },
        { categoryName: "Books", name: "Hyperion" }
    ]
};

/** Opens the dedicated Queue section in Settings. */
async function openQueueSettings(page: Page) {
    const queueToggle = page.getByLabel("Enable the queue");
    if (await queueToggle.isVisible().catch(() => false)) {
        return;
    }

    await gotoApp(page, "/profile");
    await page.getByRole("button", { name: "Queue", exact: true }).click();
    await expect(queueToggle).toBeVisible();
}

/** Returns to the dashboard after a settings change. */
async function closeAccountMenu(page: Page) {
    await gotoApp(page);
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
    await change();
    await saved;
}

/**
 * A queued entry renders its name twice (poster placeholder + row body);
 * target the first so exact-text lookups stay unambiguous. Right-clicks
 * bubble to the row's context-menu handler either way.
 */
function queueItem(page: Page, name: string) {
    return page.getByText(name, { exact: true }).first();
}

function matchChoice(page: Page, name: string) {
    return page.getByRole("button", { name: new RegExp(`^${name}\\b`) });
}

function todayDateInputValue() {
    const today = new Date();
    return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())).toISOString().slice(0, 10);
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
    await page.getByRole("button", { name: "Import & export", exact: true }).click();
    await page.getByRole("button", { name: "Export xlsx", exact: true }).click();
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

    await page.getByRole("button", { name: "Import & export", exact: true }).click();
    await page.getByRole("button", { name: "Import xlsx", exact: true }).click();
    await expect(page.getByText("Import Spreadsheet")).toBeVisible();
}

test.describe("Queue", () => {
    test("new accounts default to queue-on and settings apply before refresh @smoke", async ({
        page
    }) => {
        await gotoApp(page, "/signin");
        await page.getByRole("link", { name: "Create an account" }).click();
        await page.getByLabel("Name").fill("Default Queue");
        await page.getByLabel("Email").fill("queue-default@e2e.test");
        await page.getByRole("textbox", { name: /^Password/ }).fill(TEST_PASSWORD);
        await page.getByRole("textbox", { name: "Confirm password" }).fill(TEST_PASSWORD);
        await page.getByRole("button", { name: "Create account" }).click();
        await expect(page.getByRole("heading", { name: "Example Ranking" })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#1 Example Item A")).toBeVisible();

        await openQueueSettings(page);
        await expect(page.getByLabel("Enable the queue")).toBeChecked();
        await expect(page.getByLabel("Randomize queue runs")).not.toBeChecked();

        await withSettingsSaved(page, () => page.getByLabel("Randomize queue runs").click());
        await closeAccountMenu(page);

        const categoryDialog = await openNewCategoryDialog(page);
        await categoryDialog.getByPlaceholder("New category").fill("Books");
        await categoryDialog.getByPlaceholder("New category").press("Enter");
        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();

        const newEntry = await openDesktopNewEntry(page);
        await newEntry.fill("Dune");
        await newEntry.press("Enter");
        await expect(page.getByText("Queued Dune for ranking.")).toBeVisible();
        await page.getByRole("button", { name: "Close", exact: true }).first().click();
        await page.getByRole("button", { name: /^Queue/ }).click();
        await expect(queueCount(page, 1)).toBeVisible();

        await queueItem(page, "Dune").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rank Now" }).click();
        await expect(page.getByText("Queue Empty")).toBeVisible();
        await page.getByRole("button", { name: "My rankings", exact: true }).click();
        await expect(page.getByText("#1 Dune")).toBeVisible({ timeout: 15_000 });

        await openQueueSettings(page);
        await page.getByLabel("Enable the queue").click();
        await closeAccountMenu(page);

        const directEntry = await openDesktopNewEntry(page);
        await directEntry.fill("Hyperion");
        await directEntry.press("Enter");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
    });

    test("dashboard loads entries when switching categories", async ({ page, context }) => {
        await seedUsers([{
            email: "dashboard-category-load@e2e.test",
            name: "Dashboard Category Load",
            categories: [
                { name: "Movies", entries: ["Arrival"] },
                { name: "Books", entries: ["Hyperion"] }
            ]
        }]);
        await signInViaApi(context, "dashboard-category-load@e2e.test");
        await gotoApp(page);

        await expect(page.getByText("Arrival", { exact: true }).first()).toBeVisible();
        await page.getByRole("button", { name: /^Books · 1/ }).click();
        await expect(page.getByText("Hyperion", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("Arrival", { exact: true }).first()).toBeHidden();

        await page.getByRole("button", { name: /^Movies · 1/ }).click();
        await expect(page.getByText("Arrival", { exact: true }).first()).toBeVisible();
    });

    test("full queue lifecycle: enable, rename, rank now, undo delete, rank queue, disable", async ({
        page,
        context
    }) => {
        test.setTimeout(120_000);
        await seedUsers([QUINN]);
        await signInViaApi(context, QUINN.email);
        await gotoApp(page);
        await expect(page.getByText("#1 Arrival")).toBeVisible();
        await openQueueWorkspace(page);
        await expect(page.getByText("Queue Empty")).toBeVisible();
        await page.getByRole("button", { name: "My rankings", exact: true }).click();

        // --- Enable the queue. ---
        await openQueueSettings(page);
        await withSettingsSaved(page, () => page.getByLabel("Enable the queue").click());
        await closeAccountMenu(page);

        // --- New entries now land in the queue. ---
        const solarisEntry = await openDesktopNewEntry(page);
        await solarisEntry.fill("Solaris");
        await solarisEntry.press("Enter");
        await expect(page.getByText("Queued Solaris for ranking.")).toBeVisible();
        await openQueueWorkspace(page);
        await expect(queueCount(page, 1)).toBeVisible();
        await expect(page.getByRole("button", { name: "Rank Queue" })).toBeEnabled();

        // --- Queue state survives a reload (server-side persistence). ---
        await gotoApp(page);
        await openQueueWorkspace(page);
        await expect(queueCount(page, 1)).toBeVisible();
        await expect(queueItem(page, "Solaris")).toBeVisible();

        // --- Rename the queued entry from its context menu. ---
        await queueItem(page, "Solaris").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByLabel("Rename Solaris").fill("Stalker");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(queueItem(page, "Stalker")).toBeVisible();
        await expect(queueItem(page, "Solaris")).toBeHidden();

        // --- "Rank Now" starts a binary session. ---
        await queueItem(page, "Stalker").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rank Now" }).click();
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Stalker");

        await page.getByRole("button", { name: "My rankings", exact: true }).click();

        await expect(page.getByText("#1 Stalker")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#2 Arrival")).toBeVisible();
        await expect(page.getByText("#3 Dune")).toBeVisible();
        await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();

        const mementoEntry = await openDesktopNewEntry(page);
        await mementoEntry.fill("Memento");
        await mementoEntry.press("Enter");
        await openQueueWorkspace(page);
        await expect(queueCount(page, 1)).toBeVisible();

        const kluteEntry = await openDesktopNewEntry(page);
        await kluteEntry.fill("Klute");
        await kluteEntry.press("Enter");
        await expect(queueCount(page, 2)).toBeVisible();
        await openQueueWorkspace(page);
        await expect(page.getByRole("button", { name: "Rank Queue" })).toBeEnabled();

        // --- Removing a queued entry is reversible via the undo toast. ---
        await queueItem(page, "Klute").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Remove" }).click();
        await expect(page.getByText("Removed Klute from the queue.")).toBeVisible();
        await expect(queueCount(page, 1)).toBeVisible();

        await clickUndoToast(page, "Removed Klute from the queue.");
        await expect(page.getByText("Restored Klute to the queue.")).toBeVisible();
        await expect(queueCount(page, 2)).toBeVisible();

        // --- "Rank Queue" chains ranking sessions for every queued entry. ---
        await page.getByRole("button", { name: "Rank Queue" }).click();
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Memento");
        // The second session starts automatically once the first finishes.
        await winMatchups(page, "Klute");
        // Undo/restore can alter the transient queue order, so finish Memento if it was second.
        await winMatchups(page, "Memento");

        await expect(page.getByText("Queue Empty")).toBeVisible();

        await page.getByRole("button", { name: "My rankings", exact: true }).click();
        await expect(page.getByText(/^#1 (Klute|Memento)$/)).toBeVisible();
        await expect(page.getByText(/^#2 (Klute|Memento)$/)).toBeVisible();
        await expect(page.getByText("#3 Stalker")).toBeVisible();
        await expect(page.getByText("#4 Arrival")).toBeVisible();
        await expect(page.getByText("#5 Dune")).toBeVisible();

        // --- Disabling the queue routes new entries straight to ranking. ---
        await openQueueSettings(page);
        await withSettingsSaved(page, () => page.getByLabel("Enable the queue").click());
        await closeAccountMenu(page);

        const tronEntry = await openDesktopNewEntry(page);
        await tronEntry.fill("Tron");
        await tronEntry.press("Enter");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Tron");
        await expect(page.getByText("#1 Tron")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#6 Dune")).toBeVisible();
    });

    test("queue search filters rows and category filter scopes rank queue", async ({ page, context }) => {
        await seedUsers([QUEUE_SCOPE_USER]);
        await signInViaApi(context, QUEUE_SCOPE_USER.email);
        await gotoApp(page);
        await openQueueWorkspace(page);
        await expect(queueCount(page, 2)).toBeVisible();

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
        await expect(page.getByText("No queued entries remain in that category.")).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "My rankings", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
        await expect(page.getByText("#1 Hyperion")).toBeVisible();
        await expect(page.getByRole("button", { name: "Queue 1", exact: true })).toBeVisible();
    });

    test("queue ranking preserves same-day insertion order after reload", async ({
        context,
        page
    }) => {
        await seedUsers([{
            email: "queue-insertion-order@e2e.test",
            name: "Queue Insertion Order",
            queueSettings: {
                enabled: true,
                promptForMissingImages: false,
                randomizeReadyEntries: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }]
        }]);
        await signInViaApi(context, "queue-insertion-order@e2e.test");
        await gotoApp(page);

        const mementoEntry = await openDesktopNewEntry(page);
        await mementoEntry.fill("Memento");
        await mementoEntry.press("Enter");
        await openQueueWorkspace(page);
        await expect(queueCount(page, 1)).toBeVisible();

        const kluteEntry = await openDesktopNewEntry(page);
        await kluteEntry.fill("Klute");
        await kluteEntry.press("Enter");
        await expect(queueCount(page, 2)).toBeVisible();

        await gotoApp(page);
        await openQueueWorkspace(page);
        await expect(queueItem(page, "Memento")).toBeVisible();
        await expect(queueItem(page, "Klute")).toBeVisible();

        await page.getByRole("button", { name: "Rank Queue" }).click();
        await expect(matchChoice(page, "Memento")).toBeVisible({ timeout: 15_000 });
        await expect(matchChoice(page, "Klute")).toBeHidden();
    });

    test("queue ranking preserves visible order when randomize is off", async ({
        context,
        page
    }) => {
        await page.addInitScript(() => {
            Math.random = () => 0.99;
        });
        await seedUsers([{
            email: "queue-randomize-off@e2e.test",
            name: "Queue Randomize Off",
            queueSettings: {
                enabled: true,
                promptForMissingImages: false,
                randomizeReadyEntries: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }],
            queuedEntries: [
                { categoryName: "Movies", name: "Memento", createdAt: 1 },
                { categoryName: "Movies", name: "Klute", createdAt: 2 }
            ]
        }]);
        await signInViaApi(context, "queue-randomize-off@e2e.test");
        await gotoApp(page);
        await openQueueWorkspace(page);

        await expect(queueItem(page, "Memento")).toBeVisible();
        await expect(queueItem(page, "Klute")).toBeVisible();

        await page.getByRole("button", { name: "Rank Queue" }).click();
        await expect(matchChoice(page, "Memento")).toBeVisible({ timeout: 15_000 });
        await expect(matchChoice(page, "Klute")).toBeHidden();
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
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }],
            queuedEntries: [
                { categoryName: "Movies", name: "Memento", createdAt: 1 },
                { categoryName: "Movies", name: "Klute", createdAt: 2 }
            ]
        }]);
        await signInViaApi(context, "queue-skip@e2e.test");
        await gotoApp(page);
        await openQueueWorkspace(page);

        await page.getByRole("button", { name: "Rank Queue" }).click();
        await expect(matchChoice(page, "Memento")).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Skip Memento" }).click();
        await expect(matchChoice(page, "Klute")).toBeVisible({ timeout: 15_000 });
        await expect(matchChoice(page, "Memento")).toBeHidden();

        await winMatchups(page, "Klute");
        await expect(page.getByText("No unskipped queued entries remain.")).toBeVisible({ timeout: 15_000 });
        await expect(queueCount(page, 1)).toBeVisible();
        await expect(queueItem(page, "Memento")).toBeVisible();
        await page.getByRole("button", { name: "My rankings", exact: true }).click();
        await expect(page.getByText("#1 Klute")).toBeVisible();
    });

    test("queue ranking can delete the current queued entry and continue", async ({ context, page }) => {
        await seedUsers([{
            email: "queue-delete-current@e2e.test",
            name: "Queue Delete Current",
            queueSettings: {
                enabled: true,
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }],
            queuedEntries: [
                { categoryName: "Movies", name: "Memento", createdAt: 1 },
                { categoryName: "Movies", name: "Klute", createdAt: 2 }
            ]
        }]);
        await signInViaApi(context, "queue-delete-current@e2e.test");
        await gotoApp(page);
        await openQueueWorkspace(page);

        await page.getByRole("button", { name: "Rank Queue" }).click();
        await expect(matchChoice(page, "Memento")).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Ranking actions" }).click();
        await page.getByRole("menuitem", { name: "Delete Memento from Queue" }).click();

        await expect(matchChoice(page, "Klute")).toBeVisible({ timeout: 15_000 });
        await expect(matchChoice(page, "Memento")).toBeHidden();
        await expect(queueItem(page, "Memento")).toBeHidden();

        await winMatchups(page, "Klute");
        await expect(page.getByText("No queued entries remain.")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("Queue Empty")).toBeVisible();
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
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }],
            queuedEntries: [
                { categoryName: "Movies", name: "Memento", createdAt: 1 },
                { categoryName: "Movies", name: "Klute", createdAt: 2 },
                { categoryName: "Movies", name: "Solaris", createdAt: 3 },
                { categoryName: "Movies", name: "Stalker", createdAt: 4 }
            ]
        }]);
        await signInViaApi(context, "queue-batch@e2e.test");
        await gotoApp(page);
        const queuePanel = await openQueueWorkspace(page);
        await expect(queuePanel.getByText("4 queued", { exact: true })).toBeVisible();

        await queuePanel.getByRole("button", { name: "Select", exact: true }).click();
        await expect(queuePanel.getByText("0 selected")).toBeVisible();
        await queuePanel.getByRole("checkbox", { name: "Select queued Memento" }).click();
        await queuePanel.getByRole("checkbox", { name: "Select queued Solaris" }).click({ modifiers: ["Shift"] });
        await expect(queuePanel.getByText("3 selected")).toBeVisible();
        await queuePanel.getByRole("checkbox", { name: "Select queued Klute" }).click({ modifiers: ["Meta"] });
        await expect(queuePanel.getByText("2 selected")).toBeVisible();
        await queuePanel.getByRole("checkbox", { name: "Select queued Stalker" }).click();
        await expect(queuePanel.getByText("3 selected")).toBeVisible();
        await queuePanel.getByRole("checkbox", { name: "Select queued Stalker" }).click();
        await expect(queuePanel.getByText("2 selected")).toBeVisible();

        await queuePanel.getByRole("button", { name: "Remove selected" }).click();
        await expect(page.getByText("Removed 2 queued entries.")).toBeVisible();
        await expect(queueCount(page, 2)).toBeVisible();
        await expect(queueItem(page, "Memento")).toBeHidden();
        await expect(queueItem(page, "Solaris")).toBeHidden();
        await expect(queueItem(page, "Klute")).toBeVisible();
        await expect(queueItem(page, "Stalker")).toBeVisible();

        await clickUndoToast(page, "Removed 2 queued entries.");
        await expect(page.getByText("Restored 2 queued entries.")).toBeVisible();
        await expect(queueCount(page, 4)).toBeVisible();
        await expect(queueItem(page, "Memento")).toBeVisible();
        await expect(queueItem(page, "Solaris")).toBeVisible();
    });

    test("queue selection silently chunks more than 200 removals", async ({ context, page }) => {
        const queuedEntries = Array.from({ length: 201 }, (_, index) => ({
            categoryName: "Movies",
            name: `Queue ${String(index).padStart(3, "0")}`,
            createdAt: index + 1
        }));
        await seedUsers([{
            email: "queue-large-batch@e2e.test",
            name: "Queue Large Batch",
            queueSettings: { enabled: true, promptForMissingImages: false },
            categories: [{ name: "Movies", entries: [] }],
            queuedEntries
        }]);
        await signInViaApi(context, "queue-large-batch@e2e.test");
        await gotoApp(page);

        const queuePanel = await openQueueWorkspace(page);
        await expect(queuePanel.getByText("201 queued", { exact: true })).toBeVisible();
        await queuePanel.getByRole("button", { name: "Select", exact: true }).click();
        await queuePanel.getByRole("checkbox", { name: "Select queued Queue 000" }).click();
        await queuePanel.getByRole("checkbox", { name: "Select queued Queue 200" }).click({ modifiers: ["Shift"] });
        await expect(queuePanel.getByText("201 selected", { exact: true })).toBeVisible();

        await queuePanel.getByRole("button", { name: "Remove selected" }).click();
        await expect(page.getByText("Removed 201 queued entries.")).toBeVisible({ timeout: 20_000 });
        await expect(queuePanel.getByText("0 queued", { exact: true })).toBeVisible();
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
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }],
            queuedEntries: [
                { categoryName: "Movies", name: "Solaris", createdAt: 1 }
            ]
        }]);
        await signInViaApi(context, "cancel-options@e2e.test");
        await gotoApp(page);

        const zetaEntry = await openDesktopNewEntry(page);
        await zetaEntry.fill("Zeta");
        await zetaEntry.press("Enter");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("button", { name: "Add entry", exact: true })).toBeVisible();

        const bladeRunnerEntry = await openDesktopNewEntry(page);
        await bladeRunnerEntry.fill("Blade Runner");
        await bladeRunnerEntry.press("Enter");
        await expect(page.getByText("Queued Blade Runner for ranking.")).toBeVisible();
        const queuePanel = await openQueueWorkspace(page);
        await expect(queuePanel.getByText("2 queued", { exact: true })).toBeVisible();
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible();

        await queueItem(page, "Blade Runner").click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Rank Now" })).toBeDisabled();
        await expect(page.getByRole("menuitem", { name: "Remove" })).toBeEnabled();
        await page.keyboard.press("Escape");
        await queuePanel.getByRole("button", { name: "Select", exact: true }).click();
        await queuePanel.getByRole("checkbox", { name: "Select queued Blade Runner" }).click();
        await expect(queuePanel.getByText("1 selected")).toBeVisible();
        await queuePanel.getByRole("button", { name: "Remove selected" }).click();
        await expect(page.getByText("Removed 1 queued entry.")).toBeVisible();
        await expect(queueCount(page, 1)).toBeVisible();
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible();

        await page.getByRole("button", { name: "Ranking actions" }).click();
        await page.getByRole("menuitem", { name: "Cancel and Queue Zeta" }).click();
        await expect(page.getByText("Cancelled adding Zeta and moved it to the queue.")).toBeVisible();
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeHidden();
        await expect(queueCount(page, 2)).toBeVisible();
        await expect(queueItem(page, "Zeta")).toBeVisible();
        await expect(queueItem(page, "Blade Runner")).toBeHidden();

        await queueItem(page, "Solaris").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rank Now" }).click();
        await expect(matchChoice(page, "Solaris")).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Ranking actions" }).click();
        await page.getByRole("menuitem", { name: "Delete Solaris from Queue" }).click();
        await expect(page.getByText("Cancelled ranking Solaris and removed it from the queue.")).toBeVisible();
        await expect(queueCount(page, 1)).toBeVisible();
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
            queuedEntries: [{ categoryName: "Books", name: "Dune", createdAt: 0 }]
        }]);
        await signInViaApi(context, "sheet-export@e2e.test");
        await gotoApp(page);
        await openQueueWorkspace(page);
        await expect(queueCount(page, 1)).toBeVisible();
        const workbookPath = await downloadExport(page);

        await context.clearCookies();
        await seedUsers([{ email: "sheet-import@e2e.test", name: "Sheet Import" }]);
        await signInViaApi(context, "sheet-import@e2e.test");
        await gotoApp(page);
        await expect(page.getByText("Create Your First Category")).toBeVisible({ timeout: 15_000 });

        await openImportToast(page);
        await expect(page.locator('input[name="addedAt"]')).toHaveValue(todayDateInputValue());
        await page.locator('input[name="workbook"]').setInputFiles(workbookPath);
        await page.getByRole("button", { name: "Import", exact: true }).click();
        await expect(page.getByText(/Imported 1 queued/)).toBeVisible({ timeout: 15_000 });
        await openQueueWorkspace(page);
        await expect(queueCount(page, 1)).toBeVisible();
        await expect(queueItem(page, "Dune")).toBeVisible();

        await openImportToast(page);
        await page.locator('input[name="workbook"]').setInputFiles(workbookPath);
        await page.getByRole("button", { name: "Import", exact: true }).click();
        await expect(page.getByText(/No new entries imported\. Skipped 1 queued/)).toBeVisible({ timeout: 15_000 });
        await expect(queueCount(page, 1)).toBeVisible();
    });

    test("new entry category selector routes queued entries to the selected category", async ({
        context,
        page
    }) => {
        await seedUsers([{
            email: "queue-selector@e2e.test",
            name: "Queue Selector",
            queueSettings: { enabled: true },
            categories: [
                { name: "Movies", entries: ["Arrival"] },
                { name: "Books" }
            ]
        }]);
        await signInViaApi(context, "queue-selector@e2e.test");
        await gotoApp(page);
        await expect(page.getByRole("heading", { name: "Movies" })).toBeVisible();

        const newEntry = await openDesktopNewEntry(page);
        await newEntry.fill("Dune");
        await page.getByRole("combobox", { name: "Category" }).click();
        await page.getByRole("option", { name: "Books" }).click();
        await newEntry.press("Enter");

        await expect(page.getByText("Queued Dune for ranking.")).toBeVisible();
        await openQueueWorkspace(page);
        await expect(queueItem(page, "Dune")).toBeVisible();
        await expect(queueCount(page, 1)).toBeVisible();
    });
});
