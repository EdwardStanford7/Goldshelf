import { test, expect } from "./base";
import { BASE_URL } from "./constants";
import { ACTIVE_RANKING_LABEL, gotoApp, openNewCategoryDialog, seedUsers, signInViaApi, triggerResumeDashboardRefresh } from "./helpers";

const USER = {
    email: "expiry@e2e.test",
    name: "Expiry",
    categories: [{ name: "Movies", entries: ["Alpha", "Beta"] }]
};


test.describe("Session expiry", () => {
    test("restored dashboard tab refreshes an expired session", async ({
        page,
        context
    }) => {
        await seedUsers([{
            ...USER,
            email: "resume-expiry@e2e.test"
        }]);
        await signInViaApi(context, "resume-expiry@e2e.test");
        await gotoApp(page);
        await expect(page.getByText("#1 Alpha")).toBeVisible();

        await context.clearCookies();
        await triggerResumeDashboardRefresh(page);

        await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
            timeout: 15_000
        });
    });

    test("mutation after session loss redirects to the sign-in page", async ({
        page,
        context
    }) => {
        await seedUsers([USER]);
        await signInViaApi(context, USER.email);
        await gotoApp(page);
        await expect(page.getByText("#1 Alpha")).toBeVisible();

        // Simulate an expired/revoked session mid-use. The page still shows
        // the dashboard, but the next server action must fail with 401.
        await context.clearCookies();

        const categoryDialog = await openNewCategoryDialog(page);
        await categoryDialog.getByPlaceholder("New category").fill("Books");
        await categoryDialog.getByPlaceholder("New category").press("Enter");

        // The UnauthorizedError funnel should send the user to the sign-in
        // screen instead of surfacing an opaque error toast.
        await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
            timeout: 15_000
        });
    });

    test("restored ranking tab recovers when the active ranking disappeared", async ({
        page,
        context
    }) => {
        await seedUsers([{
            ...USER,
            email: "stale-ranking@e2e.test"
        }]);
        await signInViaApi(context, "stale-ranking@e2e.test");
        await gotoApp(page);
        await expect(page.getByText("#1 Alpha")).toBeVisible();

        await page.getByPlaceholder("New entry").fill("Gamma");
        await page.getByPlaceholder("New entry").press("Enter");
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeVisible({ timeout: 15_000 });

        const staleResponse = await page.request.post(`${BASE_URL}/api/test/stale-ranking`, {
            data: { email: "stale-ranking@e2e.test" }
        });
        expect(staleResponse.ok()).toBe(true);

        await triggerResumeDashboardRefresh(page);

        await expect(page.getByText("That ranking is no longer active.")).toBeVisible({
            timeout: 15_000
        });
        await expect(page.getByText(ACTIVE_RANKING_LABEL)).toBeHidden();
        await expect(page.getByText("#1 Alpha")).toBeVisible();
    });
});
