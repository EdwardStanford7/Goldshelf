import startServer from "@tanstack/react-start/server-entry";
import { canonicalUrl } from "@/lib/canonicalHost";
import { purgeExpiredDeletedItems, purgeExpiredTemporaryData } from "@/server/engine/maintenance";
import { purgeUnreferencedImageAssets } from "@/server/lib/imageAssets";

function securityPolicy() {
    // TanStack Start emits page-specific inline hydration scripts.  A static
    // hash cannot allow them, so blocking inline scripts breaks every page
    // after the initial SSR paint. Keep the remaining CSP boundaries while
    // allowing the framework's required scripts.
    return [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'"
    ].join("; ");
}

async function withSecurityHeaders(response: Response) {
    const headers = new Headers(response.headers);
    if (!headers.has("content-security-policy")) {
        headers.set("content-security-policy", securityPolicy());
    }
    if (!headers.has("referrer-policy")) {
        headers.set("referrer-policy", "strict-origin-when-cross-origin");
    }
    if (!headers.has("permissions-policy")) {
        headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
    }
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
}

export default {
    async fetch(request: Request) {
        const redirectUrl = canonicalUrl(request.url);
        if (redirectUrl) {
            return withSecurityHeaders(Response.redirect(redirectUrl, 308));
        }
        return withSecurityHeaders(await startServer.fetch(request));
    },
    scheduled(_controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext) {
        ctx.waitUntil(Promise.all([
            purgeExpiredDeletedItems(),
            purgeExpiredTemporaryData(),
            purgeUnreferencedImageAssets()
        ]));
    }
} satisfies ExportedHandler<Cloudflare.Env>;
