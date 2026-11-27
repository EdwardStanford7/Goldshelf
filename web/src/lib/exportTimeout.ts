export const EXPORT_TIMEOUT_MS = 60_000;

/** Bound a stalled fetch/compressor without allowing a late result to download. */
export async function withExportTimeout<T>(operation: Promise<T>, timeoutMs = EXPORT_TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Export took too long. Please try again.")), timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}
