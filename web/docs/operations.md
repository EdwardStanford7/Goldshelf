# Operations runbook

## Releases

Use `make deploy` or `pnpm deploy`. Both run unit/type/browser smoke checks, the production dependency audit, a build, and remote D1 migrations before deploying the Worker. Do not use `wrangler deploy` directly for a normal release.

Use a dedicated Cloudflare deployment token with only the Worker, D1, R2, and route permissions required by this application. Keep personal owner tokens for break-glass administration only.

`TEST_MODE` is local-e2e-only. The production configuration verifier rejects it, and the Worker refuses to enable test routes for the production app URL.

## Backup and recovery

Before a schema/data migration, confirm that Cloudflare D1 point-in-time recovery or a current export is available. Practice restoring both D1 data and R2 image objects into an isolated account/database at least once per release cycle. A successful deploy is not a recovery test.

Keep a dated record of the Worker version ID, D1 migration state, and R2 bucket name for each production release. Test a Worker rollback separately from a D1 rollback: schema migrations may not be reversible.

## Image storage

The admin **Check storage** action compares D1 references and R2 objects. Run it after R2 binding changes, bulk imports, or suspected storage incidents. It is intentionally read-only and samples at most 20 problematic keys; the scan stops at 50,000 objects.

Cloudflare bucket-size/object-count metadata can lag or disagree with direct object reads. Treat the reconciliation report and a direct object read as the source of truth during an incident.

The daily Worker task also permanently removes deleted entries and queued entries after their 30-day retention period. Dashboard loads do not perform retention cleanup.

## DNS and public endpoints

The canonical host is `goldshelf.net`. Maintain a Cloudflare redirect from `www.goldshelf.net/*` to `https://goldshelf.net/$1`, or deliberately provision `www` as a served host. Review HSTS, CSP, Referrer-Policy, and Permissions-Policy after any proxy or Worker routing change.

## Follow-ups requiring a product decision

Decide and document account-deletion, data-retention, privacy-policy, and support-admin private-data access policies before treating the service as compliance-ready. Those choices determine the deletion workflow and backup-retention schedule; they should not be inferred from implementation details.
