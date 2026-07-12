import { test, expect } from "./base";
import { gotoApp, seedUsers, signInViaApi, winMatchups } from "./helpers";
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
    test("rerank, cancel rerank, and category moves keep orderings consistent", async ({
        page,
        context
    }) => {
        test.setTimeout(120_000);
        await seedUsers([ERIN]);
        await signInViaApi(context, ERIN.email);
        await gotoApp(page);
        await expect(page.getByText("#1 Arrival")).toBeVisible();
        await expect(page.getByText("#4 Solaris")).toBeVisible();

        // --- Reranking the last entry to the top reorders everything below it. ---
        await page.getByText("#4 Solaris").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rerank" }).click();
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Solaris");

        await expect(page.getByText("#1 Solaris")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#2 Arrival")).toBeVisible();
        await expect(page.getByText("#3 Dune")).toBeVisible();
        await expect(page.getByText("#4 Heat")).toBeVisible();

        // --- The new order survives a reload. ---
        await gotoApp(page);
        await expect(page.getByText("#1 Solaris")).toBeVisible();
        await expect(page.getByText("#4 Heat")).toBeVisible();

        // --- Cancelling a rerank restores the entry to its old position. ---
        await page.getByText("#2 Arrival").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rerank" }).click();
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Ranking actions" }).click();
        await page.getByRole("menuitem", { name: "Cancel Rerank" }).click();
        await expect(page.getByText("Cancelled reranking Arrival.")).toBeVisible();
        await expect(page.getByText("#1 Solaris")).toBeVisible();
        await expect(page.getByText("#2 Arrival")).toBeVisible();
        await expect(page.getByText("#4 Heat")).toBeVisible();

        // --- Moving an entry into an empty category places it directly at #1. ---
        await page.getByText("#3 Dune").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Change Category" }).click();
        await page.getByLabel("Move Dune").click();
        await page.getByRole("option", { name: "Books" }).click();
        await page.getByRole("button", { name: "Move", exact: true }).click();

        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
        await expect(page.getByText("#1 Dune")).toBeVisible();

        await page.getByRole("button", { name: "Movies" }).click();
        await expect(page.getByText("#1 Solaris")).toBeVisible();
        await expect(page.getByText("#2 Arrival")).toBeVisible();
        await expect(page.getByText("#3 Heat")).toBeVisible();
        await expect(page.getByText("Dune")).toBeHidden();

        // --- Moving into a non-empty category runs a ranking session there. ---
        await page.getByText("#3 Heat").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Change Category" }).click();
        await page.getByLabel("Move Heat").click();
        await page.getByRole("option", { name: "Books" }).click();
        await page.getByRole("button", { name: "Move", exact: true }).click();

        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });
        await winMatchups(page, "Heat");

        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
        await expect(page.getByText("#1 Heat")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#2 Dune")).toBeVisible();

        // --- Final cross-category state survives a reload. ---
        await gotoApp(page);
        await page.getByRole("button", { name: "Movies" }).click();
        await expect(page.getByText("#1 Solaris")).toBeVisible();
        await expect(page.getByText("#2 Arrival")).toBeVisible();
        await expect(page.getByText("Heat")).toBeHidden();
        await page.getByRole("button", { name: "Books" }).click();
        await expect(page.getByText("#1 Heat")).toBeVisible();
        await expect(page.getByText("#2 Dune")).toBeVisible();
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

        // --- Rename a category from its context menu. ---
        await page.getByRole("button", { name: "Books" }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByLabel("Rename Books").fill("Novels");
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByRole("button", { name: "Novels" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Books" })).toBeHidden();

        // --- Deleting goes through a confirm dialog and removes its entries. ---
        await page.getByRole("button", { name: "Novels" }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await expect(page.getByText("Delete Novels?")).toBeVisible();
        await expect(page.getByText(/permanently removes 1 ranked entry/)).toBeVisible();
        await page.getByRole("button", { name: "Delete Category" }).click();

        await expect(page.getByText("Deleted Novels.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Novels" })).toBeHidden();
        await expect(page.getByText("Hyperion")).toBeHidden();
        await expect(page.getByText("#1 Arrival")).toBeVisible();
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

        await expect(page.getByText("#1 Arrival")).toBeVisible();
        const entryId = await page.locator("[data-entry-id]").first().getAttribute("data-entry-id");
        expect(entryId).toBeTruthy();
        const imageResponse = await page.request.get(`${BASE_URL}/api/images/${encodeURIComponent(entryId!)}`);
        expect(imageResponse.status()).toBe(404);

        await gotoApp(page);
        await page.getByText("#1 Arrival").click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Change Image" })).toBeEnabled();
        await expect(page.getByRole("menuitem", { name: "Pick Image" })).toBeHidden();
    });
});
