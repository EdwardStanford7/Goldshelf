import { test, expect } from "./base";
import {
    ACTIVE_RANKING_LABEL,
    chooseCategoryMenuAction,
    chooseEntryMenuAction,
    expectRankedEntries,
    gotoApp,
    rankedEntry,
    seedUsers,
    signInViaApi,
    winMatchups
} from "./helpers";
import { BASE_URL } from "./constants";

const ERIN = {
    email: "erin@e2e.test",
    name: "Erin",
    categories: [
        { name: "Movies", entries: ["Arrival", "Dune", "Heat", "Solaris"] },
        { name: "Books", entries: [] as string[] }
    ]
};

test.describe("Entry operations", () => {
    test("reranking an entry to the top persists after reload", async ({
        page,
        context
    }) => {
        await seedUsers([ERIN]);
        await signInViaApi(context, ERIN.email);
        await gotoApp(page);
        await expectRankedEntries(page, ["Arrival", "Dune", "Heat", "Solaris"]);

        await chooseEntryMenuAction(page, { rank: 4, name: "Solaris" }, "Rerank");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Solaris");

        await expectRankedEntries(page, ["Solaris", "Arrival", "Dune", "Heat"]);

        await gotoApp(page);
        await expectRankedEntries(page, ["Solaris", "Arrival", "Dune", "Heat"]);
    });

    test("canceling a rerank restores the entry position", async ({
        page,
        context
    }) => {
        await seedUsers([ERIN]);
        await signInViaApi(context, ERIN.email);
        await gotoApp(page);
        await expectRankedEntries(page, ["Arrival", "Dune", "Heat", "Solaris"]);

        await chooseEntryMenuAction(page, { rank: 2, name: "Dune" }, "Rerank");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Ranking actions" }).click();
        await page.getByRole("menuitem", { name: "Cancel Rerank" }).click();

        await expect(page.getByText("Cancelled reranking Dune.")).toBeVisible();
        await expectRankedEntries(page, ["Arrival", "Dune", "Heat", "Solaris"]);
    });

    test("moving entries between categories keeps both category orders consistent", async ({
        page,
        context
    }) => {
        await seedUsers([ERIN]);
        await signInViaApi(context, ERIN.email);
        await gotoApp(page);
        await expectRankedEntries(page, ["Arrival", "Dune", "Heat", "Solaris"]);

        await chooseEntryMenuAction(page, { rank: 2, name: "Dune" }, "Change Category");
        await page.getByLabel("Move Dune").click();
        await page.getByRole("option", { name: "Books" }).click();
        await page.getByRole("button", { name: "Move", exact: true }).click();

        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
        await expect(rankedEntry(page, 1, "Dune")).toBeVisible();

        await page.getByRole("button", { name: "Movies" }).click();
        await expectRankedEntries(page, ["Arrival", "Heat", "Solaris"]);
        await expect(rankedEntry(page, 1, "Dune")).toBeHidden();

        await chooseEntryMenuAction(page, { rank: 2, name: "Heat" }, "Change Category");
        await page.getByLabel("Move Heat").click();
        await page.getByRole("option", { name: "Books" }).click();
        await page.getByRole("button", { name: "Move", exact: true }).click();

        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Heat");

        await page.getByRole("button", { name: "Books" }).click();
        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
        await expectRankedEntries(page, ["Heat", "Dune"]);

        await gotoApp(page);
        await page.getByRole("button", { name: "Movies" }).click();
        await expectRankedEntries(page, ["Arrival", "Solaris"]);
        await expect(rankedEntry(page, 1, "Heat")).toBeHidden();
        await page.getByRole("button", { name: "Books" }).click();
        await expectRankedEntries(page, ["Heat", "Dune"]);
    });

    test("categories can be renamed and deleted with confirmation", async ({ page, context }) => {
        await seedUsers([
            {
                email: ERIN.email,
                name: ERIN.name,
                categories: [
                    { name: "Movies", entries: ["Arrival", "Dune"] },
                    { name: "Books", entries: ["Hyperion"] }
                ]
            }
        ]);
        await signInViaApi(context, ERIN.email);
        await gotoApp(page);

        await chooseCategoryMenuAction(page, "Books", "Rename");
        await page.getByLabel("Rename Books").fill("Novels");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("button", { name: "Novels" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Books" })).toBeHidden();

        await chooseCategoryMenuAction(page, "Novels", "Delete");
        await expect(page.getByText("Delete Novels?")).toBeVisible();
        await expect(page.getByText(/permanently removes 1 ranked entry/)).toBeVisible();
        await page.getByRole("button", { name: "Delete Category" }).click();

        await expect(page.getByText("Deleted Novels.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Novels" })).toBeHidden();
        await expect(page.getByText("Hyperion")).toBeHidden();
        await expect(rankedEntry(page, 1, "Arrival")).toBeVisible();
    });

    test("missing stored image objects do not clear entry image keys on read", async ({ page, context }) => {
        await seedUsers([{
            email: "missing-image@e2e.test",
            name: "Missing Image",
            categories: [{
                name: "Movies",
                entries: [{ name: "Arrival", imageKey: "missing-image-test/arrival.jpg" }]
            }]
        }]);
        await signInViaApi(context, "missing-image@e2e.test");
        await gotoApp(page);

        await expect(rankedEntry(page, 1, "Arrival")).toBeVisible();
        const entryId = await page.locator("[data-entry-id]").first().getAttribute("data-entry-id");
        expect(entryId).toBeTruthy();
        const imageResponse = await page.request.get(`${BASE_URL}/api/images/${encodeURIComponent(entryId!)}`);
        expect(imageResponse.status()).toBe(404);

        await gotoApp(page);
        await rankedEntry(page, 1, "Arrival").click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Change Image" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Pick Image" })).toBeHidden();
    });
});
