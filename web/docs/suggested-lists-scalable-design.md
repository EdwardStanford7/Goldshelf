# Suggested Lists Scalable Design

## Purpose

Suggested Lists should be a deploy-and-forget community discovery feature for Goldshelf.

The feature should:

- Generate community list suggestions from public profile data.
- Require no manual review or recurring admin work.
- Avoid expensive live aggregation when a user opens `/suggested`.
- Avoid coupling correctness to every entry/category/profile mutation path.
- Scale beyond a small dataset without adding hard "too many entries" failure caps.
- Stay cheap on Cloudflare by bounding work per Worker invocation.

This document describes the recommended future implementation. It intentionally does not describe the temporary single-invocation cron prototype as the final design.

## Product Shape

The user-facing feature is simple:

- `/suggested` shows the top community-entered lists.
- Each list shows contributor count, entry count, generated timestamp, and up to 50 entries.
- Signed-out users can browse.
- Signed-in users can copy a list:
  - as a new private category
  - by merging into an existing category
- Copied entries are added to the user's queue with `image_key = NULL`.
- Matching is conservative and text-based, not canonical media matching.

Recommended default output:

- Top 10 suggested lists.
- Up to 50 suggested entries per list.
- Minimum 5 qualifying entries before publishing a suggested list.

## Non-Goals

Do not include these in the first scalable implementation:

- LLM matching.
- Fuzzy matching.
- External metadata APIs.
- Suggested-list images.
- Manual admin review as a required step.
- Live user-triggered aggregation from raw public profile tables.
- Exact canonical identity resolution for books, movies, games, etc.

Admin controls such as hide/rename can be added later, but they should not be required for correctness.

## Matching Model

Suggested Lists reflect public user-entered text after conservative normalization.

Normalization should:

- trim
- lowercase
- normalize Unicode
- strip diacritics
- remove punctuation
- collapse whitespace
- remove leading `a`, `an`, and `the`

Examples:

```text
"The Movies!" -> "movies"
"  Café Society " -> "cafe society"
"An Arrival" -> "arrival"
```

This will intentionally miss many real-world duplicates:

```text
"LOTR Book 1"
"Fellowship of the Ring"
"The Fellowship of the Ring (The Lord of the Rings, #1)"
```

That is acceptable. The UI should describe the data honestly as community-entered suggestions, not canonical media records.

## Why Not Live Counters

A counter/observation-row system can make `/suggested` very cheap, but it is fragile for a deploy-and-forget feature.

It requires every mutation path to update suggestion state correctly:

- create category
- rename category
- delete category
- category visibility toggle
- create entry
- rename entry
- delete entry
- move entry between categories
- finish ranking queued entry
- profile public/private toggle
- category copy flows
- future mutation paths added later

If one path is missed, counters drift silently. A weekly reconciliation job would then be required anyway.

For a feature that should not require ongoing maintenance, recomputing from ground truth is more robust. It is less coupled to application behavior and naturally handles renames, deletes, moves, and privacy changes on the next run.

## Why Not Single-Invocation Cron

A simple cron job that scans all public data in one Worker invocation is easy to build, but it eventually runs into Cloudflare limits:

- D1 query limits per Worker invocation.
- Worker CPU/runtime limits.
- Result size and memory shape.
- Bound-parameter limits for bulk writes.

Chunking reads inside one invocation helps result size, but it does not turn the job into a fully scalable pipeline. It is still one invocation doing repeated work.

The final design should split curation across many bounded invocations.

## Recommended Architecture

Use a multi-invocation ground-truth curation pipeline:

```text
Cron Trigger
  -> enqueue curation run
  -> scan public entries in bounded chunks
  -> write normalized contributor observations
  -> finalize candidate categories
  -> finalize candidate entries
  -> publish materialized suggested lists
  -> cleanup old staging rows
```

Core principles:

- Cron starts work but does not perform the full scan itself.
- Cloudflare Queues process bounded chunks.
- Each queue message stays under conservative D1 query and parameter budgets.
- Final `/suggested` reads only materialized suggestion tables.
- If a run fails, the previous completed suggestions remain visible.
- The next scheduled run starts fresh and can self-heal without manual intervention.

## Cloudflare Components

Use:

- Cloudflare Worker for the app.
- Separate Cloudflare Worker or shared Worker entry for scheduled/queue handling.
- Cloudflare Cron Trigger to start runs.
- Cloudflare Queues to process curation chunks.
- Cloudflare D1 for source data, staging rows, and published suggestions.

Recommended approach:

- Keep the main TanStack Start app Worker focused on user requests.
- Add a separate curation Worker with the same D1 binding.
- Bind a Queue to the curation Worker.
- Cron enqueues a `start_run` message.

This avoids fragile wrapping of the TanStack Start server entry.

## D1 Schema

### Published Tables

These are read by `/suggested`.

