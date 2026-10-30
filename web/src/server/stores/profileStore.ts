import type { ActivityVisibility, CurrentUserProfile } from "@/lib/types";
import { assertOwned, first, getDb, now } from "@/server/lib/db";

export const MIN_PROFILE_SLUG_LENGTH = 3;
export const MAX_PROFILE_SLUG_LENGTH = 40;

export interface ProfileRow {
    user_id: string;
    name: string;
    image: string | null;
    slug: string;
    is_public: number;
    activity_visibility: ActivityVisibility;
    created_at: number;
    updated_at: number;
}

interface UserIdentityRow {
    id: string;
    name: string;
    image: string | null;
    createdAt: number;
    updatedAt: number;
}

export async function ensureUserProfile(userId: string): Promise<ProfileRow> {
    const existingProfile = await getProfileByUserId(userId);
    if (existingProfile) {
        return existingProfile;
    }

    const user = await first<UserIdentityRow>(
        getDb()
            .prepare(
                `SELECT id, name, image, createdAt, updatedAt
         FROM "user"
         WHERE id = ?`
            )
            .bind(userId)
    );
    assertOwned(user, "User");

    const createdAt = now();
    const slugBase = slugifyProfileName(user.name || "user");
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const slug = attempt === 0
            ? slugBase
            : `${slugBase.slice(0, Math.max(MIN_PROFILE_SLUG_LENGTH, MAX_PROFILE_SLUG_LENGTH - 9))}-${randomSlugSuffix()}`;
        if (await profileSlugExists(slug)) {
            continue;
        }

        try {
            await getDb()
                .prepare(
                    `INSERT INTO user_profiles (user_id, slug, is_public, activity_visibility, created_at, updated_at)
             VALUES (?, ?, 0, 'off', ?, ?)`
                )
                .bind(userId, slug, createdAt, createdAt)
                .run();
            return {
                user_id: user.id,
                name: user.name,
                image: user.image,
                slug,
                is_public: 0,
                activity_visibility: "off",
                created_at: createdAt,
                updated_at: createdAt
            };
        } catch (error) {
            const racedProfile = await getProfileByUserId(userId);
            if (racedProfile) {
                return racedProfile;
            }

            if (attempt === 7) {
                throw error;
            }
        }
    }

    throw new Error("Profile handle could not be created");
}

export async function getProfileByUserId(userId: string) {
    return first<ProfileRow>(
        getDb()
            .prepare(
                `SELECT "user".id AS user_id, "user".name, "user".image,
                user_profiles.slug, user_profiles.is_public, user_profiles.activity_visibility,
                user_profiles.created_at, user_profiles.updated_at
         FROM user_profiles
         INNER JOIN "user" ON "user".id = user_profiles.user_id
         WHERE user_profiles.user_id = ?`
            )
            .bind(userId)
    );
}

export async function getProfileBySlug(profileSlug: string) {
    return first<ProfileRow>(
        getDb()
            .prepare(
                `SELECT "user".id AS user_id, "user".name, "user".image,
                user_profiles.slug, user_profiles.is_public, user_profiles.activity_visibility,
                user_profiles.created_at, user_profiles.updated_at
         FROM user_profiles
         INNER JOIN "user" ON "user".id = user_profiles.user_id
         WHERE user_profiles.slug = ?`
            )
            .bind(profileSlug)
    );
}

export async function profileSlugExists(profileSlug: string) {
    const row = await first<{ slug: string }>(
        getDb()
            .prepare(`SELECT slug FROM user_profiles WHERE slug = ?`)
            .bind(profileSlug)
    );

    return Boolean(row);
}

export function mapCurrentUserProfile(profile: ProfileRow): CurrentUserProfile {
    return {
        userId: profile.user_id,
        slug: profile.slug,
        isPublic: Boolean(profile.is_public),
        activityVisibility: profile.activity_visibility
    };
}

export function slugifyProfileName(value: string) {
    const slug = slugifyProfileInput(value);
    return slug.length >= MIN_PROFILE_SLUG_LENGTH ? slug : `user-${randomSlugSuffix()}`;
}

export function slugifyProfileInput(value: string) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_PROFILE_SLUG_LENGTH)
        .replace(/-+$/g, "");
}

export function randomSlugSuffix() {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}
