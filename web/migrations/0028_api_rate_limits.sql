-- Keep expensive external-image operations bounded per signed-in account.
-- A single row is retained per user/scope, so this table cannot grow per request.
CREATE TABLE IF NOT EXISTS api_rate_limits (
  "key" TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0)
);
