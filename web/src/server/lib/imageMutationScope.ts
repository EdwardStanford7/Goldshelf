import { env } from "cloudflare:workers";
import { auth } from "./auth";
import { withVersionedDb } from "./versionedDb";

/** Image routes participate in the same stale-write checks as server functions. */
export function versionedImageHandlers<T extends Record<string, unknown>>(handlers: T): T {
    return Object.fromEntries(Object.entries(handlers).map(([method, value]) => {
        if (method === "GET" || method === "HEAD") return [method, value];
        const handler = value as (input: { request: Request }) => Promise<Response>;
        return [method, async (input: { request: Request }) => {
            const session = await auth.api.getSession({ headers: input.request.headers });
            if (!session?.user) return Response.json({ message: "Unauthorized" }, { status: 401 });
            return withVersionedDb(env.DB, session.user.id, () => handler(input));
        }];
    })) as T;
}
