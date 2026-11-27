import { test, expect } from "./base";

test("unchanged slotted control refs stay attached across parent renders", async ({ page }) => {
    test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), "Uses a local Vite regression harness");
    await page.goto("/signin");
    const measurements = await page.evaluate(async () => {
        const harnessPath = "/e2e/fixtures/slotRefs.tsx";
        const harness = await import(/* @vite-ignore */ harnessPath);
        return harness.measureSlotRefs();
    });
    expect(measurements).toEqual({ attachments: 1, detachments: 0 });
});

test("closed selects keep option text refs attached across parent renders", async ({ page }) => {
    test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), "Uses a local Vite regression harness");
    await page.goto("/signin");
    const measurements = await page.evaluate(async () => {
        const harnessPath = "/e2e/fixtures/slotRefs.tsx";
        const harness = await import(/* @vite-ignore */ harnessPath);
        return harness.measureSelectRefs();
    });
    expect(measurements).toEqual({ attachments: 1, detachments: 0 });
});
