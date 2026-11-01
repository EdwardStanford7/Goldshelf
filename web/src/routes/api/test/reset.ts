import { createFileRoute } from "@tanstack/react-router";
import { all, getDb } from "@/server/lib/db";
import { testModeGate } from "@/server/lib/testMode";

// Tables that must never be wiped: SQLite internals, D1 bookkeeping, and the
// migrations ledger (the e2e runner applies migrations once before the server starts).
function isProtectedTable(name: string) {
    return name.startsWith("sqlite_") ||
        name.startsWith("_cf") ||
        name.startsWith("profile_search_") ||
        name === "d1_migrations";
}

export const Route = createFileRoute("/api/test/reset")({
    server: {
        handlers: {
            POST: async () => {
                const gated = testModeGate();
                if (gated) {
                    return gated;
                }

                const db = getDb();
                const tables = await all<{ name: string }>(
                    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                );
                const tableNames = tables
                    .map((table) => table.name)
                    .filter((name) => !isProtectedTable(name));

                await db.batch([
                    db.prepare("PRAGMA defer_foreign_keys = on"),
                    ...tableNames.map((name) => db.prepare(`DELETE FROM "${name}"`))
                ]);

                return Response.json({ ok: true, tablesCleared: tableNames });
            }
        }
    }
});
