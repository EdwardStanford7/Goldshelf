import { test, expect } from "./base";
import { BASE_URL } from "./constants";
import { ACTIVE_RANKING_LABEL, abortNextServerFn, dispatchPersistedPageShow, gotoApp, seedUsers, signInViaApi } from "./helpers";

const REQUEST_LOAD_FAILURE_MESSAGE = "Could not reach the server. Please try again.";
const USER = {
    email: "transient@e2e.test",
    name: "Transient",
    categories: [{ name: "Movies", entries: ["Alpha", "Beta"] }]
};


test.describe("Transient network failures", () => {
    test("dashboard resume suppresses transient load failure and retries", async ({
        page,
        context
    }) => {
        await seedUsers([{
            ...USER,
            email: "resume-transient@e2e.test"
        }]);
        await signInViaApi(context, "resume-transient@e2e.test");
        await gotoApp(page);

        await page.getByPlaceholder("New entry").fill("Gamma");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });

        const staleResponse = await page.request.post(`${BASE_URL}/api/test/stale-ranking`, {
            data: { email: "resume-transient@e2e.test" }
        });
        expect(staleResponse.ok()).toBe(true);

        const didAbortLoadDashboard = await abortNextServerFn(page, "loadDashboard");
        await dispatchPersistedPageShow(page);

        await expect.poll(didAbortLoadDashboard, { timeout: 2_000 }).toBe(true);
        await expect(page.getByText(REQUEST_LOAD_FAILURE_MESSAGE)).toBeHidden();
        await expect(page.getByText("That ranking is no longer active.")).toBeVisible({
            timeout: 15_000
        });
    });

    test("user-triggered mutation failure stays visible", async ({
        page,
        context
    }) => {
        await seedUsers([{
            ...USER,
            email: "mutation-transient@e2e.test"
        }]);
        await signInViaApi(context, "mutation-transient@e2e.test");
        await gotoApp(page);

        const didAbortCreateCategory = await abortNextServerFn(page, "createCategory");
        await page.getByPlaceholder("New category").fill("Books");
        await page.getByPlaceholder("New category").press("Enter");

        await expect(page.getByText(REQUEST_LOAD_FAILURE_MESSAGE)).toBeVisible({ timeout: 15_000 });
        expect(didAbortCreateCategory()).toBe(true);
    });

    test("post-mutation refresh failure is silent and retries", async ({
        page,
        context
    }) => {
        await seedUsers([{
            ...USER,
            email: "refresh-transient@e2e.test"
        }]);
        await signInViaApi(context, "refresh-transient@e2e.test");
        await gotoApp(page);

        const didAbortLoadDashboard = await abortNextServerFn(page, "loadDashboard");
        await page.getByPlaceholder("New category").fill("Books");
        await page.getByPlaceholder("New category").press("Enter");

        await expect.poll(didAbortLoadDashboard, { timeout: 2_000 }).toBe(true);
        await expect(page.getByText(REQUEST_LOAD_FAILURE_MESSAGE)).toBeHidden();
        await expect(page.getByRole("heading", { name: "Books" })).toBeVisible({
            timeout: 15_000
        });
        await expect(page.getByText(REQUEST_LOAD_FAILURE_MESSAGE)).toBeHidden();
    });
});
