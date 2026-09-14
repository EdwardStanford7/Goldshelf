import type { Page } from "@playwright/test";
import { test, expect } from "./base";
import { BASE_URL } from "./constants";
import { gotoApp, isServerFnRequest, seedUsers, signInViaApi } from "./helpers";

const USER = {
    email: "expiry@e2e.test",
    name: "Expiry",
    categories: [{ name: "Movies", entries: ["Alpha", "Beta"] }]
};

async function dispatchPersistedPageShow(page: Page) {
    await page.evaluate(() => {
        const event = new Event("pageshow") as PageTransitionEvent;
        Object.defineProperty(event, "persisted", { value: true });
        window.dispatchEvent(event);
    });
}

async function triggerResumeDashboardRefresh(page: Page) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const dashboardRefresh = page
            .waitForResponse((response) => isServerFnRequest(response.url(), "loadDashboard"), {
                timeout: 1_000
            })
            .catch(() => null);

        await dispatchPersistedPageShow(page);
        const response = await dashboardRefresh;
        if (response) {
            return response;
        }

        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }

    throw new Error("Dashboard resume event did not request fresh dashboard data");
}

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

        await page.getByPlaceholder("New category").fill("Books");
        await page.getByPlaceholder("New category").press("Enter");

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
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeVisible({ timeout: 15_000 });

        const staleResponse = await page.request.post(`${BASE_URL}/api/test/stale-ranking`, {
            data: { email: "stale-ranking@e2e.test" }
        });
        expect(staleResponse.ok()).toBe(true);

        await triggerResumeDashboardRefresh(page);

        await expect(page.getByText("That ranking is no longer active.")).toBeVisible({
            timeout: 15_000
        });
        await expect(page.getByText(/Binary Rank|Placement Check|Local Repair/)).toBeHidden();
        await expect(page.getByText("#1 Alpha")).toBeVisible();
    });
});