```sql
CREATE TABLE suggested_list_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN (
    'queued',
    'scanning',
    'finalizing_categories',
    'finalizing_entries',
    'publishing',
    'completed',
    'failed'
  )),
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('scheduled', 'manual')),
  normalization_version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  public_profile_count INTEGER NOT NULL DEFAULT 0,
  scanned_entry_count INTEGER NOT NULL DEFAULT 0,
  generated_list_count INTEGER NOT NULL DEFAULT 0,
  published_list_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_suggested_list_runs_completed
  ON suggested_list_runs(status, completed_at DESC);

CREATE TABLE suggested_lists (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published', 'hidden')),
  title TEXT NOT NULL,
  normalized_category_key TEXT NOT NULL,
  normalization_version INTEGER NOT NULL,
  contributor_count INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  published_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES suggested_list_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_suggested_lists_run_sort
  ON suggested_lists(run_id, status, sort_order);

CREATE TABLE suggested_list_entries (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published', 'hidden')),
  display_name TEXT NOT NULL,
  normalized_entry_key TEXT NOT NULL,
  contributor_count INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(list_id) REFERENCES suggested_lists(id) ON DELETE CASCADE
);

CREATE INDEX idx_suggested_list_entries_list_sort
  ON suggested_list_entries(list_id, status, sort_order);
```

### Staging Tables

These are per-run working tables. They can be deleted after successful publish or after a retention window.

```sql
CREATE TABLE suggested_curation_category_contributors (
  run_id TEXT NOT NULL,
  normalized_category_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY(run_id, normalized_category_key, user_id)
);

CREATE INDEX idx_suggested_cat_contrib_run_key
  ON suggested_curation_category_contributors(run_id, normalized_category_key);

CREATE TABLE suggested_curation_entry_contributors (
  run_id TEXT NOT NULL,
  normalized_category_key TEXT NOT NULL,
  normalized_entry_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY(run_id, normalized_category_key, normalized_entry_key, user_id)
);

CREATE INDEX idx_suggested_entry_contrib_run_keys
  ON suggested_curation_entry_contributors(
    run_id,
    normalized_category_key,
    normalized_entry_key
  );

CREATE TABLE suggested_curation_progress (
  run_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  cursor_entry_id TEXT,
  scanned_entry_count INTEGER NOT NULL DEFAULT 0,
  queued_category_offset INTEGER NOT NULL DEFAULT 0,
  finalized_category_count INTEGER NOT NULL DEFAULT 0,
  finalized_entry_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES suggested_list_runs(id) ON DELETE CASCADE
);

CREATE TABLE suggested_curation_candidate_categories (
  run_id TEXT NOT NULL,
  normalized_category_key TEXT NOT NULL,
  title TEXT NOT NULL,
  contributor_count INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(run_id, normalized_category_key)
);

CREATE INDEX idx_suggested_candidate_categories_sort
  ON suggested_curation_candidate_categories(run_id, sort_order);

CREATE TABLE suggested_curation_candidate_entries (
  run_id TEXT NOT NULL,
  normalized_category_key TEXT NOT NULL,
  normalized_entry_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  contributor_count INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(run_id, normalized_category_key, normalized_entry_key)
);

CREATE INDEX idx_suggested_candidate_entries_sort
  ON suggested_curation_candidate_entries(
    run_id,
    normalized_category_key,
    sort_order
  );
```

### Source Indexes

Add indexes that make scanning eligible public entries efficient:

```sql
CREATE INDEX idx_user_profiles_public_user
  ON user_profiles(is_public, user_id);

CREATE INDEX idx_categories_public_user_id
  ON categories(is_public, user_id, id);

CREATE INDEX idx_entries_status_id_user_category
  ON entries(status, id, user_id, category_id);
```

## Queue Message Types

Use typed queue messages.

```ts
type SuggestedCurationMessage =
  | { type: "start_run"; triggerKind: "scheduled" | "manual" }
  | { type: "scan_entries"; runId: string; cursorEntryId: string | null }
  | { type: "finalize_categories"; runId: string }
  | { type: "finalize_entries"; runId: string; categoryOffset: number }
  | { type: "publish"; runId: string }
  | { type: "cleanup"; runId: string };
```

Every handler must be idempotent. Queue delivery can retry messages.

## Phase 1: Start Run

The Cron Trigger enqueues:

```ts
{ type: "start_run", triggerKind: "scheduled" }
```

The handler:

1. Creates a `suggested_list_runs` row.
2. Creates a `suggested_curation_progress` row.
3. Enqueues `scan_entries` with `cursorEntryId = null`.

If a previous run is still active, prefer one of these policies:

- mark it failed and start a fresh run
- or skip starting a new run

For deploy-and-forget behavior, starting fresh is usually better. The latest completed run remains visible either way.

