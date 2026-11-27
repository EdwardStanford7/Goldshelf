# goldshelf Web

TanStack Start + Cloudflare Workers port of the Rust media ranking app.

## Implemented

- Better Auth email/password authentication.
- Cloudflare D1 schema for categories, entries, ranking sessions, queue state, and user settings.
- Cloudflare R2 image binding with stable entry-id image keys.
- Binary-search entry placement with local repair checks.
- Entry rename, delete, rerank, and switch-category flows.
- Legacy xlsx import with an optional default added date.
- Imported entries start without images. Images can be picked later from an 18-result search popup or uploaded manually.
- Ranking comparisons prompt for one missing image at a time instead of fetching images during import.
- Optional entry queue for holding new entries before binary ranking.
- xlsx export with the legacy `Sorted` sheet and entry metadata.

## Local Setup

This folder expects Node.js and pnpm.

```sh
cd web
# if you dont have pnpm, install it
npm i -g pnpm

pnpm install
cp .env.example .env
pnpm db:migrate:local
pnpm dev
```

Create Cloudflare D1/R2 resources before remote deploy, then replace the placeholder `database_id` in `wrangler.jsonc`. The app now deploys to `https://goldshelf.net`, but the existing D1 database and R2 bucket intentionally keep their `media-rating` names to avoid data migration risk.

## Auth

The app uses email/password auth only. Account creation is open on the sign-in page and protected by Better Auth password hashing and rate limits.

Password reset uses Better Auth reset tokens and sends email through Resend.

External setup:

1. In Cloudflare, confirm `goldshelf.net` is an active zone.
2. In Resend, add `send.goldshelf.net` as a sending domain.
3. Use Resend's Cloudflare automatic setup, or manually add the MX/SPF/DKIM DNS records Resend gives you.
4. Keep DNS records DNS-only where Resend specifies.
5. Create a Resend API key after the domain verifies.

After the Worker rename to `goldshelf`, re-upload Worker-scoped secrets:

```sh
make cf-secret-auth
make cf-secret-password-reset
```

Set `RESEND_API_KEY` to the API key and `PASSWORD_RESET_FROM_EMAIL` to:

```text
goldshelf <reset@send.goldshelf.net>
```

If those values are missing, password resets fail closed. Local browser tests use `TEST_MODE` to capture reset links without sending email; production never writes reset tokens to logs.

For one-off admin recovery before email sending is configured, generate a reset link directly from D1:

```sh
make password-reset-link EMAIL=user@example.com
```

Passwords are stored as hashes in the `account` table, so they cannot be viewed or recovered manually.

If testing sign-in repeatedly triggers a temporary auth lockout, clear only the auth rate-limit rows:

```sh
make auth-clear-rate-limits
```

This does not delete users, passwords, sessions, or app data.

## Cloudflare Domain

`wrangler.jsonc` is configured for:

- Worker name: `goldshelf`
- Primary URL: `https://goldshelf.net`
- Custom domain route: `goldshelf.net`
- `workers_dev: false`
- `preview_urls: false`

Before deploying, make sure there is no conflicting DNS record for the apex `goldshelf.net`. Add a Cloudflare redirect rule from `www.goldshelf.net/*` to `https://goldshelf.net/$1`, unless you decide to serve the app from `www` too.

## Verification

See [docs/testing.md](docs/testing.md) for the smoke/full browser-test split and Playwright determinism rules.

```sh
pnpm typecheck
pnpm test
pnpm test:e2e:smoke
pnpm test:e2e:full
pnpm build
```

## Make Targets

The `Makefile` wraps the common local and deploy commands. `make check` runs the faster smoke browser suite used by deploy; use `make check-full` before larger releases or when you want every Playwright test:

```sh
make check
make check-full
make e2e-smoke
make e2e-full
make migrate-local
make deploy-first
make deploy
make cf-secret-password-reset
make password-reset-link EMAIL=user@example.com
```

`make deploy-first` is only for one-time Cloudflare bootstrap on a new project or recreated resources. `wrangler.jsonc` is already pointed at `https://goldshelf.net`; after a Worker rename or intentional secret rotation, re-run `make cf-secret-auth` because Worker secrets are scoped to the Worker name. Use `make bootstrap-help` to see the rare setup targets. Both `make deploy` and `pnpm deploy` now run the smoke checks and remote migrations before deployment.

For normal releases, `make deploy` is the only operational command you need. It runs the verification gate, applies remote D1 migrations, and deploys the Worker.

## Concurrency and cached data

Authenticated server functions use a request-scoped database revision through `authMiddleware` and `getDb()`. Writes check that revision inside their D1 batch before changing data, then advance it once. A request calculated from stale reads fails with a refresh message. Use `versionedImageHandlers` for authenticated image mutations; avoid raw `env.DB` writes in user-facing handlers because those bypass the revision check.

Ranking and repair answers also carry a matchup token. Undo snapshots are staged with `stageMutation` and committed in the same batch as the answer. Restoring an obsolete snapshot is rejected; restoration of entries, session and operation lock is atomic. Keep those statements together when extending ranking flows.

Shelf entry revisions are maintained by database triggers. The home loader supplies metadata; the browser restores matching entries from IndexedDB or uses the focused category loader. Local snapshots are per account, expire after seven days, and are invalidated across tabs on sign-out/session loss. They are a read cache; edits require the server.

Shelf active-entry counts are stored alongside the revision. Entry triggers mark a shelf dirty when membership changes in a versioned transaction; deleting the mutation guard recounts each dirty shelf once before committing. Rank-only changes do not recount, and unscoped maintenance applies count deltas directly. Keeping the flush in a database trigger also supports the previous Worker while migrations run before deployment. Initial home/settings loads read these counts without scanning the library. Public profiles fetch only the first visible shelf, then authorize and load other shelves on selection.

Ranking/repair answer responses include their next comparison. Normal binary steps locate the next pivot through the rank index. Avoid adding an unconditional follow-up session GET to those paths. Scheduled maintenance clears obsolete closed-session Undo and operation payloads in bounded batches, preserving a completed session's still-valid Undo and the small records used for recovery.

Explore shares a five-minute public ranking pool across signed-in and anonymous viewers. Each response revalidates current public visibility and viewer blocks before filtering to 24 profiles; follower activity remains viewer-specific. Page bootstrap functions share the authenticated identity, and image mutations memoize identity only for the same Request object. Profile-search documents have stable numeric IDs and update only when indexed text changes.

Image cleanup first marks an unreferenced asset for deletion. Database fences prevent attaching an image being deleted, and cleanup can resume after interruption. Uploads reserve the asset briefly before storing bytes. Do not delete an R2 object before claiming its deletion marker.

Import requests commit their JSON inserts atomically. Larger UI operations report completed chunks and allow retries that skip duplicates. SQLite integration tests exercise the actual migrations, revision guards, image fences and undo behavior; Playwright covers multi-tab recovery and local-cache reuse.

The patches for Radix Slot 1.2.3 and Select 2.2.6 memoize composed refs and their callbacks. Without them, ordinary parent renders detach and reattach unchanged controls, which can trigger React update loops. Keep these patches until an upstream upgrade passes `e2e/slot-refs.spec.ts`; those tests exercise the installed dependencies directly. After changing patches, run `pnpm install` to apply them to the local dependencies.
