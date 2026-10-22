import { env } from "cloudflare:workers";

export function getDb() {
    return env.DB;
}

export function getImagesBucket() {
    return env.IMAGES;
}

export function now() {
    return Date.now();
}

export function newId(prefix: string) {
    return `${prefix}_${crypto.randomUUID()}`;
}

export async function all<T>(statement: D1PreparedStatement) {
    const result = await statement.all<T>();
    return result.results ?? [];
}

export async function first<T>(statement: D1PreparedStatement) {
    return (await statement.first<T>()) ?? null;
}

const BATCH_SIZE = 100;

export async function runBatches(db: D1Database, statements: D1PreparedStatement[]) {
    for (let index = 0; index < statements.length; index += BATCH_SIZE) {
        await db.batch(statements.slice(index, index + BATCH_SIZE));
    }
}

export function assertOwned<T>(
    row: T | null | undefined,
    resource = "Resource"
): asserts row is T {
    if (!row) {
        throw new Error(`${resource} not found`);
    }
}
