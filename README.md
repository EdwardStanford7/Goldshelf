# Goldshelf

Goldshelf is a matchup-based ranking app for any category you can think of: books, movies, TV, restaurants, to name a few. Instead of rating items in isolation, users build ordered lists by comparing two entries at a time.

Live at https://goldshelf.net

The web app is the current version of the project. The original Rust desktop app is kept in this repo as a legacy reference and for historical spreadsheet compatibility.

## Repository Layout

```text
web/          Current goldshelf web app
desktop-app/  Legacy Rust desktop app
```

## Current App

The active product lives in `web/`.

It includes:

- Binary-search ranking with local repair checks.
- Entry queueing with configurable delay.
- Email/password auth with password reset support.
- Legacy `.xlsx` import/export.
- Public profiles and one-sided follow requests.
- Cloudflare Workers deployment.
- Cloudflare D1 data storage.
- Cloudflare R2 image storage.

Common commands:

```sh
cd web
npm i -g pnpm
pnpm install
pnpm dev
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm build
make deploy
```

See `web/README.md` for Cloudflare, Resend, local development, and deployment details.

## Legacy Desktop App

The original desktop version lives in `desktop-app/`.

It is a Rust/egui app that ranked media from local spreadsheets and cached images alongside the workbook. It is no longer the main app and does not include the newer web features.

Common commands:

```sh
cd desktop-app
cargo run
make app
```

## Data Compatibility

The web app can import the legacy spreadsheet format:

- Category names in the first row.
- Ranked entries listed below each category in column order.

The web export keeps a legacy `Sorted` sheet so older workflows can still read the ordered lists.
