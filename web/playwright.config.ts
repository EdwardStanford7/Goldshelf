import { defineConfig } from "@playwright/test";
import { BASE_URL } from "./e2e/constants";

const isRemote = Boolean(process.env.PLAYWRIGHT_BASE_URL);
const reuseLocalServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1";

export default defineConfig({
    testDir: "./e2e",
    testMatch: "**/*.spec.ts",
    timeout: 60_000,
    retries: isRemote ? 1 : 0,
    // Single worker: every test resets the shared e2e database.
    workers: 1,
    use: {
        baseURL: BASE_URL,
        headless: true,
        screenshot: "only-on-failure",
        trace: "retain-on-failure"
    },
    projects: [
        {
            name: "chromium",
            use: { browserName: "chromium" }
        }
    ],
    ...(!isRemote && {
        webServer: {
            command: "pnpm test:dev",
            url: `${BASE_URL}/api/test/health`,
            reuseExistingServer: reuseLocalServer,
            timeout: 120_000
        }
    })
});
