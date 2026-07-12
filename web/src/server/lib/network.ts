const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

export async function fetchWithTimeout(
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {},
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    timeoutMessage = "Request timed out"
) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(input, {
            ...init,
            signal: controller.signal
        });
    } catch (error) {
        if (controller.signal.aborted && isAbortError(error)) {
            throw new Error(timeoutMessage);
        }

        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
}
