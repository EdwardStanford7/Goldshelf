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

    test("identical entry image uploads reuse one content-addressed object", async ({ page, context }) => {
        await seedUsers([{
            email: "deduplicated-images@e2e.test",
            name: "Deduplicated Images",
            categories: [{ name: "Movies", entries: ["Arrival", "Dune"] }]
        }]);
        await signInViaApi(context, "deduplicated-images@e2e.test");
        await gotoApp(page);

        const entryIds = await page.locator("[data-entry-id]").evaluateAll((cards) =>
            cards.map((card) => card.getAttribute("data-entry-id")).filter(Boolean) as string[]
        );
        expect(entryIds).toHaveLength(2);

        const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        const uploadedKeys: string[] = [];
        for (const entryId of entryIds) {
            const response = await page.request.post(
                `${BASE_URL}/api/images/${encodeURIComponent(entryId)}`,
                {
                    data: imageBytes,
                    headers: {
                        "content-type": "image/jpeg",
                        origin: BASE_URL
                    }
                }
            );
            expect(response.ok()).toBe(true);
            const body = await response.json() as { imageKey: string };
            uploadedKeys.push(body.imageKey);
        }

        expect(uploadedKeys[0]).toMatch(/^entry-images\/sha256\/[a-f0-9]{64}$/);
        expect(uploadedKeys[1]).toBe(uploadedKeys[0]);

        const firstDelete = await page.request.delete(
            `${BASE_URL}/api/images/${encodeURIComponent(entryIds[0]!)}`,
            { headers: { origin: BASE_URL } }
        );
        expect(firstDelete.ok()).toBe(true);
        const remainingImage = await page.request.get(
            `${BASE_URL}/api/images/${encodeURIComponent(entryIds[1]!)}`
        );
        expect(remainingImage.ok()).toBe(true);

        const secondDelete = await page.request.delete(
            `${BASE_URL}/api/images/${encodeURIComponent(entryIds[1]!)}`,
            { headers: { origin: BASE_URL } }
        );
        expect(secondDelete.ok()).toBe(true);
        const refsResponse = await fetch(
            `${BASE_URL}/api/test/image-refs?email=${encodeURIComponent("deduplicated-images@e2e.test")}`
        );
        const refsBody = await refsResponse.json() as {
            assets: Array<{ object_key: string; unreferenced_at: number | null }>;
        };
        expect(refsBody.assets.find((asset) => asset.object_key === uploadedKeys[0])?.unreferenced_at)
            .toEqual(expect.any(Number));

        const cleanupResponse = await page.request.post(`${BASE_URL}/api/test/cleanup-image-assets`, {
            data: { timestamp: Date.now() + 36 * 24 * 60 * 60 * 1000 }
        });
        expect(cleanupResponse.ok()).toBe(true);
        expect(await cleanupResponse.json()).toMatchObject({ deletedCount: 1, examinedCount: 1 });

        const cleanedRefsResponse = await fetch(
            `${BASE_URL}/api/test/image-refs?email=${encodeURIComponent("deduplicated-images@e2e.test")}`
        );
        const cleanedRefsBody = await cleanedRefsResponse.json() as {
            assets: Array<{ object_key: string }>;
        };
        expect(cleanedRefsBody.assets.some((asset) => asset.object_key === uploadedKeys[0])).toBe(false);
    });
});
