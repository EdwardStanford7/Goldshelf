import type { Page } from "@playwright/test";
import { test, expect } from "./base";
import { gotoApp, openAccountMenu, seedUsers, signInViaApi, winMatchups } from "./helpers";
import { BASE_URL } from "./constants";

const RANKER = {
    email: "ranker@e2e.test",
    name: "Ranker",
    categories: [{ name: "Movies", entries: ["Alpha", "Beta", "Gamma"] }]
};

const ACTIVE_RANKING_LABEL = /Binary Rank|Placement Check|Local Repair/;

async function forceRankingDisplayPhase(
    page: Page,
    email: string,
    phase: "binary" | "placement_check" | "local_repair"
) {
    const response = await page.request.post(`${BASE_URL}/api/test/ranking-display-phase`, {
        data: { email, phase }
    });
    if (!response.ok()) {
        throw new Error(`Failed to force ranking display phase: ${response.status()} ${await response.text()}`);
    }
}

function rankingPanel(page: Page, label: string) {
    return page.locator("section", { hasText: `${label} · Movies` }).first();
}

test.describe("Ranking", () => {
    test("mobile dashboard opens on compact app content and drawer tools work", async ({
        page,
        context
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await seedUsers([{
            email: "mobile@e2e.test",
            name: "Mobile",
            queueSettings: {
                enabled: true,
                promptForMissingImages: false
            },
            categories: [
                { name: "Books", entries: ["Dune", "Hyperion", "Foundation"] },
                { name: "Movies", entries: ["Arrival"] }
            ]
        }]);
        await signInViaApi(context, "mobile@e2e.test");
        await gotoApp(page);

        const mobileHeader = page.getByTestId("mobile-dashboard-header");
        await expect(mobileHeader).toBeVisible();
        await expect(mobileHeader.getByRole("heading", { name: "Books" })).toBeVisible();
        await expect(page.getByText("New Category")).toBeHidden();

        const avatarBox = await page.getByRole("button", { name: "Account menu" }).boundingBox();
        const headerBox = await mobileHeader.boundingBox();
        expect(avatarBox?.x).toBeLessThan(24);
        expect(avatarBox?.y).toBeLessThan(80);
        expect(headerBox?.height).toBeLessThan(140);

        const accountMenu = await openAccountMenu(page);
        await accountMenu.getByRole("menuitem", { name: "Settings", exact: true }).hover();
        const settingsSubmenu = page
            .locator("[data-slot='dropdown-menu-sub-content'][data-state='open']", { hasText: "Randomize queue ranking" })
            .first();
        await expect(settingsSubmenu).toBeVisible();
        const submenuBox = await settingsSubmenu.boundingBox();
        expect(submenuBox?.x).toBeGreaterThanOrEqual(0);
        expect((submenuBox?.x ?? 0) + (submenuBox?.width ?? 0)).toBeLessThanOrEqual(390);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await expect(settingsSubmenu).toBeHidden();

        const firstCardWidth = await page.locator("[data-entry-id]").first().evaluate((element) => element.getBoundingClientRect().width);
        expect(firstCardWidth).toBeGreaterThan(140);
        expect(firstCardWidth).toBeLessThan(210);
        await mobileHeader.getByLabel("Search entries").fill("Dune");
        await expect(page.getByText("#1 Dune")).toBeVisible();
        const filteredCardWidth = await page.locator("[data-entry-id]").first().evaluate((element) => element.getBoundingClientRect().width);
        expect(Math.abs(filteredCardWidth - firstCardWidth)).toBeLessThanOrEqual(1);
        await mobileHeader.getByLabel("Search entries").fill("");

        await page.getByTestId("mobile-tools-trigger").click();
        let drawer = page.getByRole("dialog", { name: "Dashboard tools" });
        await expect(drawer.getByText("New Entry")).toBeVisible();
        await drawer.locator("[data-category-id]").filter({ hasText: "Movies" }).getByRole("button").first().click();
        await expect(drawer).toBeHidden();
        await expect(mobileHeader.getByRole("heading", { name: "Movies" })).toBeVisible();

        await page.getByTestId("mobile-tools-trigger").click();
        drawer = page.getByRole("dialog", { name: "Dashboard tools" });
        await drawer.getByRole("button", { name: "New Entry" }).click();
        await expect(drawer).toBeHidden({ timeout: 15_000 });
        let mobilePanel = page.getByRole("dialog", { name: "New Entry" });
        await mobilePanel.getByPlaceholder("New entry").fill("Memento");
        await mobilePanel.getByPlaceholder("New entry").press("Enter");
        await expect(mobilePanel).toBeHidden({ timeout: 15_000 });

        await page.getByTestId("mobile-tools-trigger").click();
        drawer = page.getByRole("dialog", { name: "Dashboard tools" });
        await drawer.getByRole("button", { name: /^Queue/ }).click();
        await expect(drawer).toBeHidden();
        mobilePanel = page.getByRole("dialog", { name: "Queue" });
        await expect(mobilePanel.getByText("1 queued")).toBeVisible();
        await expect(mobilePanel.getByText("Memento").first()).toBeVisible();
        await mobilePanel.getByLabel("Actions for queued Memento").click();
        await expect(page.getByRole("menuitem", { name: "Rank Now" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Pick image" })).toBeEnabled();
        await page.getByRole("menuitem", { name: "Pick image" }).click();
        await expect(mobilePanel).toBeHidden();
        const imagePicker = page.locator("section", { hasText: "Pick Image" }).first();
        await expect(imagePicker.getByRole("button", { name: "Close" })).toBeVisible();
        await imagePicker.getByRole("button", { name: "Close" }).click();
        await expect(imagePicker).toBeHidden();

        await page.getByTestId("mobile-tools-trigger").click();
        drawer = page.getByRole("dialog", { name: "Dashboard tools" });
        await drawer.getByRole("button", { name: /^Queue/ }).click();
        mobilePanel = page.getByRole("dialog", { name: "Queue" });
        await mobilePanel.getByLabel("Actions for queued Memento").click();
        await expect(page.getByRole("menuitem", { name: "Remove" })).toBeEnabled();
    });

    test("mobile tap action menus expose entry, category, queue, and ranking actions", async ({
        page,
        context
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await seedUsers([{
            ...RANKER,
            queueSettings: {
                enabled: false,
                promptForMissingImages: false
            }
        }]);
        await signInViaApi(context, RANKER.email);
        await gotoApp(page);

        await page.getByLabel("Actions for Alpha").click();
        await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Pick Image" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Rerank" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Change Category" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Delete" })).toBeEnabled();
        await page.keyboard.press("Escape");

        await page.getByTestId("mobile-tools-trigger").click();
        let drawer = page.getByRole("dialog", { name: "Dashboard tools" });
        await drawer.getByLabel("Actions for Movies").click();
        await expect(page.getByRole("menuitem", { name: "Repair This Category" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Delete" })).toBeEnabled();
        await page.keyboard.press("Escape");
        await drawer.getByRole("button", { name: "Close", exact: true }).click();

        await page.getByTestId("mobile-tools-trigger").click();
        drawer = page.getByRole("dialog", { name: "Dashboard tools" });
        await drawer.getByRole("button", { name: "New Entry" }).click();
        await expect(drawer).toBeHidden({ timeout: 15_000 });
        const newEntryPanel = page.getByRole("dialog", { name: "New Entry" });
        await newEntryPanel.getByPlaceholder("New entry").fill("Zeta");
        await newEntryPanel.getByPlaceholder("New entry").press("Enter");
        await expect(newEntryPanel).toBeHidden({ timeout: 15_000 });
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("ranking-choice-card")).toHaveCount(2);
        const choiceBoxes = await page.getByTestId("ranking-choice-card").evaluateAll((nodes) =>
            nodes.map((node) => {
                const box = node.getBoundingClientRect();
                return {
                    top: box.top,
                    width: box.width
                };
            })
        );
        expect(Math.abs(choiceBoxes[0].top - choiceBoxes[1].top)).toBeLessThanOrEqual(2);
        expect(choiceBoxes[0].width).toBeLessThan(210);

        await page.getByLabel("Actions for Zeta").click();
        await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Pick Image" })).toBeEnabled();
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByLabel("Rename Zeta").fill("Zeta Prime");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByLabel("Actions for Zeta Prime")).toBeVisible({ timeout: 15_000 });
    });

    test("dashboard topbar stays flush while the entry list scrolls", async ({
        page,
        context
    }) => {
        await seedUsers([{
            email: "layout@e2e.test",
            name: "Layout",
            categories: [{
                name: "Long List",
                entries: Array.from({ length: 30 }, (_, index) => `Item ${index + 1}`)
            }]
        }]);
        await signInViaApi(context, "layout@e2e.test");
        await gotoApp(page);
        await expect(page.getByText("#1 Item 1")).toBeVisible();

        const scroller = page.getByTestId("dashboard-scroll-region");
        await scroller.evaluate((element) => element.scrollTo({ top: 520 }));
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

        const metrics = await page.evaluate(() => {
            const topbarElement = document.querySelector("[data-testid='dashboard-topbar']");
            const scrollRegionElement = document.querySelector("[data-testid='dashboard-scroll-region']");
            const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-entry-id]"));
            const topbar = topbarElement?.getBoundingClientRect();
            const scrollRegion = scrollRegionElement?.getBoundingClientRect();
            if (!topbar || !scrollRegion || !scrollRegionElement || cards.length === 0) {
                throw new Error("Dashboard layout markers not found");
            }

            const firstCard = cards[0].getBoundingClientRect();
            const firstRowCards = cards
                .map((card) => card.getBoundingClientRect())
                .filter((card) => Math.abs(card.top - firstCard.top) < 2);
            const style = getComputedStyle(scrollRegionElement);
            const contentRight = scrollRegion.right - Number.parseFloat(style.paddingRight);

            return {
                firstRowCardWidth: firstCard.width,
                firstRowRightGap: contentRight - Math.max(...firstRowCards.map((card) => card.right)),
                scrollRegionTop: scrollRegion.top,
                topbarBottom: topbar.bottom,
                topbarTop: topbar.top
            };
        });

        expect(Math.abs(metrics.topbarTop)).toBeLessThanOrEqual(1);
        expect(metrics.scrollRegionTop).toBeGreaterThanOrEqual(metrics.topbarBottom - 1);
        expect(metrics.firstRowCardWidth).toBeGreaterThan(200);
        expect(metrics.firstRowRightGap).toBeLessThanOrEqual(12);
    });

    test("desktop sidebar scrolls instead of collapsing controls on short viewports", async ({
        page,
        context
    }) => {
        await page.setViewportSize({ width: 1000, height: 520 });
        await seedUsers([{
            email: "short-sidebar@e2e.test",
            name: "Short Sidebar",
            queueSettings: {
                enabled: true,
                promptForMissingImages: false
            },
            categories: [
                { name: "Books", entries: ["Dune", "Hyperion"] },
                { name: "Movies", entries: ["Arrival", "Heat"] },
                { name: "Shows", entries: ["Severance", "Andor"] },
                { name: "Games", entries: ["Celeste", "Hades"] }
            ],
            queuedEntries: [
                { categoryName: "Books", name: "Foundation", createdAt: 1 },
                { categoryName: "Movies", name: "Memento", createdAt: 2 },
                { categoryName: "Shows", name: "Dark", createdAt: 3 }
            ]
        }]);
        await signInViaApi(context, "short-sidebar@e2e.test");
        await gotoApp(page);

        const metrics = await page.getByTestId("dashboard-sidebar").evaluate((sidebar) => {
            const controls = Array.from(sidebar.querySelectorAll<HTMLElement>("input, button, [role='combobox']"));
            const sections = Array.from(sidebar.querySelectorAll<HTMLElement>("section"));
            const protrudingControls = controls.filter((control) => {
                const section = control.closest("section");
                if (!section) {
                    return false;
                }

                let ancestor = control.parentElement;
                while (ancestor && ancestor !== section) {
                    const overflowY = getComputedStyle(ancestor).overflowY;
                    if (overflowY === "auto" || overflowY === "scroll") {
                        return false;
                    }
                    ancestor = ancestor.parentElement;
                }

                const controlBox = control.getBoundingClientRect();
                const sectionBox = section.getBoundingClientRect();
                return controlBox.top < sectionBox.top - 1 || controlBox.bottom > sectionBox.bottom + 1;
            });

            return {
                clientHeight: sidebar.clientHeight,
                minSectionHeight: Math.min(...sections.map((section) => section.getBoundingClientRect().height)),
                protrudingControlCount: protrudingControls.length,
                scrollHeight: sidebar.scrollHeight
            };
        });

        expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
        expect(metrics.minSectionHeight).toBeGreaterThan(80);
        expect(metrics.protrudingControlCount).toBe(0);
    });

    test("repair mode starts, skips, survives reload, and cancels", async ({
        page,
        context
    }) => {
        await seedUsers([{
            email: "repair-loop@e2e.test",
            name: "Repair Loop",
            queueSettings: {
                enabled: false,
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Alpha", "Beta", "Gamma", "Delta"] }]
        }]);
        await signInViaApi(context, "repair-loop@e2e.test");
        await gotoApp(page);

        await page.getByRole("button", { name: "Repair Mode" }).click();
        await expect(page.getByText("Repair Check · Movies")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("New Entry")).toBeVisible();
        await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();

        await page.getByPlaceholder("New entry").fill("Omega");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText("Queued Omega for ranking.")).toBeVisible();
        await expect(page.getByText("1 queued")).toBeVisible();
        await expect(page.getByText("Repair Check · Movies")).toBeVisible();

        await page.getByRole("button", { name: "Skip" }).click();
        await expect(page.getByText("Repair Check · Movies")).toBeVisible({ timeout: 15_000 });

        await gotoApp(page);
        await expect(page.getByText("Repair Check · Movies")).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Exit Repair Mode" }).click();
        await expect(page.getByText("Repair Check · Movies")).toBeHidden({ timeout: 15_000 });
        await expect(page.getByText("New Entry")).toBeVisible();
    });

    test("repair anomaly enters local repair and active choices expose metadata actions", async ({
        page,
        context
    }) => {
        await seedUsers([{
            email: "repair-anomaly@e2e.test",
            name: "Repair Anomaly",
            queueSettings: {
                enabled: false,
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Alpha", "Beta", "Gamma", "Delta"] }]
        }]);
        await signInViaApi(context, "repair-anomaly@e2e.test");
        await gotoApp(page);

        await page.locator("[data-category-id]").filter({ hasText: "Movies" }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Repair This Category" }).click();
        const repairPanel = page.locator("section", { hasText: "Repair Check · Movies" }).first();
        await expect(repairPanel).toBeVisible({ timeout: 15_000 });

        await repairPanel.locator("article > button.block").nth(1).click();
        const localRepairPanel = page.locator("section", { hasText: "Local Repair · Movies" }).first();
        await expect(localRepairPanel).toBeVisible({ timeout: 15_000 });

        await localRepairPanel.locator("article").first().click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: /Pick Image|Change Image/ })).toBeEnabled();
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: "Exit Repair Mode" }).click();
        await expect(localRepairPanel).toBeHidden({ timeout: 15_000 });
    });

    test("repair mode can undo the previous match", async ({
        page,
        context
    }) => {
        await seedUsers([{
            email: "repair-undo@e2e.test",
            name: "Repair Undo",
            queueSettings: {
                enabled: false,
                promptForMissingImages: false
            },
            categories: [{ name: "Movies", entries: ["Alpha", "Beta", "Gamma", "Delta"] }]
        }]);
        await signInViaApi(context, "repair-undo@e2e.test");
        await gotoApp(page);

        await page.locator("[data-category-id]").filter({ hasText: "Movies" }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Repair This Category" }).click();
        const panel = page.locator("section", { hasText: "Repair Check · Movies" }).first();
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect(panel.getByText(/0 comparisons · 0 repairs/)).toBeVisible();

        await panel.locator("article > button.block").nth(1).click();
        await expect(page.getByRole("button", { name: "Undo Last Match" })).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Undo Last Match" }).click();

        await expect(page.getByText("Repair Check · Movies")).toBeVisible({ timeout: 15_000 });
        await expect(panel.getByText(/0 comparisons · 0 repairs/)).toBeVisible();
        await expect(page.getByRole("button", { name: "Undo Last Match" })).toBeHidden();
    });

    test("create a category and add the first entry", async ({ page, context }) => {
        await seedUsers([{ email: RANKER.email, name: RANKER.name }]);
        await signInViaApi(context, RANKER.email);
        await gotoApp(page);

        await page.getByPlaceholder("New category").fill("Books");
        await page.getByPlaceholder("New category").press("Enter");
        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();

        await page.getByPlaceholder("New entry").fill("Dune");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText("#1 Dune")).toBeVisible();
    });

    test("new entry ranked via binary matchups lands at #1 when it always wins", async ({
        page,
        context
    }) => {
        await seedUsers([RANKER]);
        await signInViaApi(context, RANKER.email);
        await gotoApp(page);
        await expect(page.getByText("#1 Alpha")).toBeVisible();

        await page.getByPlaceholder("New entry").fill("Zeta");
        await page.getByPlaceholder("New entry").press("Enter");

        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Zeta");

        await expect(page.getByText("#1 Zeta")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#2 Alpha")).toBeVisible();
        await expect(page.getByText("#4 Gamma")).toBeVisible();
    });

    test("ranking can undo the previous in-progress match", async ({
        page,
        context
    }) => {
        await seedUsers([RANKER]);
        await signInViaApi(context, RANKER.email);
        await gotoApp(page);

        await page.getByPlaceholder("New entry").fill("Zeta");
        await page.getByPlaceholder("New entry").press("Enter");
        const panel = page.locator("section", { hasText: ACTIVE_RANKING_LABEL }).first();
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect(panel.getByText(/0 comparisons/)).toBeVisible();
        await expect(page.getByRole("button", { name: "Undo Last Match" })).toBeHidden();

        await page.getByRole("button", { name: "Zeta" }).click();
        await expect(page.getByRole("button", { name: "Undo Last Match" })).toBeVisible({ timeout: 15_000 });
        await expect(panel.getByText(/1 comparisons/)).toBeVisible();

        await page.getByRole("button", { name: "Undo Last Match" }).click();
        await expect(panel.getByText(/0 comparisons/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("button", { name: "Undo Last Match" })).toBeHidden();
        await expect(page.getByRole("button", { name: "Zeta" })).toBeVisible();
    });

    test("ranking panel labels placement checks before local repair", async ({
        page,
        context
    }) => {
        const email = "phase-display@e2e.test";
        await seedUsers([{
            email,
            name: "Phase Display",
            categories: [{ name: "Movies", entries: ["Alpha", "Beta", "Gamma"] }]
        }]);
        await signInViaApi(context, email);
        await gotoApp(page);

        await page.getByPlaceholder("New entry").fill("Zeta");
        await page.getByPlaceholder("New entry").press("Enter");

        const binaryPanel = rankingPanel(page, "Binary Rank");
        await expect(binaryPanel).toBeVisible({ timeout: 15_000 });
        await expect(binaryPanel.getByText(/Range \d+-\d+ · \d+ comparisons/)).toBeVisible();

        await forceRankingDisplayPhase(page, email, "placement_check");
        await gotoApp(page);
        const placementPanel = rankingPanel(page, "Placement Check");
        await expect(placementPanel).toBeVisible();
        await expect(placementPanel.getByText(/\d+ comparisons/)).toBeVisible();
        await expect(placementPanel.getByText(/Range \d+-\d+/)).toBeHidden();

        await forceRankingDisplayPhase(page, email, "local_repair");
        await gotoApp(page);
        const repairPanel = rankingPanel(page, "Local Repair");
        await expect(repairPanel).toBeVisible();
        await expect(repairPanel.getByText(/\d+ comparisons/)).toBeVisible();
        await expect(repairPanel.getByText(/Range \d+-\d+/)).toBeHidden();
    });

    test("profile navigation during ranking preserves the active session", async ({
        page,
        context
    }) => {
        await seedUsers([RANKER]);
        await signInViaApi(context, RANKER.email);
        await gotoApp(page);

        await page.getByPlaceholder("New entry").fill("Zeta");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });

        const accountMenu = await openAccountMenu(page);
        await accountMenu.getByRole("menuitem", { name: "Profile" }).click();
        await expect(page).toHaveURL("/profile");
        await expect(page.getByRole("heading", { name: "Ranker" })).toBeVisible();

        await gotoApp(page);
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("button", { name: "Zeta" })).toBeVisible();
        await winMatchups(page, "Zeta");
        await expect(page.getByText("#1 Zeta")).toBeVisible({ timeout: 15_000 });
    });

    test("entry metadata actions stay available while ranking but order actions stay locked", async ({
        page,
        context
    }) => {
        await seedUsers([RANKER]);
        await signInViaApi(context, RANKER.email);
        await gotoApp(page);

        await page.getByPlaceholder("New entry").fill("Zeta");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Zeta" }).click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Pick Image" })).toBeEnabled();
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByLabel("Rename Zeta").fill("Zeta Prime");
        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect(page.getByRole("button", { name: "Zeta Prime" })).toBeVisible({ timeout: 15_000 });
        await page.getByText("#1 Alpha").click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Pick Image" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Rerank" })).toHaveAttribute("aria-disabled", "true");
        await expect(page.getByRole("menuitem", { name: "Change Category" })).toHaveAttribute("aria-disabled", "true");
        await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");

        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByLabel("Rename Alpha").fill("Alpha Prime");
        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect(page.getByText("#1 Alpha Prime")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible();
    });

    test("deleted entry can be restored via the undo toast", async ({ page, context }) => {
        await seedUsers([RANKER]);
        await signInViaApi(context, RANKER.email);
        await gotoApp(page);
        await expect(page.getByText("#1 Alpha")).toBeVisible();

        await page.getByText("#1 Alpha").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Delete" }).click();

        await expect(page.getByText("Deleted Alpha.")).toBeVisible();
        await expect(page.getByText("#1 Alpha")).toBeHidden();

        await page.getByRole("button", { name: "Undo" }).click();
        await expect(page.getByText("Restored Alpha.")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#1 Alpha")).toBeVisible();
    });

    test("entries can be renamed from the context menu", async ({ page, context }) => {
        await seedUsers([RANKER]);
        await signInViaApi(context, RANKER.email);
        await gotoApp(page);
        await expect(page.getByText("#2 Beta")).toBeVisible();

        await page.getByText("#2 Beta").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByLabel("Rename Beta").fill("Beta Prime");
        await page.getByRole("button", { name: "Save" }).click();

        await expect(page.getByText("#2 Beta Prime")).toBeVisible({ timeout: 15_000 });
    });
});
