/** Determine the audience inside the relationship write, not from a prior read. */
export function followRequestStatement(db: D1Database, userId: string, profileUserId: string, timestamp: number) {
    return db.prepare(`INSERT INTO user_follows
      (follower_user_id, followed_user_id, status, created_at, accepted_at)
      SELECT ?, p.user_id, CASE WHEN p.is_public = 1 THEN 'accepted' ELSE 'pending' END,
        ?, CASE WHEN p.is_public = 1 THEN ? ELSE NULL END
      FROM user_profiles p WHERE p.user_id = ?
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
          (b.blocker_user_id = ? AND b.blocked_user_id = p.user_id) OR
          (b.blocker_user_id = p.user_id AND b.blocked_user_id = ?))
      ON CONFLICT(follower_user_id, followed_user_id) DO UPDATE SET
        status = excluded.status, created_at = excluded.created_at, accepted_at = excluded.accepted_at`)
        .bind(userId, timestamp, timestamp, profileUserId, userId, userId);
}
