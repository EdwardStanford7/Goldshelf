import type { Page } from "@playwright/test";
import { test, expect } from "./base";
import { BASE_URL } from "./constants";
import { categoryButton, gotoApp, openNewCategoryDialog, openQueueWorkspace, queueCount, seedUsers, signInViaApi } from "./helpers";

const ALICE = {
    email: "alice@e2e.test",
    name: "Alice Park",
    categories: [
        { name: "Movies", entries: ["Arrival", "Dune"] },
        { name: "Books", entries: ["Hyperion"] }
    ]
};

const BOB = {
    email: "bob@e2e.test",
    name: "Bob Stone",
    categories: [] as Array<{ name: string; entries: string[] }>
};

const CHARLIE = {
    email: "charlie@e2e.test",
    name: "Charlie Day",
    categories: [{ name: "Music", entries: ["Kind of Blue"] }]
};

/** Reads the @handle shown in the profile settings header. */
async function readOwnSlug(page: Page) {
    const handleText = await page.getByText(/^@[a-z0-9-]+$/).first().textContent();
    expect(handleText, "profile handle should be visible on /profile").toBeTruthy();
    return handleText!.slice(1);
}

async function openSettingsSection(page: Page, section: "Profile" | "Shelves" | "Privacy & social" | "Account") {
    const tabLabel = section === "Shelves"
        ? "Library & ranking"
        : section === "Profile" || section === "Account"
            ? "Profile & account"
            : section;
    const tab = page.getByRole("button", { name: tabLabel, exact: true });
    if (await tab.getAttribute("aria-current") !== "page") {
        await tab.click();
    }
}

