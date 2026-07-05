import { expect } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { BASE_URL } from "./constants";

export const TEST_PASSWORD = "goldshelf-e2e-password";

/**
 * Navigates and waits for React hydration (marked on <html> by the root
 * route) so clicks are never swallowed by not-yet-attached handlers.
 */
export async function gotoApp(page: Page, path = "/") {
    await page.goto(path);
    await page.waitForSelector("html[data-hydrated]", { timeout: 15_000 });
}

/** Opens the account menu and waits for its content to be usable. */
export async function openAccountMenu(page: Page): Promise<Locator> {
    const accountButton = page.getByRole("button", { name: "Account menu" });
    const openMenu = page
        .locator("[data-slot='dropdown-menu-content'][data-state='open']", { hasText: "Sign Out" })
        .last();
    const signOutItem = openMenu.getByRole("menuitem", { name: "Sign Out", exact: true });
    if (await signOutItem.isVisible().catch(() => false)) {
        await waitForStableLocator(openMenu);
        return openMenu;
    }

    await page
        .locator("[data-slot='dropdown-menu-content'][data-state='closed']")
        .waitFor({ state: "detached", timeout: 1_000 })
        .catch(() => undefined);

    for (let attempt = 0; attempt < 5; attempt += 1) {
        await accountButton.click();
        if (await signOutItem.waitFor({ state: "visible", timeout: 1_000 }).then(() => true).catch(() => false)) {
            await waitForStableLocator(openMenu);
            return openMenu;
        }
    }

    await expect(signOutItem).toBeVisible();
    await waitForStableLocator(openMenu);
    return openMenu;
}

async function waitForStableLocator(locator: Locator) {
    let previousBox: string | null = null;

    await expect.poll(async () => {
        const box = await locator.boundingBox();
        if (!box) {
            previousBox = null;
            return "missing";
        }

        const currentBox = [
            box.x.toFixed(2),
            box.y.toFixed(2),
            box.width.toFixed(2),
            box.height.toFixed(2)
        ].join(":");
        const isStable = previousBox === currentBox;
        previousBox = currentBox;
        return isStable ? "stable" : "moving";
    }, {
        intervals: [50, 50, 50, 100],
        timeout: 2_000
    }).toBe("stable");
}

export interface SeedEntry {
    name: string;
    imageKey?: string | null;
}

export interface SeedCategory {
    name: string;
    entries?: Array<SeedEntry | string>;
}

export interface SeedUser {
    email: string;
    password?: string;
    name: string;
    role?: string;
    direct?: boolean;
    queueSettings?: {
        enabled?: boolean;
        delayDays?: number;
        promptForMissingImages?: boolean;
        randomizeReadyEntries?: boolean;
    };
    categories?: SeedCategory[];
    queuedEntries?: Array<{
        categoryName: string;
        name: string;
        imageKey?: string | null;
        availableAt?: number;
        createdAt?: number;
    }>;
}

export async function seedUsers(users: SeedUser[]) {
    const response = await fetch(`${BASE_URL}/api/test/seed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            users: users.map((user) => ({ password: TEST_PASSWORD, ...user }))
        })
    });

    if (!response.ok) {
        throw new Error(`Seed failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as { users: Array<{ id: string; email: string }> };
    return body.users;
}

export async function getAdminAuditRows(filters: { targetUserId?: string; action?: string }) {
    const params = new URLSearchParams();
    if (filters.targetUserId) {
        params.set("targetUserId", filters.targetUserId);
    }
    if (filters.action) {
        params.set("action", filters.action);
    }

    const response = await fetch(`${BASE_URL}/api/test/admin-audit?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`Audit fetch failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as {
        rows: Array<{
            id: string;
            actor_user_id: string | null;
            actor_label: string;
            target_user_id: string;
            action: string;
            reason: string | null;
            metadata_json: string;
            created_at: number;
        }>;
    };
    return body.rows;
}

/**
 * Signs in through the real better-auth endpoint using the browser context's
 * request client, so the session cookies land directly in the context.
 */
export async function signInViaApi(
    context: BrowserContext,
    email: string,
    password: string = TEST_PASSWORD
) {
    const response = await context.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
        data: { email, password },
        // better-auth rejects requests without an Origin header.
        headers: { origin: BASE_URL }
    });

    if (!response.ok()) {
        throw new Error(`Sign in failed for ${email}: ${response.status()} ${await response.text()}`);
    }
}

/**
 * Plays out an active ranking session by always picking `winnerName` in every
 * matchup, so it must finish at #1. Covers the binary search and local repair
 * phases, and returns once the session no longer offers that choice — which
 * also makes it safe for chained sessions (queue ranking) where the next
 * session's matchups use different entry names.
 *
 * Entry names in a test must not be prefixes of each other.
 */
export async function winMatchups(page: Page, winnerName: string, maxRounds = 15) {
    const escapedWinnerName = winnerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const choice = page.getByRole("button", { name: new RegExp(`^${escapedWinnerName}\\b`) });

    for (let round = 0; round < maxRounds; round += 1) {
        try {
            // Auto-waits while the previous round's submission is in flight.
            await choice.click({ timeout: 2_000 });
        } catch {
            // The button is gone, so the session must have completed; anything
            // else (still visible but stuck) should fail loudly.
            await expect(choice).toBeHidden();
            return;
        }
    }

    throw new Error(`Ranking session still offered ${winnerName} after ${maxRounds} matchups`);
}

export function serverFnExportName(url: string) {
    const match = url.match(/_serverFn\/([A-Za-z0-9_-]+)/);
    if (!match) {
        return null;
    }

    try {
        const meta = JSON.parse(Buffer.from(match[1], "base64url").toString()) as { export?: string };
        return meta.export ?? null;
    } catch {
        return null;
    }
}

export function isServerFnRequest(url: string, exportName: string) {
    return serverFnExportName(url)?.startsWith(exportName) ?? false;
}

/**
 * Resolves when a TanStack Start server function response arrives. Server fn
 * URLs encode `{file, export}` as base64url after `/_serverFn/`, so match on
 * the decoded export name (e.g. "updateQueueSettings").
 *
 * Useful for settings saved quietly in the background: optimistic UI updates
 * (a checked checkbox) don't guarantee the save + dashboard refresh round-trip
 * has landed, and Playwright can outrun it.
 */
export function serverFnResponse(page: Page, exportName: string) {
    return page.waitForResponse((response) => {
        return isServerFnRequest(response.url(), exportName);
    });
}

/** Polls for an auth URL captured server-side in TEST_MODE (e.g. password reset links). */
export async function getAuthUrl(email: string, type: "reset-password") {
    for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(
            `${BASE_URL}/api/test/auth-url?email=${encodeURIComponent(email)}&type=${type}`
        );
        if (response.ok) {
            const body = (await response.json()) as { url: string };
            return body.url;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`No ${type} URL captured for ${email}`);
}
