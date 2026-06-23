import type { Page } from "@playwright/test";
import { test, expect } from "./base";
import { gotoApp, seedUsers, signInViaApi } from "./helpers";

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

/** Reads the @handle shown in the profile settings header. */
async function readOwnSlug(page: Page) {
    const handleText = await page.getByText(/^@[a-z0-9-]+$/).first().textContent();
    expect(handleText, "profile handle should be visible on /profile").toBeTruthy();
    return handleText!.slice(1);
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

    test("signed-in viewers can copy a shared category into a new category", async ({
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

        await gotoApp(alicePage, "/profile");
        const aliceSlug = await readOwnSlug(alicePage);
        await alicePage.getByLabel("Public profile").check();
        await alicePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(alicePage.getByText("Profile saved.")).toBeVisible();
        await alicePage.getByRole("checkbox", { name: /Movies/ }).click();
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
        await dialog.getByRole("button", { name: "Deselect visible" }).click();
        await expect(dialog.getByText("0 of 4 selected")).toBeVisible();
        await dialog.getByRole("checkbox", { name: "Select Arrival" }).click();
        await dialog.getByRole("checkbox", { name: "Select Heat" }).click({ modifiers: ["Shift"] });
        await expect(dialog.getByText("3 of 4 selected")).toBeVisible();
        await dialog.getByRole("checkbox", { name: "Select Dune" }).click({ modifiers: ["Meta"] });
        await expect(dialog.getByText("2 of 4 selected")).toBeVisible();
        await dialog.getByLabel("Search entries to copy").fill("Sol");
        await dialog.getByRole("button", { name: "Select visible", exact: true }).click();
        await expect(dialog.getByText("3 of 4 selected")).toBeVisible();
        await dialog.getByRole("button", { name: "Copy List" }).click();
        await expect(bobPage.getByText("Copied 3 entries to Alice Movies.")).toBeVisible({ timeout: 15_000 });

        await gotoApp(bobPage);
        await bobPage.getByRole("button", { name: "Alice Movies" }).click();
        await expect(bobPage.getByRole("heading", { name: "Alice Movies" })).toBeVisible();
        await expect(bobPage.getByText("3 queued")).toBeVisible();
        await expect(bobPage.getByText("3 ready")).toBeVisible();
        await expect(bobPage.getByText("Arrival").first()).toBeVisible();
        await expect(bobPage.getByText("Heat").first()).toBeVisible();
        await expect(bobPage.getByText("Solaris").first()).toBeVisible();
        await expect(bobPage.getByText("Dune").first()).toBeHidden();

        await bobContext.close();
    });

    test("signed-in viewers can merge a shared category into an existing category", async ({
        page: alicePage,
        context: aliceContext,
        browser
    }) => {
        await seedUsers([
            ALICE,
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
        await alicePage.getByRole("checkbox", { name: /Movies/ }).click();
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
        await dialog.getByRole("button", { name: "Copy List" }).click();
        await expect(bobPage.getByText("Copied 1 entry to Movies. Skipped 1 duplicate.")).toBeVisible({ timeout: 15_000 });

        await gotoApp(bobPage);
        await bobPage.getByRole("button", { name: "Movies" }).click();
        await expect(bobPage.getByRole("heading", { name: "Movies" })).toBeVisible();
        await expect(bobPage.getByText("#1 Arrival")).toBeVisible();
        await expect(bobPage.getByText("1 queued")).toBeVisible();
        await expect(bobPage.getByText("Arrival").first()).toBeVisible();
        await expect(bobPage.getByText("Dune").first()).toBeVisible();

        await bobContext.close();
    });

    test("category creation defaults private and can show a category on the profile", async ({
        page,
        context
    }) => {
        await seedUsers([{ email: "share@e2e.test", name: "Share Tester" }]);
        await signInViaApi(context, "share@e2e.test");
        await gotoApp(page);

        await page.getByPlaceholder("New category").fill("Private Shelf");
        await page.getByPlaceholder("New category").press("Enter");
        await expect(page.getByRole("heading", { name: "Private Shelf" })).toBeVisible();

        await page.getByLabel("Show on profile").check();
        await page.getByPlaceholder("New category").fill("Shared Shelf");
        await page.getByPlaceholder("New category").press("Enter");
        await expect(page.getByRole("heading", { name: "Shared Shelf" })).toBeVisible();

        await gotoApp(page, "/profile");
        await page.getByLabel("Public profile").check();
        await page.getByRole("button", { name: "Save Profile" }).click();
        await expect(page.getByText("Profile saved.")).toBeVisible();
        await expect(page.getByRole("checkbox", { name: /Private Shelf/ })).not.toBeChecked();
        await expect(page.getByRole("checkbox", { name: /Shared Shelf/ })).toBeChecked();

        await page.getByRole("link", { name: "View Profile" }).click();
        await expect(page.getByRole("heading", { name: "Share Tester" })).toBeVisible();
        await expect(page.getByText("Shared Shelf")).toBeVisible();
        await expect(page.getByText("Private Shelf")).toBeHidden();
    });

    test("publish profile, share rankings, full follow round-trip, revoke access", async ({
        page: alicePage,
        context: aliceContext,
        browser
    }) => {
        test.setTimeout(120_000);
        await seedUsers([ALICE, BOB]);
        await signInViaApi(aliceContext, ALICE.email);

        const bobContext = await browser.newContext();
        const bobPage = await bobContext.newPage();
        await signInViaApi(bobContext, BOB.email);

        const anonContext = await browser.newContext();
        const anonPage = await anonContext.newPage();

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
        await alicePage.getByRole("checkbox", { name: /Movies/ }).click();
        await expect(alicePage.getByText("Profile sharing saved.").first()).toBeVisible();
        await expect(alicePage.getByRole("checkbox", { name: /Movies/ })).toBeChecked();

        // --- Her own public page shows only the public category. ---
        await alicePage.getByRole("link", { name: "View Profile" }).click();
        await expect(alicePage).toHaveURL(`/u/${aliceSlug}`);
        await expect(alicePage.getByRole("heading", { name: "Alice Park" })).toBeVisible();
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

        // --- Alice requests to follow Bob's private profile by exact handle. ---
        await gotoApp(alicePage, "/profile");
        await alicePage.getByLabel("Profile handle, name, or profile link").fill(bobSlug);
        // Bob's follower row also offers a follow-back "Follow" button; the
        // Find Profiles submit comes first in the page.
        await alicePage.getByRole("button", { name: "Follow", exact: true }).first().click();
        await expect(alicePage.getByText("Follow request sent.")).toBeVisible();
        // Bob can appear in both Followers and Sent Requests.
        await expect(alicePage.getByText("Bob Stone").first()).toBeVisible();
        await expect(alicePage.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

        // --- Bob approves; the relationship becomes mutual on both sides. ---
        await gotoApp(bobPage, "/profile");
        await expect(bobPage.getByText("Alice Park").first()).toBeVisible();
        await bobPage.getByRole("button", { name: "Accept", exact: true }).click();
        await expect(bobPage.getByText("Follow request accepted.")).toBeVisible();
        await expect(bobPage.getByText("Mutual").first()).toBeVisible();

        await gotoApp(alicePage, "/profile");
        await expect(alicePage.getByText("Bob Stone").first()).toBeVisible();
        await expect(alicePage.getByText("Mutual").first()).toBeVisible();

        // --- Hiding the category removes it from the public page. ---
        await alicePage.getByRole("checkbox", { name: /Movies/ }).click();
        await expect(alicePage.getByText("Profile sharing saved.").first()).toBeVisible();
        await expect(alicePage.getByRole("checkbox", { name: /Movies/ })).not.toBeChecked();

        await gotoApp(anonPage, `/u/${aliceSlug}`);
        await expect(anonPage.getByRole("heading", { name: "Alice Park" })).toBeVisible();
        await expect(anonPage.getByText("No Shared Rankings")).toBeVisible();
        await expect(anonPage.getByText("Arrival")).toBeHidden();

        // --- Going private hides the page from visitors but not followers. ---
        await alicePage.getByLabel("Public profile").uncheck();
        await alicePage.getByRole("button", { name: "Save Profile" }).click();
        await expect(alicePage.getByText("Profile saved.")).toBeVisible();

        await gotoApp(anonPage, `/u/${aliceSlug}`);
        await expect(anonPage.getByRole("heading", { name: "Profile Not Found" })).toBeVisible();

        await gotoApp(bobPage, `/u/${aliceSlug}`);
        await expect(bobPage.getByRole("heading", { name: "Alice Park" })).toBeVisible();

        // --- Unfollowing revokes Bob's access to the private profile. ---
        await bobPage.getByRole("button", { name: "Mutual" }).click();
        await expect(bobPage.getByText("Profile unfollowed.")).toBeVisible();

        await gotoApp(bobPage, `/u/${aliceSlug}`);
        await expect(bobPage.getByRole("heading", { name: "Profile Not Found" })).toBeVisible();

        await bobContext.close();
        await anonContext.close();
    });
});
