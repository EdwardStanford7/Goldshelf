import { createFileRoute } from "@tanstack/react-router";
import { purgeUnreferencedImageAssets } from "@/server/lib/imageAssets";
import { testModeGate } from "@/server/lib/testMode";

export const Route = createFileRoute("/api/test/cleanup-image-assets")({
    server: {
        handlers: {
            POST: async ({ request }: { request: Request }) => {
                const gated = testModeGate();
                if (gated) {
                    return gated;
                }

                const body = await request.json().catch(() => ({})) as { timestamp?: number };
                return Response.json(await purgeUnreferencedImageAssets(body.timestamp));
            }
        }
    }
});
