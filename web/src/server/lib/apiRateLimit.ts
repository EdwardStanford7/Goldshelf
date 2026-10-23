import { first, getDb } from "./db";
import { fixedWindowStart } from "./rateLimitWindow";

interface RateLimitOptions {
    scope: string;
    subject: string;
    maxRequests: number;
    windowMs: number;
}

interface RateLimitRow {
    count: number;
}

export async function enforceApiRateLimit(options: RateLimitOptions) {
    const windowStart = fixedWindowStart(Date.now(), options.windowMs);
    const key = `${options.scope}:${options.subject}`;
    const row = await first<RateLimitRow>(
        getDb()
            .prepare(
                `INSERT INTO api_rate_limits ("key", window_start, count)
                 VALUES (?, ?, 1)
                 ON CONFLICT("key") DO UPDATE SET
                   window_start = excluded.window_start,
                   count = CASE
                     WHEN api_rate_limits.window_start = excluded.window_start
                     THEN api_rate_limits.count + 1
                     ELSE 1
                   END
                 RETURNING count`
            )
            .bind(key, windowStart)
    );

    if (!row || row.count <= options.maxRequests) {
        return null;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + options.windowMs - Date.now()) / 1_000));
    return new Response("Too many requests. Try again later.", {
        status: 429,
        headers: {
            "cache-control": "no-store",
            "retry-after": String(retryAfterSeconds)
        }
    });
}

