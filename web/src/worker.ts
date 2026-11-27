import startServer from "@tanstack/react-start/server-entry";
import { canonicalUrl } from "@/lib/canonicalHost";
import { purgeExpiredDeletedItems, purgeExpiredTemporaryData } from "@/server/engine/maintenance";
import { purgeUnreferencedImageAssets } from "@/server/lib/imageAssets";

import { securityPolicy } from "@/lib/securityPolicy";

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