## Phase 2: Scan Public Entries

Each `scan_entries` message reads a bounded page of eligible public entries:

```sql
SELECT
  entries.id AS entry_id,
  user_profiles.user_id,
  categories.name AS category_name,
  entries.name AS entry_name
FROM user_profiles
INNER JOIN categories
  ON categories.user_id = user_profiles.user_id
INNER JOIN entries
  ON entries.user_id = categories.user_id
 AND entries.category_id = categories.id
WHERE user_profiles.is_public = 1
  AND categories.is_public = 1
  AND entries.status = 'active'
  AND (? IS NULL OR entries.id > ?)
ORDER BY entries.id ASC
LIMIT ?;
```

Recommended page size:

- Start with 100 entries per queue message.
- Split bulk inserts into chunks that stay below D1's bound-parameter limit.
- If tests show high CPU/query count, reduce to 50.

For each row:

1. Normalize category name.
2. Normalize entry name.
3. Skip empty normalized keys.
4. Insert category contributor:

```sql
INSERT OR IGNORE INTO suggested_curation_category_contributors (
  run_id,
  normalized_category_key,
  user_id,
  display_name
)
VALUES (?, ?, ?, ?);
```

5. Insert entry contributor:

```sql
INSERT OR IGNORE INTO suggested_curation_entry_contributors (
  run_id,
  normalized_category_key,
  normalized_entry_key,
  user_id,
  display_name
)
VALUES (?, ?, ?, ?, ?);
```

The `PRIMARY KEY` constraints prevent retry double-counting.

After each scan chunk:

- update `suggested_curation_progress.cursor_entry_id`
- increment scanned count
- enqueue the next `scan_entries` message if a full page was read
- otherwise enqueue `finalize_categories`

## Phase 3: Finalize Candidate Categories

Compute top candidate categories from contributor rows.

Threshold:

```text
categoryContributorThreshold = max(3, ceil(publicProfileCount * 0.05))
```

Recommended SQL shape:

```sql
INSERT INTO suggested_curation_candidate_categories (
  run_id,
  normalized_category_key,
  title,
  contributor_count,
  sort_order
)
SELECT
  ? AS run_id,
  category_counts.normalized_category_key,
  display_votes.display_name AS title,
  category_counts.contributor_count,
  row_number() OVER (
    ORDER BY category_counts.contributor_count DESC,
             display_votes.display_name ASC
  ) - 1 AS sort_order
FROM (
  SELECT
    normalized_category_key,
    COUNT(*) AS contributor_count
  FROM suggested_curation_category_contributors
  WHERE run_id = ?
  GROUP BY normalized_category_key
  HAVING COUNT(*) >= ?
) category_counts
JOIN (
  SELECT normalized_category_key, display_name
  FROM (
    SELECT
      normalized_category_key,
      display_name,
      COUNT(*) AS vote_count,
      row_number() OVER (
        PARTITION BY normalized_category_key
        ORDER BY COUNT(*) DESC, display_name ASC
      ) AS display_rank
    FROM suggested_curation_category_contributors
    WHERE run_id = ?
    GROUP BY normalized_category_key, display_name
  )
  WHERE display_rank = 1
) display_votes
  ON display_votes.normalized_category_key = category_counts.normalized_category_key
ORDER BY category_counts.contributor_count DESC, display_votes.display_name ASC
LIMIT 10;
```

If this query becomes too large for D1 at scale, split category finalization into paged reducer messages. Start with the simple indexed aggregation and only split if testing proves it is needed.

After categories finalize, enqueue:

```ts
{ type: "finalize_entries", runId, categoryOffset: 0 }
```

## Phase 4: Finalize Candidate Entries

Process candidate categories in small batches, or one category per message for maximum safety.

Threshold per category:

```text
entryContributorThreshold = max(2, ceil(categoryContributorCount * 0.10))
```

For each candidate category:

1. Select qualifying entry keys.
2. Pick display name by most common display name, tie-breaking alphabetically.
3. Insert up to 50 entries into `suggested_curation_candidate_entries`.

Use one queue message per category if simplicity and safety matter more than speed.

When all candidate categories are processed, enqueue:

```ts
{ type: "publish", runId }
```

## Phase 5: Publish

Publishing is the only phase that updates the public suggested list tables.

Important rules:

- Do not delete or alter the previous completed run before the new run completes.
- Insert new `suggested_lists` and `suggested_list_entries` for the new run.
- Mark `suggested_list_runs.status = 'completed'`.
- `/suggested` always reads the latest completed run.

If publish fails partway through, the run remains failed or incomplete, and users still see the previous completed run.

## Phase 6: Cleanup

Cleanup can run after publish:

- delete staging rows for the completed run
- delete staging rows for old failed runs
- optionally retain run metadata for recent history

Cleanup should be best-effort. Failure to clean old staging rows should not break `/suggested`.

