// Error types shared between server functions and client code.
//
// TanStack Start serializes errors thrown in server functions with its
// ShallowErrorPlugin, which keeps ONLY `message` — class identity, `name`,
// and custom properties are stripped before the error reaches the client.
// Detection therefore matches on the exact message, which doubles as the
// user-facing copy.

import { clearDashboardSnapshot } from "./dashboardCache";
const UNAUTHORIZED_MESSAGE = "Your session has expired. Please sign in again.";
const FORBIDDEN_MESSAGE = "You do not have access to admin tools.";

export class UnauthorizedError extends Error {
    constructor() {
        super(UNAUTHORIZED_MESSAGE);
        this.name = "UnauthorizedError";
    }
}

export class ForbiddenError extends Error {
    constructor() {
        super(FORBIDDEN_MESSAGE);
        this.name = "ForbiddenError";
    }
}

export function isUnauthorizedError(error: unknown) {
    return error instanceof Error && error.message === UNAUTHORIZED_MESSAGE;
}

export function isForbiddenError(error: unknown) {
    return error instanceof Error && error.message === FORBIDDEN_MESSAGE;
}

export function isStaleDataError(error: unknown) {
    return error instanceof Error && (error.message.startsWith("This matchup changed") ||
        error.message.startsWith("This data changed in another request"));
}

/**
 * Client-side funnel for errors thrown by server functions. Returns true
 * when the error was an expired/missing session and a redirect to the
 * sign-in screen has been started; callers should stop processing the error.
 */
export function redirectIfUnauthorized(error: unknown) {
    if (typeof window !== "undefined" && isUnauthorizedError(error)) {
        void clearDashboardSnapshot().finally(() => window.location.assign("/signin"));
        return true;
    }

    return false;
}
