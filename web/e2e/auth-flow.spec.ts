import { test, expect } from "./base";
import { getAuthUrl, gotoApp, openAccountMenu, seedUsers, signInViaApi, TEST_PASSWORD } from "./helpers";

test.describe("Auth flows", () => {
    test("marketing landing shows for logged-out visitors at /", async ({ page }) => {
        await gotoApp(page);
        await expect(
            page.getByRole("heading", { name: "Rank everything you love." })
        ).toBeVisible();

        await page.getByRole("link", { name: "Start your shelf" }).first().click();
        await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
    });

    test("shows the sign-in page when logged out", async ({ page }) => {
        await gotoApp(page, "/signin");
        await expect(page.getByRole("heading", { name: "Goldshelf" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

        await page.getByRole("link", { name: "Goldshelf" }).click();
        await expect(page.getByRole("heading", { name: "Rank everything you love." })).toBeVisible();
    });

    test("sign up lands on an empty dashboard", async ({ page }) => {
        await gotoApp(page, "/signin");
        await page.getByRole("link", { name: "Create an account" }).click();
        await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();

        await page.getByLabel("Name").fill("Test User");
        await page.getByLabel("Email").fill("signup@e2e.test");
        await page.getByRole("textbox", { name: /^Password/ }).fill(TEST_PASSWORD);
        await page.getByRole("button", { name: "Create account" }).click();

        await expect(page.getByText("Create Your First Category")).toBeVisible({ timeout: 15_000 });
    });

    test("seeded user can sign in and sees their data", async ({ page }) => {
        await seedUsers([
            {
                email: "reader@e2e.test",
                name: "Reader",
                categories: [{ name: "Movies", entries: ["Alpha", "Beta"] }]
            }
        ]);

        await gotoApp(page, "/signin");
        await page.getByLabel("Email").fill("reader@e2e.test");
        await page.getByRole("textbox", { name: /^Password/ }).fill(TEST_PASSWORD);
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page.getByRole("heading", { name: "Movies" })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("#1 Alpha")).toBeVisible();
        await expect(page.getByText("#2 Beta")).toBeVisible();
    });

    test("wrong password shows an error", async ({ page }) => {
        await seedUsers([{ email: "reader@e2e.test", name: "Reader" }]);

        await gotoApp(page, "/signin");
        await page.getByLabel("Email").fill("reader@e2e.test");
        await page.getByRole("textbox", { name: /^Password/ }).fill("not-the-right-password");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
    });

    test("sign out returns to the marketing home", async ({ page, context }) => {
        await seedUsers([{ email: "reader@e2e.test", name: "Reader" }]);
        await signInViaApi(context, "reader@e2e.test");

        await gotoApp(page);
        await expect(page.getByText("Create Your First Category")).toBeVisible();

        const accountMenu = await openAccountMenu(page);
        await accountMenu.getByRole("menuitem", { name: "Sign Out" }).click();

        await expect(
            page.getByRole("heading", { name: "Rank everything you love." })
        ).toBeVisible({ timeout: 15_000 });
    });

    test("password reset via captured email link", async ({ page }) => {
        const email = "forgetful@e2e.test";
        await seedUsers([{ email, name: "Forgetful" }]);
        const newPassword = "brand-new-passphrase-42";

        await gotoApp(page, "/signin");
        await page.getByRole("button", { name: "Forgot password?" }).click();
        await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
        await page.getByLabel("Email").fill(email);
        await page.getByRole("button", { name: "Send reset link" }).click();
        await expect(page.getByText("If that email exists, check your inbox for a reset link.")).toBeVisible();

        // The reset link is captured server-side in TEST_MODE instead of emailing.
        // Its callbackURL points at production, so extract the token and use the
        // app's own ?token= reset form instead of following the redirect chain.
        const resetUrl = await getAuthUrl(email, "reset-password");
        const token = /reset-password\/([^/?]+)/.exec(resetUrl)?.[1];
        expect(token, `unexpected reset URL shape: ${resetUrl}`).toBeTruthy();

        await gotoApp(page, `/signin?token=${token}`);
        await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
        await page.getByRole("textbox", { name: /^New password/ }).fill(newPassword);
        await page.getByRole("textbox", { name: /^Confirm password/ }).fill(newPassword);
        await page.getByRole("button", { name: "Update password" }).click();
        await expect(page.getByText("Password updated. Sign in with your new password.")).toBeVisible();

        await page.getByLabel("Email").fill(email);
        await page.getByRole("textbox", { name: /^Password/ }).fill(newPassword);
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page.getByText("Create Your First Category")).toBeVisible({ timeout: 15_000 });
    });
});
