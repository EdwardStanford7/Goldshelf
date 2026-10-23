import { env } from "cloudflare:workers";

export type CapturedAuthUrlType = "reset-password";

export function isTestMode() {
    // A mistakenly configured production Worker must not expose destructive
    // e2e routes, even if TEST_MODE is accidentally added as a secret/var.
    return env.TEST_MODE === "true" && env.BETTER_AUTH_URL !== "https://goldshelf.net";
}

export function testModeGate() {
    if (!isTestMode()) {
        return Response.json({ message: "Not found" }, { status: 404 });
    }

    return null;
}

const capturedAuthUrls = new Map<string, string>();

function authUrlKey(type: CapturedAuthUrlType, email: string) {
    return `${type}:${email.trim().toLowerCase()}`;
}

export function captureAuthUrl(type: CapturedAuthUrlType, email: string, url: string) {
    capturedAuthUrls.set(authUrlKey(type, email), url);
}

export function takeAuthUrl(type: CapturedAuthUrlType, email: string) {
    const key = authUrlKey(type, email);
    const url = capturedAuthUrls.get(key) ?? null;
    if (url) {
        capturedAuthUrls.delete(key);
    }

    return url;
}
