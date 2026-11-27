import { AsyncLocalStorage } from "node:async_hooks";

interface Scope {
    userId: string;
    revision: number;
    pending: D1PreparedStatement[];
    tail: Promise<unknown>;
    deleted?: boolean;
}
const scopes = new AsyncLocalStorage<Scope>();
const originals = new WeakMap<object, D1PreparedStatement>();
const queries = new WeakMap<object, string>();

export function mutationRevision() { return scopes.getStore()?.revision ?? 0; }

export async function withVersionedDb<T>(db: D1Database, userId: string, work: () => T | Promise<T>): Promise<T> {
    if (scopes.getStore()) return work();
    const row = await db.prepare("SELECT revision FROM user_data_versions WHERE user_id = ?").bind(userId).first<{ revision: number }>();
    return scopes.run({ userId, revision: row?.revision ?? 0, pending: [], tail: Promise.resolve() }, work);
}

/** Undo snapshots are saved alongside the state transition they describe. */
export function stageMutation(statement: D1PreparedStatement) {
    const scope = scopes.getStore();
    if (!scope) throw new Error("Mutation requires an authenticated database scope");
    scope.pending.push(originals.get(statement) ?? statement);
}

export function versionedDb(db: D1Database): D1Database {
    const scope = scopes.getStore();
    if (!scope) return db;
    async function batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
        if (scope!.deleted) return db.batch<T>(statements.map((statement) => originals.get(statement) ?? statement));
        if (scope!.pending.length === 0 && statements.every((statement) => {
            const sql = queries.get(statement) ?? "";
            return /^\s*(?:SELECT|WITH)\b/i.test(sql) && !/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
        })) {
            return db.batch<T>(statements.map((statement) => originals.get(statement) ?? statement));
        }
        // Some handlers issue independent writes with Promise.all. Serialize
        // those within this request while retaining optimistic inter-request checks.
        const operation = scope!.tail.then(async () => {
            const pending = scope!.pending.splice(0);
            const id = crypto.randomUUID();
            try {
                const results = await db.batch<T>([
                    db.prepare(`INSERT INTO mutation_guards VALUES (?, ?,
                      COALESCE((SELECT revision FROM user_data_versions WHERE user_id = ?), 0) = ?)`)
                        .bind(id, scope!.userId, scope!.userId, scope!.revision),
                    ...pending,
                    ...statements.map((statement) => originals.get(statement) ?? statement),
                    db.prepare(`INSERT INTO user_data_versions SELECT id, 1 FROM "user" WHERE id = ?
                      ON CONFLICT(user_id) DO UPDATE SET revision = revision + 1`).bind(scope!.userId),
                    db.prepare("DELETE FROM mutation_guards WHERE id = ?").bind(id),
                    db.prepare("SELECT revision FROM user_data_versions WHERE user_id = ?").bind(scope!.userId)
                ]);
                const revisionResult = results.at(-1) as D1Result<{ revision: number }>;
                scope!.deleted = revisionResult.results.length === 0;
                scope!.revision = revisionResult.results[0]?.revision ?? 0;
                return results.slice(1 + pending.length, 1 + pending.length + statements.length);
            } catch (error) {
                if (String(error).includes("stale_mutation")) {
                    throw new Error("This data changed in another request. Refresh and try again.");
                }
                throw error;
            }
        });
        scope!.tail = operation.catch(() => {});
        return operation;
    }
    function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
        const proxy = new Proxy(statement, { get(target, key) {
            if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
            if (key === "run" || (key === "all" && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))) {
                return async () => (await batch([proxy]))[0];
            }
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
        } });
        originals.set(proxy, statement);
        queries.set(proxy, sql);
        return proxy;
    }
    return new Proxy(db, { get(target, key) {
        if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        if (key === "batch") return batch;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
    } });
}
