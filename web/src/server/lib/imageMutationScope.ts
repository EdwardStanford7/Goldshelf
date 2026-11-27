import { env } from "cloudflare:workers";
import { auth } from "./auth";
import { withVersionedDb } from "./versionedDb";

// Identity is reused only for this exact Request, never across requests/tabs.
const sessions = new WeakMap<Request, ReturnType<typeof auth.api.getSession>>();
export function imageRequestSession(request: Request) {
    let session = sessions.get(request);
    if (!session) {
        session = auth.api.getSession({ headers: request.headers });
        sessions.set(request, session);
    }
    return session;
}

/** Image routes participate in the same stale-write checks as server functions. */
export function versionedImageHandlers<T extends Record<string, unknown>>(handlers: T): T {
    return Object.fromEntries(Object.entries(handlers).map(([method, value]) => {
        if (method === "GET" || method === "HEAD") return [method, value];
        const handler = value as (input: { request: Request }) => Promise<Response>;
        return [method, async (input: { request: Request }) => {
            const session = await imageRequestSession(input.request);
            if (!session?.user) return Response.json({ message: "Unauthorized" }, { status: 401 });
            return withVersionedDb(env.DB, session.user.id, () => handler(input));
        }];
    })) as T;
}