test.describe("Profiles", () => {
    test("profile photo upload opens an editor before saving", async ({
        page,
        context
    }) => {
        await seedUsers([{ email: "avatar@e2e.test", name: "Avatar Tester" }]);
        await signInViaApi(context, "avatar@e2e.test");
        await gotoApp(page, "/profile");

        await page.locator("input[type='file']").setInputFiles({
            name: "avatar.svg",
            mimeType: "image/svg+xml",
            buffer: Buffer.from(`
                <svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
                    <rect width="320" height="180" fill="#5b39d6"/>
                    <circle cx="250" cy="90" r="58" fill="#f2b84b"/>
                </svg>
            `)
        });

        await expect(page.getByRole("heading", { name: "Edit Photo" })).toBeVisible();
        await page.getByLabel("Zoom").evaluate((input) => {
            const slider = input as HTMLInputElement;
            slider.value = "1.4";
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            slider.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await page.getByRole("button", { name: "Save Photo" }).click();
        await expect(page.getByText("Profile photo updated.")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("heading", { name: "Edit Photo" })).toBeHidden();
    });

    test("Explore only shows entries whose owner explicitly shares activity @smoke", async ({
        page: ownerPage,
        context: ownerContext,
        browser
    }) => {
        await seedUsers([
            {
                email: "explore-owner@e2e.test",
                name: "Explore Owner",
                categories: [{ name: "Films", entries: ["Arrival"] }]
            },
            { email: "explore-viewer@e2e.test", name: "Explore Viewer" }
        ]);
        await signInViaApi(ownerContext, "explore-owner@e2e.test");
        await gotoApp(ownerPage, "/profile");

        await ownerPage.getByLabel("Public profile").check();
        await ownerPage.getByLabel("Recent additions visibility").selectOption("public");
        await ownerPage.getByRole("button", { name: "Save Profile" }).click();
        await expect(ownerPage.getByText("Profile saved.")).toBeVisible();
        await openSettingsSection(ownerPage, "Shelves");
        await ownerPage.getByLabel("Films visibility").selectOption("public");
        await expect(ownerPage.getByText("Profile sharing saved.").first()).toBeVisible();

        const viewerContext = await browser.newContext();
        const viewerPage = await viewerContext.newPage();
        await signInViaApi(viewerContext, "explore-viewer@e2e.test");
        await gotoApp(viewerPage, "/explore");
        await expect(viewerPage.getByRole("heading", { name: "Explore" })).toBeVisible();
        await expect(viewerPage.getByText("Arrival").first()).toBeVisible();

        await openSettingsSection(ownerPage, "Profile");
        await ownerPage.getByLabel("Recent additions visibility").selectOption("off");
        await ownerPage.getByRole("button", { name: "Save Profile" }).click();
        await expect(ownerPage.getByText("Profile saved.")).toBeVisible();
        await gotoApp(viewerPage, "/explore");
        await expect(viewerPage.getByText("Arrival")).toBeHidden();

        await viewerContext.close();
    });

    test("user can permanently delete their account", async ({ page, context }) => {
        await seedUsers([{
            email: "delete-account@e2e.test",
            name: "Delete Account",
            categories: [{ name: "Movies", entries: ["Arrival"] }]
        }]);
        await signInViaApi(context, "delete-account@e2e.test");
        await gotoApp(page, "/profile");
        await openSettingsSection(page, "Account");

        await page.getByText("Delete account", { exact: true }).click();
        await page.getByLabel("Delete account confirmation").fill("DELETE");
        await Promise.all([
            page.waitForURL(/\/signin$/),
            page.getByRole("button", { name: "Delete Account Permanently" }).click()
        ]);
        await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    });

    test("signed-in viewers can copy a shared category into a new category @smoke", async ({
        page: alicePage,
        context: aliceContext,
        browser
    }) => {
        const aliceWithLongMovieList = {
            ...ALICE,
            categories: [
                { name: "Movies", entries: ["Arrival", "Dune", "Heat", "Solaris"] },
                { name: "Books", entries: ["Hyperion"] }
            ]
        };
        await seedUsers([
            aliceWithLongMovieList,
            { ...BOB, categories: [{ name: "Movies", entries: [] }] }
        ]);
        await signInViaApi(aliceContext, ALICE.email);

        await gotoApp(alicePage);
        const arrivalEntryId = await alicePage
            .locator("[data-entry-id]", { hasText: "#1 Arrival" })
            .getAttribute("data-entry-id");
        expect(arrivalEntryId).toBeTruthy();
        const imageUpload = await alicePage.request.post(
            `${BASE_URL}/api/images/${encodeURIComponent(arrivalEntryId!)}`,
            {
                data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
                headers: { "content-type": "image/jpeg", origin: BASE_URL }
            }
        );
        expect(imageUpload.ok()).toBe(true);
        const sourceImageKey = ((await imageUpload.json()) as { imageKey: string }).imageKey;

        await gotoApp(alicePage, "/profile");
        const aliceSlug = await readOwnSlug(alicePage);
        await alicePage.getByLabel("Public profile").check();
        await alicePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(alicePage.getByText("Profile saved.")).toBeVisible();
        await openSettingsSection(alicePage, "Shelves");
        await alicePage.getByLabel("Movies visibility").selectOption("public");
        await expect(alicePage.getByText("Profile sharing saved.").first()).toBeVisible();

        const bobContext = await browser.newContext();
        const bobPage = await bobContext.newPage();
        await signInViaApi(bobContext, BOB.email);
        await gotoApp(bobPage, `/u/${aliceSlug}`);

        await bobPage.getByRole("button", { name: "Copy List" }).click();
        const dialog = bobPage.getByRole("alertdialog", { name: "Copy Movies" });
        await expect(dialog.getByText("You already have a category with that name.")).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Copy List" })).toBeDisabled();
        await dialog.getByLabel("Category name").fill("Alice Movies");
        await expect(dialog.getByText("4 of 4 selected")).toBeVisible();
        await dialog.getByRole("button", { name: "Deselect all" }).click();
        await expect(dialog.getByText("0 of 4 selected")).toBeVisible();
        await dialog.getByRole("checkbox", { name: "Select Arrival" }).click();
        await dialog.getByRole("checkbox", { name: "Select Heat" }).click({ modifiers: ["Shift"] });
        await expect(dialog.getByText("3 of 4 selected")).toBeVisible();
        await dialog.getByRole("checkbox", { name: "Select Dune" }).click({ modifiers: ["Meta"] });
        await expect(dialog.getByText("2 of 4 selected")).toBeVisible();
        await dialog.getByLabel("Search entries to copy").fill("Sol");
        await dialog.getByRole("button", { name: "Select matches", exact: true }).click();
        await expect(dialog.getByText("3 of 4 selected")).toBeVisible();
        await dialog.getByRole("button", { name: "Copy List" }).click();
        await expect(bobPage.getByText("Copied 3 entries to Alice Movies.")).toBeVisible({ timeout: 15_000 });

        await gotoApp(bobPage);
        await categoryButton(bobPage, "Alice Movies").click();
        await expect(bobPage.getByRole("heading", { name: "Alice Movies" })).toBeVisible();
        await bobPage.getByRole("button", { name: /^Queue/ }).click();
        await expect(queueCount(bobPage, 3)).toBeVisible();
        await expect(bobPage.getByText("Arrival").first()).toBeVisible();
        await expect(bobPage.getByText("Heat").first()).toBeVisible();
        await expect(bobPage.getByText("Solaris").first()).toBeVisible();
        await expect(bobPage.getByText("Dune").first()).toBeHidden();

        const imageRefsResponse = await fetch(
            `${BASE_URL}/api/test/image-refs?email=${encodeURIComponent(BOB.email)}`
        );
        expect(imageRefsResponse.ok).toBe(true);
        const imageRefs = (await imageRefsResponse.json()) as {
            rows: Array<{ kind: string; name: string; image_key: string | null }>;
        };
        expect(imageRefs.rows.find((row) => row.kind === "queue" && row.name === "Arrival")?.image_key)
            .toBe(sourceImageKey);

        await bobContext.close();
    });

    test("signed-in viewers can merge a shared category into an existing category", async ({
        page: alicePage,
        context: aliceContext,
        browser
    }) => {
        const aliceWithLongMovieList = {
            ...ALICE,
            categories: [
                { name: "Movies", entries: ["Arrival", "Dune", "Heat"] },
                { name: "Books", entries: ["Hyperion"] }
            ]
        };
        await seedUsers([
            aliceWithLongMovieList,
            {
                ...BOB,
                categories: [
                    { name: "Watchlist", entries: [] },
                    { name: "Movies", entries: ["Arrival"] }
                ]
            }
        ]);
        await signInViaApi(aliceContext, ALICE.email);

        await gotoApp(alicePage, "/profile");
        const aliceSlug = await readOwnSlug(alicePage);
        await alicePage.getByLabel("Public profile").check();
        await alicePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(alicePage.getByText("Profile saved.")).toBeVisible();
        await openSettingsSection(alicePage, "Shelves");
        await alicePage.getByLabel("Movies visibility").selectOption("public");
        await expect(alicePage.getByText("Profile sharing saved.").first()).toBeVisible();

        const bobContext = await browser.newContext();
        const bobPage = await bobContext.newPage();
        await signInViaApi(bobContext, BOB.email);
        await gotoApp(bobPage, `/u/${aliceSlug}`);

        await bobPage.getByRole("button", { name: "Copy List" }).click();
        const dialog = bobPage.getByRole("alertdialog", { name: "Copy Movies" });
        await dialog.getByRole("button", { name: "Merge" }).click();
        await dialog.getByLabel("Existing category").click();
        await bobPage.getByRole("option", { name: "Movies" }).click();
        await dialog.getByRole("button", { name: "Deselect all" }).click();
        await dialog.getByRole("checkbox", { name: "Select Arrival" }).click();
        await dialog.getByRole("checkbox", { name: "Select Dune" }).click();
        await expect(dialog.getByText("2 of 3 selected")).toBeVisible();
        await dialog.getByRole("button", { name: "Copy List" }).click();
        await expect(bobPage.getByText("Copied 1 entry to Movies. Skipped 1 duplicate.")).toBeVisible({ timeout: 15_000 });

        await gotoApp(bobPage);
        await categoryButton(bobPage, "Movies").click();
        await expect(bobPage.getByRole("heading", { name: "Movies" })).toBeVisible();
        await expect(bobPage.getByText("#1 Arrival")).toBeVisible();
        await openQueueWorkspace(bobPage);
        await expect(queueCount(bobPage, 1)).toBeVisible();
        await expect(bobPage.getByText("Dune").first()).toBeVisible();
        await expect(bobPage.getByText("Arrival").first()).toBeHidden();
        await expect(bobPage.getByText("Heat").first()).toBeHidden();

        await bobContext.close();
    });

    test("signed-in viewers can copy a shared list with more than 200 entries", async ({
        page: sourcePage,
        context: sourceContext,
        browser
    }) => {
        const entries = Array.from({ length: 201 }, (_, index) => `Movie ${String(index).padStart(3, "0")}`);
        await seedUsers([
            { ...ALICE, email: "alice-large-copy@e2e.test", categories: [{ name: "Movies", entries }] },
            { ...BOB, email: "bob-large-copy@e2e.test", categories: [] }
        ]);
        await signInViaApi(sourceContext, "alice-large-copy@e2e.test");
        await gotoApp(sourcePage, "/profile");
        const sourceSlug = await readOwnSlug(sourcePage);
        await sourcePage.getByLabel("Public profile").check();
        await sourcePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(sourcePage.getByText("Profile saved.")).toBeVisible();
        await openSettingsSection(sourcePage, "Shelves");
        await sourcePage.getByLabel("Movies visibility").selectOption("public");
        await expect(sourcePage.getByText("Profile sharing saved.").first()).toBeVisible();

        const viewerContext = await browser.newContext();
        const viewerPage = await viewerContext.newPage();
        await signInViaApi(viewerContext, "bob-large-copy@e2e.test");
        await gotoApp(viewerPage, `/u/${sourceSlug}`);

        await viewerPage.getByRole("button", { name: "Copy List" }).click();
        const dialog = viewerPage.getByRole("alertdialog", { name: "Copy Movies" });
        await dialog.getByLabel("Category name").fill("Large Movie Copy");
        await expect(dialog.getByText("201 of 201 selected")).toBeVisible();
        await dialog.getByRole("button", { name: "Copy List" }).click();
        await expect(viewerPage.getByText("Copied 201 entries to Large Movie Copy.")).toBeVisible({ timeout: 30_000 });

        await gotoApp(viewerPage);
        await openQueueWorkspace(viewerPage);
        await expect(queueCount(viewerPage, 201)).toBeVisible();
        await viewerContext.close();
    });

    test("category creation defaults private and can show a category on the profile @smoke", async ({
        page,
        context
    }) => {
        await seedUsers([{ email: "share@e2e.test", name: "Share Tester" }]);
        await signInViaApi(context, "share@e2e.test");
        await gotoApp(page);

        let categoryDialog = await openNewCategoryDialog(page);
        await categoryDialog.getByPlaceholder("New category").fill("Private Shelf");
        await categoryDialog.getByPlaceholder("New category").press("Enter");
        await expect(page.getByRole("heading", { name: "Private Shelf" })).toBeVisible();

        categoryDialog = await openNewCategoryDialog(page);
        await categoryDialog.getByLabel("Show on profile").check();
        await categoryDialog.getByPlaceholder("New category").fill("Shared Shelf");
        await categoryDialog.getByPlaceholder("New category").press("Enter");
        await expect(page.getByRole("heading", { name: "Shared Shelf" })).toBeVisible();

        await gotoApp(page, "/profile");
        await expect(page.getByText("Public profiles are searchable and visible to anyone.")).toBeVisible();
        await page.getByLabel("Public profile").check();
        await page.getByRole("button", { name: "Save Profile" }).click();
        await expect(page.getByText("Profile saved.")).toBeVisible();
        await openSettingsSection(page, "Shelves");
        await expect(page.getByText("Choose an audience for each shelf.")).toBeVisible();
        await expect(page.getByLabel("Private Shelf visibility")).toHaveValue("private");
        await expect(page.getByLabel("Shared Shelf visibility")).toHaveValue("public");

        await page.getByRole("link", { name: "View Profile" }).click();
        await expect(page.getByRole("heading", { name: "Share Tester" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Shared Shelf" })).toBeVisible();
        await expect(page.getByText("Private Shelf")).toBeHidden();
    });

    test("profile owner can block and unblock a follower", async ({
        page: alicePage,
        context: aliceContext,
        browser
    }) => {
        await seedUsers([ALICE, BOB]);
        await signInViaApi(aliceContext, ALICE.email);

        const bobContext = await browser.newContext();
        const bobPage = await bobContext.newPage();
        await signInViaApi(bobContext, BOB.email);

        await gotoApp(alicePage, "/profile");
        const aliceSlug = await readOwnSlug(alicePage);
        await alicePage.getByLabel("Public profile").check();
        await alicePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(alicePage.getByText("Profile saved.")).toBeVisible();

        await gotoApp(bobPage, `/u/${aliceSlug}`);
        await bobPage.getByRole("button", { name: "Follow", exact: true }).click();
        await expect(bobPage.getByText("Profile followed.")).toBeVisible();

        await gotoApp(alicePage, "/profile");
        await openSettingsSection(alicePage, "Privacy & social");
        await expect(alicePage.getByRole("heading", { name: "Followers" })).toBeVisible();
        await expect(alicePage.getByText("Bob Stone").first()).toBeVisible();
        await alicePage.getByRole("button", { name: "Block", exact: true }).click();
        await expect(alicePage.getByText("Blocked Bob Stone.")).toBeVisible();
        await expect(alicePage.getByText("No Followers")).toBeVisible();
        await expect(alicePage.getByText("Bob Stone").first()).toBeVisible();
        await expect(alicePage.getByRole("button", { name: "Unblock", exact: true })).toBeVisible();

        await gotoApp(bobPage, `/u/${aliceSlug}`);
        await expect(bobPage.getByRole("heading", { name: "Profile Not Found" })).toBeVisible();
        await expect(bobPage.getByText("This profile is private or does not exist.")).toBeVisible();

        await gotoApp(alicePage, "/profile");
        await openSettingsSection(alicePage, "Privacy & social");
        await alicePage.getByRole("button", { name: "Unblock", exact: true }).click();
        await expect(alicePage.getByText("Unblocked Bob Stone.")).toBeVisible();
        await expect(alicePage.getByText("No Blocked Profiles")).toBeVisible();

        await gotoApp(bobPage, `/u/${aliceSlug}`);
        await bobPage.getByRole("button", { name: "Follow", exact: true }).click();
        await expect(bobPage.getByText("Profile followed.")).toBeVisible();

        await bobContext.close();
    });

    test("public profile shows row percentiles and keeps visibility badges readable", async ({
        page: ownerPage,
        context: ownerContext,
        browser
    }) => {
        const longCategoryName = "Movies With An Absurdly Long Category Name That Should Truncate Before The Badge";
        await seedUsers([
            {
                email: "visibility-owner@e2e.test",
                name: "Visibility Owner",
                categories: [
                    { name: longCategoryName, entries: ["Arrival", "Dune", "Heat", "Solaris"] },
                    { name: "Private Notes", entries: ["Hidden One"] }
                ]
            },
            { email: "visibility-admin@e2e.test", name: "Visibility Admin", role: "admin" }
        ]);
        await signInViaApi(ownerContext, "visibility-owner@e2e.test");

        await gotoApp(ownerPage, "/profile");
        const ownerSlug = await readOwnSlug(ownerPage);
        await ownerPage.getByLabel("Public profile").check();
        await ownerPage.getByRole("button", { name: "Save Profile" }).click();
        await expect(ownerPage.getByText("Profile saved.")).toBeVisible();
        await openSettingsSection(ownerPage, "Shelves");
        await ownerPage.getByLabel(`${longCategoryName} visibility`).selectOption("public");
        await expect(ownerPage.getByText("Profile sharing saved.").first()).toBeVisible();

        const adminContext = await browser.newContext();
        const adminPage = await adminContext.newPage();
        await signInViaApi(adminContext, "visibility-admin@e2e.test");
        await gotoApp(adminPage, `/u/${ownerSlug}`);

        await expect(adminPage.getByRole("heading", { name: "Visibility Owner" })).toBeVisible();
        await expect(adminPage.getByText("#1").first()).toBeVisible();
        await expect(adminPage.getByText("100th").first()).toBeVisible();
        await expect(adminPage.getByText("75th").first()).toBeVisible();

        const categoryNav = adminPage.getByRole("navigation", { name: "Shared shelves" });
        const longCategoryButton = categoryNav.getByRole("button", { name: new RegExp(longCategoryName) });
        await expect(longCategoryButton).toBeVisible();
        await expect(categoryNav.getByRole("button", { name: /Private Notes/ })).toBeHidden();
        await expect(categoryNav.getByText("Private", { exact: true })).toBeHidden();

        await expect(adminPage.getByRole("button", { name: /Admin: View Private Lists/ })).toBeHidden();

        const layout = await longCategoryButton.evaluate((button) => {
            const badge = button.querySelector(
                '[title="Visible to anyone who can open this public profile"]'
            ) as HTMLElement | null;
            const buttonBox = button.getBoundingClientRect();
            const badgeBox = badge?.getBoundingClientRect();
            return {
                badgeFound: Boolean(badgeBox),
                badgeLeft: badgeBox?.left ?? 0,
                badgeRight: badgeBox?.right ?? 0,
                buttonLeft: buttonBox.left,
                buttonRight: buttonBox.right,
                buttonWidth: buttonBox.width
            };
        });
        expect(layout.badgeFound).toBe(true);
        expect(layout.badgeLeft).toBeGreaterThanOrEqual(layout.buttonLeft - 1);
        expect(layout.badgeRight).toBeLessThanOrEqual(layout.buttonRight + 1);
        expect(layout.buttonWidth).toBeLessThanOrEqual(340);

        await adminContext.close();
    });

    test("publish profile, share rankings, full follow round-trip, revoke access", async ({
        page: alicePage,
        context: aliceContext,
        browser
    }) => {
        test.setTimeout(120_000);
        await seedUsers([ALICE, BOB, CHARLIE]);
        await signInViaApi(aliceContext, ALICE.email);

        const bobContext = await browser.newContext();
        const bobPage = await bobContext.newPage();
        await signInViaApi(bobContext, BOB.email);

        const charlieContext = await browser.newContext();
        const charliePage = await charlieContext.newPage();
        await signInViaApi(charlieContext, CHARLIE.email);

        const anonContext = await browser.newContext();
        const anonPage = await anonContext.newPage();

        await gotoApp(charliePage, "/profile");
        const charlieSlug = await readOwnSlug(charliePage);
        await charliePage.getByLabel("Public profile").check();
        await charliePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(charliePage.getByText("Profile saved.")).toBeVisible();

        // --- Alice publishes her profile and her Movies ranking. ---
        await gotoApp(alicePage, "/profile");
        const aliceSlug = await readOwnSlug(alicePage);
        await expect(alicePage.getByRole("button", { name: "Copy Link" })).toBeDisabled();

        await alicePage.getByLabel("Public profile").check();
        await alicePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(alicePage.getByText("Profile saved.")).toBeVisible();
        await expect(alicePage.getByRole("button", { name: "Copy Link" })).toBeEnabled();

        // The visibility checkbox is controlled and only flips after the save
        // round-trip, so click + poll instead of check() (which verifies
        // state synchronously).
        await openSettingsSection(alicePage, "Shelves");
        await alicePage.getByLabel("Movies visibility").selectOption("public");
        await expect(alicePage.getByText("Profile sharing saved.").first()).toBeVisible();
        await expect(alicePage.getByLabel("Movies visibility")).toHaveValue("public");

        // --- Her own public page shows only the public category. ---
        await alicePage.getByRole("link", { name: "View Profile" }).click();
        await expect(alicePage).toHaveURL(`/u/${aliceSlug}`);
        await expect(alicePage.getByRole("heading", { name: "Alice Park" })).toBeVisible();
        await expect(alicePage.getByText("Public Profile", { exact: true }).first()).toBeVisible();
        await expect(alicePage.getByRole("link", { name: "Edit Profile" })).toBeVisible();
        await expect(alicePage.getByText("Arrival")).toBeVisible();
        await expect(alicePage.getByText("Dune")).toBeVisible();
        await expect(alicePage.getByText("Hyperion")).toBeHidden();

        // --- Signed-out visitors see the public page; private/unknown slugs 404. ---
        await gotoApp(anonPage, `/u/${aliceSlug}`);
        await expect(anonPage.getByRole("heading", { name: "Alice Park" })).toBeVisible();
        await expect(anonPage.getByText("Arrival")).toBeVisible();
        await expect(anonPage.getByText("Hyperion")).toBeHidden();
        // Both the topbar and the header action link to sign-in.
        await expect(anonPage.getByRole("link", { name: "Sign In" }).first()).toBeVisible();

        await gotoApp(anonPage, "/u/does-not-exist");
        await expect(anonPage.getByRole("heading", { name: "Profile Not Found" })).toBeVisible();

        // Bob's profile is still private.
        await gotoApp(bobPage, "/profile");
        const bobSlug = await readOwnSlug(bobPage);
        await gotoApp(anonPage, `/u/${bobSlug}`);
        await expect(anonPage.getByRole("heading", { name: "Profile Not Found" })).toBeVisible();

        // --- Bob follows Alice's public profile directly. ---
        await gotoApp(bobPage, `/u/${aliceSlug}`);
        await bobPage.getByRole("button", { name: "Follow", exact: true }).click();
        await expect(bobPage.getByText("Profile followed.")).toBeVisible();
        await expect(bobPage.getByRole("button", { name: "Following" })).toBeVisible();
        await gotoApp(bobPage, `/u/${charlieSlug}`);
        await bobPage.getByRole("button", { name: "Follow", exact: true }).click();
        await expect(bobPage.getByText("Profile followed.")).toBeVisible();

        // Discovery is now a separate, privacy-filtered Explore workspace;
        // profile settings no longer perform a suggestion query on load.
        await gotoApp(alicePage, "/explore");
        await expect(alicePage.getByRole("heading", { name: "Explore" })).toBeVisible();

        // --- Alice requests to follow Bob's private profile by exact handle. ---
        await gotoApp(alicePage, "/profile");
        await openSettingsSection(alicePage, "Privacy & social");
        await alicePage.getByLabel("Profile handle, name, or profile link").fill(bobSlug);
        await alicePage.getByLabel("Profile handle, name, or profile link")
            .locator("xpath=ancestor::form")
            .getByRole("button", { name: "Follow", exact: true })
            .click();
        await expect(alicePage.getByText("Follow request sent.")).toBeVisible();
        // Bob can appear in both Followers and Sent Requests.
        await expect(alicePage.getByText("Bob Stone").first()).toBeVisible();
        await expect(alicePage.getByText("Requested").first()).toBeVisible();
        await expect(alicePage.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

        // --- Bob approves; the relationship becomes mutual on both sides. ---
        await gotoApp(bobPage, "/profile");
        await openSettingsSection(bobPage, "Privacy & social");
        await expect(bobPage.getByText("Alice Park").first()).toBeVisible();
        await bobPage.getByRole("button", { name: "Accept", exact: true }).click();
        await expect(bobPage.getByText("Follow request accepted.")).toBeVisible();
        await expect(bobPage.getByText("Mutual").first()).toBeVisible();

        await gotoApp(alicePage, "/profile");
        await openSettingsSection(alicePage, "Privacy & social");
        await expect(alicePage.getByText("Bob Stone").first()).toBeVisible();
        await expect(alicePage.getByText("Mutual").first()).toBeVisible();

        // --- Hiding the category removes it from the public page. ---
        await openSettingsSection(alicePage, "Shelves");
        await alicePage.getByLabel("Movies visibility").selectOption("private");
        await expect(alicePage.getByText("Profile sharing saved.").first()).toBeVisible();
        await expect(alicePage.getByLabel("Movies visibility")).toHaveValue("private");

        await gotoApp(anonPage, `/u/${aliceSlug}`);
        await expect(anonPage.getByRole("heading", { name: "Alice Park" })).toBeVisible();
        await expect(anonPage.getByText("No shared shelves")).toBeVisible();
        await expect(anonPage.getByText("Arrival")).toBeHidden();

        // --- Going private hides the page from visitors but not followers. ---
        await openSettingsSection(alicePage, "Profile");
        alicePage.once("dialog", (dialog) => dialog.accept());
        await alicePage.getByLabel("Public profile").uncheck();
        await alicePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(alicePage.getByText("Profile saved.")).toBeVisible();

        await gotoApp(anonPage, `/u/${aliceSlug}`);
        await expect(anonPage.getByRole("heading", { name: "Profile Not Found" })).toBeVisible();

        // Switching to private revokes public-era follows; Bob must request
        // access again rather than retaining the prior auto-approved edge.
        await gotoApp(bobPage, `/u/${aliceSlug}`);
        await expect(bobPage.getByRole("heading", { name: "Profile Not Found" })).toBeVisible();

        await bobContext.close();
        await anonContext.close();
    });
});
