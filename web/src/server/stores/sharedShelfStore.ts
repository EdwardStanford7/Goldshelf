import type { CategoryWithEntries } from "@/lib/types";
import { mapEntry, type EntryRow } from "./entryStore";

const SHARED_SHELF = `WITH viewer AS (SELECT ? AS id), shared AS (
  SELECT c.* FROM categories c JOIN user_profiles p ON p.user_id = c.user_id CROSS JOIN viewer v
  WHERE p.slug = ? AND c.id = ?
    AND (c.visibility = 'public' OR (c.visibility = 'followers' AND (
      c.user_id = v.id OR EXISTS (SELECT 1 FROM user_follows f
        WHERE f.follower_user_id = v.id AND f.followed_user_id = c.user_id AND f.status = 'accepted'))))
    AND (p.is_public = 1 OR c.user_id = v.id OR EXISTS (SELECT 1 FROM user_follows f
      WHERE f.follower_user_id = v.id AND f.followed_user_id = c.user_id AND f.status = 'accepted'))
    AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
      (b.blocker_user_id = v.id AND b.blocked_user_id = c.user_id) OR
      (b.blocker_user_id = c.user_id AND b.blocked_user_id = v.id))
)`;

/** Both metadata and entries use current permissions in the same read snapshot. */
export async function readSharedShelf(db: D1Database, slug: string, categoryId: string, viewerId = ""): Promise<CategoryWithEntries | null> {
    const bind = [viewerId, slug, categoryId];
    const [metadata, entries] = await db.batch([
        db.prepare(`${SHARED_SHELF} SELECT id, name, sort_order, created_at, visibility,
          data_revision, active_entry_count FROM shared`).bind(...bind),
        db.prepare(`${SHARED_SHELF} SELECT e.id, e.category_id, e.name, e.rank_position, e.image_key, e.created_at
          FROM shared s JOIN entries e ON e.category_id = s.id AND e.user_id = s.user_id
          WHERE e.status = 'active' ORDER BY e.rank_position`).bind(...bind)
    ]);
    const row = metadata.results[0] as { id: string; name: string; sort_order: number; created_at: number;
        visibility: "public" | "followers"; data_revision: string; active_entry_count: number } | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, sortOrder: row.sort_order, createdAt: row.created_at,
        visibility: row.visibility, isPublic: true, revision: row.data_revision, entryCount: row.active_entry_count,
        entries: (entries.results as unknown as EntryRow[]).map(mapEntry) };
}
