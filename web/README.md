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

If those values are missing, reset links are written to Worker logs for local/dev testing but no email is sent.

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

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

## Make Targets

The `Makefile` wraps the common local and deploy commands:

```sh
make check
make e2e
make cf-migrate-local
make deploy-first
make deploy
make cf-secret-password-reset
make password-reset-link EMAIL=user@example.com
```

`make deploy-first` handles Wrangler login, D1/R2 creation, and auth secret setup. `wrangler.jsonc` is already pointed at `https://goldshelf.net`; after the Worker rename, re-run `make cf-secret-auth` because Worker secrets are scoped to the Worker name.
