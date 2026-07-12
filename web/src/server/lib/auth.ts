import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { defaultAc, userAc } from "better-auth/plugins/admin/access";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "cloudflare:workers";
import { ADMIN_ROLE, USER_ROLE } from "@/lib/admin";
import { captureAuthUrl, isTestMode } from "./testMode";
import { fetchWithTimeout } from "./network";

export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const PASSWORD_RESET_EMAIL_TIMEOUT_MS = 8_000;

// better-auth names the session cookie `<prefix>better-auth.session_token`
// (prefixed with `__Secure-` when secure cookies are on). We only need to
// know whether a session cookie is present to decide if a DB session lookup
// is worth attempting, so a substring check on the opaque name is enough.
const SESSION_COOKIE_HINT = "better-auth.session_token";
const supportAdminRole = defaultAc.newRole({
    user: ["list", "get", "ban"],
    session: ["list", "revoke"]
});

/** True when the request carries a better-auth session cookie. */
export function requestHasSessionCookie(headers: Headers) {
    return headers.get("cookie")?.includes(SESSION_COOKIE_HINT) ?? false;
}

function optionalEnv(value: string | undefined) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

export async function getEmailSignUpOptions() {
    return {
        minPasswordLength: MIN_PASSWORD_LENGTH
    };
}

async function sendResetPasswordEmail({
    user,
    url
}: {
    user: { email: string; name?: string | null };
    url: string;
}) {
    if (isTestMode()) {
        captureAuthUrl("reset-password", user.email, url);
        return;
    }

    const resendApiKey = optionalEnv(env.RESEND_API_KEY);
    const fromEmail = optionalEnv(env.PASSWORD_RESET_FROM_EMAIL);
    if (!resendApiKey || !fromEmail) {
        console.warn(`Password reset email is not configured. Reset link for ${user.email}: ${url}`);
        return;
    }

    const response = await fetchWithTimeout(
        "https://api.resend.com/emails",
        {
            method: "POST",
            headers: {
                "authorization": `Bearer ${resendApiKey}`,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                from: fromEmail,
                to: user.email,
                subject: "Reset your goldshelf password",
                text: [
                    `Hi ${user.name || "there"},`,
                    "",
                    "Use this link to reset your goldshelf password:",
                    url,
                    "",
                    "This link expires in 1 hour. If you did not request this, you can ignore this email."
                ].join("\n"),
                html: [
                    `<p>Hi ${escapeHtml(user.name || "there")},</p>`,
                    "<p>Use this link to reset your goldshelf password:</p>",
                    `<p><a href="${escapeHtml(url)}">Reset password</a></p>`,
                    "<p>This link expires in 1 hour. If you did not request this, you can ignore this email.</p>"
                ].join("")
            })
        },
        PASSWORD_RESET_EMAIL_TIMEOUT_MS,
        "Password reset email timed out"
    );

    if (!response.ok) {
        console.error("Password reset email failed", await response.text());
        throw new Error("Password reset email failed");
    }
}

function escapeHtml(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    })[character] ?? character);
}

export const auth = betterAuth({
    appName: "Goldshelf",
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // In TEST_MODE, additionally trust:
    // - the e2e server origin, because a local .env (loaded by wrangler over
    //   the vars in wrangler.e2e.jsonc) may override BETTER_AUTH_URL
    // - the production origin, because the app sends it as the password-reset
    //   redirectTo; the reset request is rejected without it.
    trustedOrigins: isTestMode()
        ? [env.BETTER_AUTH_URL, "http://localhost:3100", "http://127.0.0.1:3100", "https://goldshelf.net"]
        : [env.BETTER_AUTH_URL],
    emailAndPassword: {
        enabled: true,
        minPasswordLength: MIN_PASSWORD_LENGTH,
        maxPasswordLength: MAX_PASSWORD_LENGTH,
        sendResetPassword: sendResetPasswordEmail,
        resetPasswordTokenExpiresIn: 60 * 60,
        revokeSessionsOnPasswordReset: true
    },
    rateLimit: {
        // Disabled in TEST_MODE so e2e tests can sign up/in repeatedly.
        enabled: !isTestMode(),
        storage: "database",
        window: 60,
        max: 60,
        customRules: {
            "/sign-in/email": {
                window: 60,
                max: 12
            },
            "/sign-up/email": {
                window: 300,
                max: 3
            },
            "/request-password-reset": {
                window: 300,
                max: 3
            },
            "/reset-password": {
                window: 300,
                max: 5
            },
            "/change-password": {
                window: 300,
                max: 3
            },
            "/change-email": {
                window: 300,
                max: 3
            }
        }
    },
    advanced: {
        ipAddress: {
            ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"]
        },
        useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://")
    },
    plugins: [
        admin({
            defaultRole: USER_ROLE,
            adminRoles: [ADMIN_ROLE],
            roles: {
                [ADMIN_ROLE]: supportAdminRole,
                [USER_ROLE]: userAc
            }
        }),
        tanstackStartCookies()
    ]
});
