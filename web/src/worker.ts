import startServer from "@tanstack/react-start/server-entry";
import { purgeUnreferencedImageAssets } from "@/server/lib/imageAssets";

export default {
    fetch(request: Request) {
        return startServer.fetch(request);
    },
    scheduled(_controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext) {
        ctx.waitUntil(purgeUnreferencedImageAssets());
    }
} satisfies ExportedHandler<Cloudflare.Env>;
