# Testing Strategy

Goldshelf uses Vitest for cheap behavioral coverage and Playwright for browser-level workflow coverage. The goal is to keep deploy checks fast and deterministic while preserving a full regression suite for larger changes.

## Commands

```sh
pnpm test              # Vitest unit/server/logic tests
pnpm typecheck         # route generation + TypeScript checks
pnpm test:e2e:smoke   # deploy-critical browser tests
pnpm test:e2e:full    # complete browser suite
make check             # deploy gate: unit + typecheck + smoke e2e + audit + build
make check-full        # full local gate including every Playwright test
```

## What Goes Where

Prefer Vitest for deterministic logic and server behavior:

- ranking, repair, queue, duplicate, import/export, and privacy rules
- database read/write behavior that can be exercised without a browser
- parsing, formatting, normalization, and validation
- edge cases with many rows or unusual ordering

Use Playwright only when the browser is the thing being tested:

- auth and navigation flows
- core dashboard workflows
- menus, dialogs, uploads, drag/tap/mobile behavior
- real user-facing integration between UI and server functions
- one representative happy path per large feature

## Smoke Tests

A Playwright test should be tagged `@smoke` only if a deploy should be blocked when that exact workflow fails. Keep smoke coverage small and broad rather than exhaustive. Current smoke coverage intentionally checks auth, admin denial, mobile dashboard access, basic category/entry/ranking, queue defaults, profile copy, and profile sharing.

Do not tag a test `@smoke` just because the feature is important. If the same behavior is already covered by Vitest or another smoke path, leave detailed regressions in the full suite.

## Determinism Rules

- Do not use `page.waitForTimeout()` for synchronization. Wait for visible UI, a server-function response, or a polled condition.
- Use `gotoApp()` before interacting with app UI so hydration is complete.
- Use shared helpers such as `rankedEntry()`, `expectRankedEntries()`, `chooseEntryMenuAction()`, and `chooseCategoryMenuAction()` instead of repeating fragile entry/menu locators.
- Use `serverFnResponse()` or `waitForServerFnResponse()` when a quiet server round trip matters.
- Use `triggerResumeDashboardRefresh()` for synthetic restored-tab tests; do not hand-dispatch `pageshow` and immediately assert UI.
- Use `abortNextServerFn()` for transient network tests so request failure setup stays consistent.
- Seed the database close to the state being tested instead of replaying a long setup flow.
- Keep tests focused; avoid lifecycle tests that verify many unrelated behaviors unless the lifecycle itself is the contract.

## Adding New Coverage

When adding a feature, start with Vitest for the rules and edge cases. Add one targeted Playwright path only if the UI wiring or browser behavior is meaningful. If a bug was caused by flaky test synchronization rather than app behavior, fix or add a helper in `e2e/helpers.ts` before adding another copy of the pattern.
