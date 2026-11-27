/** Callers supply fixed SQL identifiers; values remain one JSON bind. */
export function jsonInsert(db: D1Database, table: "categories" | "entries" | "entry_queue", columns: string[], rows: unknown[][]) {
    return db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(",")})
      SELECT ${columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(",")}
      FROM json_each(?) RETURNING id`).bind(JSON.stringify(rows));
}
