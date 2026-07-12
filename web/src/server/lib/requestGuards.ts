import { env } from "cloudflare:workers";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireSameOriginMutation(request: Request) {
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
        return null;
    }

    const allowedOrigins = new Set(
        [request.url, env.BETTER_AUTH_URL]
            .map((origin) => normalizeOrigin(origin))
            .filter((origin): origin is string => Boolean(origin))
    );

    const origin = request.headers.get("origin");
    if (origin) {
        const normalizedOrigin = normalizeOrigin(origin);
        return normalizedOrigin && allowedOrigins.has(normalizedOrigin)
            ? null
            : Response.json({ message: "Invalid request origin" }, { status: 403 });
    }

    const referer = request.headers.get("referer");
    if (referer) {
        try {
            return allowedOrigins.has(new URL(referer).origin)
                ? null
                : Response.json({ message: "Invalid request origin" }, { status: 403 });
        } catch {
            return Response.json({ message: "Invalid request origin" }, { status: 403 });
        }
    }

    return Response.json({ message: "Missing request origin" }, { status: 403 });
}

function normalizeOrigin(value: string | undefined) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return null;
    }

    try {
        return new URL(trimmed).origin;
    } catch {
        return null;
    }
}
