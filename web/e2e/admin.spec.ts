import { expect, test } from "./base";
import type { Page } from "@playwright/test";
import { BASE_URL } from "./constants";
import { getAdminAuditRows, gotoApp, seedUsers, signInViaApi, TEST_PASSWORD } from "./helpers";

test.describe("Admin user support", () => {
    test("anonymous visitors and normal users are denied", async ({ context, page }) => {
        await gotoAdmin(page);
        await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible();

        await seedUsers([{ email: "member@e2e.test", name: "Member" }]);
        await signInViaApi(context, "member@e2e.test");

        await gotoAdmin(page);
        await expect(page.getByRole("heading", { name: "Admin access required" })).toBeVisible();
        await expect(page.getByText("Member does not have access to admin tools.")).toBeVisible();
    });

    test("admin can load, search, and page through users", async ({ context, page }) => {
        const users = [
            { email: "admin@e2e.test", name: "Admin", role: "admin" },
            {
                email: "target@e2e.test",
                name: "Target User",
                direct: true,
                categories: [{ name: "Movies", entries: ["Alpha"] }]
            },
            ...Array.from({ length: 22 }, (_, index) => ({
                email: `member-${String(index).padStart(2, "0")}@e2e.test`,
                name: `Member ${index}`,
                direct: true
            }))
        ];
        await seedUsers(users);
        await signInViaApi(context, "admin@e2e.test");

        await gotoAdmin(page);
        await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expect(page.getByText("24 total")).toBeVisible();
        await expect(page.getByText("Page 1 of 2")).toBeVisible();

        await page.getByRole("button", { name: "Next" }).click();
        await expect(page.getByText("Page 2 of 2")).toBeVisible();

        await page.getByLabel("Search users").fill("target@e2e.test");
        await page.getByRole("button", { name: "Search" }).click();
        await expect(page.getByText("1 total")).toBeVisible();
        await expect(page.getByText("target@e2e.test")).toBeVisible();
        await expect(page.getByText("1 categories")).toBeVisible();
        await expect(page.getByText("1 entries")).toBeVisible();
    });

    test("admin can ban and unban users with audit rows and session invalidation", async ({ browser, context, page }) => {
        const seeded = await seedUsers([
            { email: "admin@e2e.test", name: "Admin", role: "admin" },
            { email: "problem@e2e.test", name: "Problem User" }
        ]);
        const targetUser = seeded.find((user) => user.email === "problem@e2e.test");
        expect(targetUser).toBeTruthy();

        const targetContext = await browser.newContext({ baseURL: BASE_URL });
        try {
            await signInViaApi(targetContext, "problem@e2e.test");
            await signInViaApi(context, "admin@e2e.test");

            await gotoAdmin(page);
            await openTargetUser(page, "problem@e2e.test");
            await expect(page.getByText("Active").first()).toBeVisible();

            await page.getByLabel("Ban reason").fill("Repeated abusive uploads");
            await page.getByRole("button", { name: "Ban User" }).click();
            await expect(page.getByText("Banned").first()).toBeVisible();
            await expect(page.getByText("Repeated abusive uploads")).toBeVisible();
            await expect(page.getByText("No active sessions.")).toBeVisible();

            const banRows = await waitForAdminAuditRows({ targetUserId: targetUser!.id, action: "ban_user" }, 1);
            expect(banRows).toHaveLength(1);
            expect(banRows[0].reason).toBe("Repeated abusive uploads");

            const targetPage = await targetContext.newPage();
            await gotoApp(targetPage);
            await expect(targetPage.getByRole("heading", { name: "Rank everything you love." })).toBeVisible();

            const bannedSignIn = await targetContext.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
                data: { email: "problem@e2e.test", password: TEST_PASSWORD },
                headers: { origin: BASE_URL }
            });
            expect(bannedSignIn.ok()).toBe(false);

            await page.getByRole("button", { name: "Unban User" }).click();
            await expect(page.getByText("Active").first()).toBeVisible();
            await expect(page.getByRole("button", { name: "Ban User" })).toBeVisible();

            const unbanRows = await waitForAdminAuditRows({ targetUserId: targetUser!.id, action: "unban_user" }, 1);
            expect(unbanRows).toHaveLength(1);
        } finally {
            await targetContext.close();
        }
    });

    test("admin can revoke one session or all sessions with audit rows", async ({ browser, context, page }) => {
        const seeded = await seedUsers([
            { email: "admin@e2e.test", name: "Admin", role: "admin" },
            { email: "sessions@e2e.test", name: "Sessions User" }
        ]);
        const targetUser = seeded.find((user) => user.email === "sessions@e2e.test");
        expect(targetUser).toBeTruthy();

        const targetContextOne = await browser.newContext({ baseURL: BASE_URL });
        const targetContextTwo = await browser.newContext({ baseURL: BASE_URL });
        try {
            await signInViaApi(targetContextOne, "sessions@e2e.test");
            await signInViaApi(targetContextTwo, "sessions@e2e.test");
            await signInViaApi(context, "admin@e2e.test");

            await gotoAdmin(page);
            await openTargetUser(page, "sessions@e2e.test");
            await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(2);

            await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
            await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(1);
            const revokeSessionRows = await waitForAdminAuditRows({
                targetUserId: targetUser!.id,
                action: "revoke_session"
            }, 1);
            expect(revokeSessionRows).toHaveLength(1);

            await page.getByRole("button", { name: "Revoke All" }).click();
            await expect(page.getByText("No active sessions.")).toBeVisible();
            const revokeAllRows = await waitForAdminAuditRows({
                targetUserId: targetUser!.id,
                action: "revoke_sessions"
            }, 1);
            expect(revokeAllRows).toHaveLength(1);
        } finally {
            await targetContextOne.close();
            await targetContextTwo.close();
        }
    });
});

async function gotoAdmin(page: Page) {
    await page.goto("/admin", { waitUntil: "commit", timeout: 15_000 }).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes("ERR_ABORTED")) {
            throw error;
        }
    });
    await page.waitForSelector("html[data-hydrated]", { timeout: 15_000 });
}

async function openTargetUser(page: Page, email: string) {
    await page.getByLabel("Search users").fill(email);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("1 total")).toBeVisible();
    await page.locator("tbody tr").filter({ hasText: email }).click();
    await expect(page.getByText(email)).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
    const hasHorizontalOverflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(hasHorizontalOverflow).toBe(false);
}

async function waitForAdminAuditRows(
    filters: { targetUserId?: string; action?: string },
    expectedLength: number
) {
    await expect.poll(async () => {
        const rows = await getAdminAuditRows(filters);
        return rows.length;
    }, {
        intervals: [100, 150, 250, 500],
        timeout: 5_000
    }).toBe(expectedLength);

    return getAdminAuditRows(filters);
}