## Failure Behavior

The system should be self-healing:

- Queue retries handle transient failures.
- Idempotent inserts prevent duplicate contributor rows.
- Failed runs do not affect currently published suggestions.
- Next cron starts a fresh run from ground truth.
- No admin intervention is required for correctness.

If a queue message repeatedly fails and reaches a dead letter queue, the run can be marked failed. The next scheduled run should still proceed normally.

## `/suggested` Read Path

The page should make only bounded reads:

1. Get latest completed run.
2. Get up to 10 published lists for that run.
3. Get up to 50 entries for those lists.
4. If signed in, get the viewer's target categories for copy/merge.

No raw public profile aggregation should happen during a user request.

## Copy Behavior

Copying a suggested list should:

- require sign-in
- copy entries into `entry_queue`
- set `image_key = NULL`
- create a private category for "copy as new"
- require a non-duplicate category name for "copy as new"
- for merge, reject if any copied entry already exists or is already queued in the target category

Use bulk inserts where possible and stay under D1 bound-parameter limits.

## Admin Behavior

Admin tools are optional.

For the deploy-and-forget version, do not require:

- manual review
- manual publish
- manual cleanup
- mandatory override management

Optional low-maintenance admin display:

- latest run status
- last completed timestamp
- public profile count
- scanned entry count
- generated list count
- failure message if the latest run failed
- "Run curation now" button

Avoid hide/rename overrides in the first scalable version unless they are genuinely needed. Overrides create long-term maintenance questions when normalization changes.

## Scalability Notes

This architecture is scalable in the important sense:

- no single user request performs heavy work
- no single cron invocation scans all data
- no hard data-size cap is required
- work is split across bounded queue invocations
- failed runs self-heal by recomputing from ground truth later

It is not a promise that Cloudflare Free handles infinite growth forever. If the app becomes large enough, total weekly queue/D1 usage can exceed Free quotas. At that point the feature should still not require a redesign; it may simply require a paid Cloudflare plan or lower refresh frequency.

That distinction matters:

- Bad scaling: feature breaks at 5,000 entries and needs a redesign.
- Good scaling: feature keeps the same architecture and only total usage/cost changes with growth.

## Recommended Refresh Frequency

Start with weekly:

```text
0 8 * * MON
```

Daily is also reasonable if usage remains small. Weekly is enough for community aggregate suggestions and reduces total D1/Queue usage.

## Implementation Sequence

1. Add normalization library and tests.
2. Add D1 migration for published and staging tables.
3. Add curation Worker and Queue config.
4. Add `start_run` handler.
5. Add `scan_entries` handler with idempotent contributor inserts.
6. Add category finalization.
7. Add entry finalization.
8. Add publish and cleanup phases.
9. Add `/suggested` route reading only published tables.
10. Add copy-to-queue server action.
11. Add navigation link.
12. Add targeted tests.

## Test Plan

### Unit Tests

- normalization:
  - casing
  - punctuation
  - whitespace
  - diacritics
  - leading articles
  - conservative non-matches
- thresholds:
  - category threshold
  - entry threshold
  - 5-entry minimum
  - top 10 category cap
  - 50-entry list cap
- display-name vote tie-breaking
- idempotent retry behavior

### Integration Tests

- queue scan chunk inserts contributors once
- repeated scan message does not double-count
- category finalization creates correct candidates
- entry finalization creates correct candidates
- failed run leaves prior completed suggestions visible
- next run after failure succeeds
- cleanup removes staging rows without deleting published suggestions

### Playwright Tests

- signed-out user can browse `/suggested`
- signed-out copy prompts sign-in
- signed-in user copies as new category
- signed-in user merges into existing category
- 50-entry suggested list copies correctly
- latest completed run remains visible after a failed run

## Deployment Checklist

- Add D1 migration.
- Add Queue in Wrangler config.
- Add curation Worker or queue consumer binding.
- Add Cron Trigger.
- Run local D1 migrations.
- Run `pnpm typecheck`.
- Run unit tests.
- Run targeted Playwright suggestions tests.
- Run Wrangler dry-run for the app Worker.
- Run Wrangler dry-run for the curation Worker.
- Deploy migrations before Worker code if new code depends on new tables.

## Final Recommendation

For a feature that should be both future-proof and deploy-and-forget, use the multi-invocation ground-truth curation pipeline.

Do not use live counters as the primary architecture. They are cheaper per finalization but more fragile because correctness depends on every app mutation path updating suggestion state.

Do not use a single-invocation cron scan as the final architecture. It is simple but eventually needs artificial caps or risks hitting per-invocation limits.

The multi-invocation queue pipeline is the right balance:

- computes from ground truth
- avoids counter drift
- does not require manual review
- keeps `/suggested` cheap
- bounds work per invocation
- scales by adding more queue messages, not by redesigning the feature
