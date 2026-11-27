import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

export function sqliteD1() {
    const sqlite = new DatabaseSync(":memory:");
    const directory = new URL("../../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
        sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
    }
    sqlite.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
        .run("user", "User", "user@test.local", 0, 1, 1);
    sqlite.prepare("INSERT INTO categories (id,user_id,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run("category", "user", "Books", 0, 1, 1);
    function prepare(sql: string) {
        let values: (string | number | null)[] = [];
        const statement = {
            bind(...args: (string | number | null)[]) { values = args; return statement; },
            async first(column?: string) {
                const row = sqlite.prepare(sql).get(...values);
                return column ? row?.[column] ?? null : row ?? null;
            },
            async run() {
                const result = sqlite.prepare(sql).run(...values);
                return { results: [], success: true, meta: { changes: Number(result.changes) } };
            },
            async all() {
                const results = sqlite.prepare(sql).all(...values);
                const changes = sqlite.prepare("SELECT changes() AS n").get()?.n;
                return { results, success: true, meta: { changes: Number(changes) } };
            }
        };
        return statement;
    }
    const db = {
        prepare,
        async batch(statements: ReturnType<typeof prepare>[]) {
            sqlite.exec("BEGIN");
            try {
                const results = [];
                for (const statement of statements) results.push(await statement.all());
                sqlite.exec("COMMIT");
                return results;
            } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
        }
    } as unknown as D1Database;
    return { db, sqlite };
}
