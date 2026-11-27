const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

export async function fetchWithTimeout(
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {},
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    timeoutMessage = "Request timed out"
) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let bodyPending = false;

    try {
        const response = await fetch(input, {
            ...init,
            signal: controller.signal
        });
        if (!response.body) return response;
        bodyPending = true;
        const reader = response.body.getReader();
        return new Response(new ReadableStream({
            async pull(stream) {
                try {
                    const { done, value } = await reader.read();
                    if (done) { clearTimeout(timeoutId); stream.close(); }
                    else stream.enqueue(value);
                } catch (error) { clearTimeout(timeoutId); stream.error(error); }
            },
            cancel(reason) { clearTimeout(timeoutId); controller.abort(); return reader.cancel(reason); }
        }), response);
    } catch (error) {
        if (controller.signal.aborted && isAbortError(error)) {
            throw new Error(timeoutMessage);
        }

        throw error;
    } finally {
        if (!bodyPending) clearTimeout(timeoutId);
    }
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
}
