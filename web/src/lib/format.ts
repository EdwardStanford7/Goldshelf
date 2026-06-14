// User-facing calendar dates are stored as UTC-midnight timestamps and always
// formatted in UTC, so server and client render the same day regardless of
// timezone (avoids SSR hydration mismatches).
export function dateInputToTimestamp(value: string) {
    return value ? new Date(`${value}T00:00:00Z`).getTime() : null;
}

export function currentDateTimestamp() {
    const today = new Date();
    return Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
}

export function formatDate(timestamp: number) {
    return new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC"
    }).format(new Date(timestamp));
}

// Formats a real instant. Defaults to the runtime's local timezone, which
// differs between server and client — for SSR-rendered instants, pass "UTC"
// until hydration completes (see useHydrated) and switch to local after mount.
export function formatDateTime(timestamp: number, timeZone?: "UTC") {
    return new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone
    }).format(new Date(timestamp));
}

export const REQUEST_LOAD_FAILURE_MESSAGE = "Could not reach the server. Please try again.";

export function isRequestLoadFailure(error: unknown) {
    if (!(error instanceof TypeError)) {
        return false;
    }

    return /^(load failed|failed to fetch|networkerror|fetch failed)$/i.test(error.message.trim());
}

export function isTransientRequestFailure(error: unknown) {
    return isRequestLoadFailure(error);
}

export function errorMessage(error: unknown) {
    if (
        typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "AbortError"
    ) {
        return "Image search timed out";
    }

    if (isTransientRequestFailure(error)) {
        return REQUEST_LOAD_FAILURE_MESSAGE;
    }

    return error instanceof Error ? error.message : String(error);
}
