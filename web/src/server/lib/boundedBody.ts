export class BodyTooLargeError extends Error {
    constructor() { super("Image is too large"); }
}

/** Bound both memory and time, including chunked responses without a length. */
export async function readBoundedBody(source: { body: ReadableStream<Uint8Array> | null }, maxBytes: number, timeoutMs = 8000) {
    if (!source.body) return new ArrayBuffer(0);
    const reader = source.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error("Image request timed out"));
            void reader.cancel().catch(() => {});
        }, timeoutMs);
    });
    try {
        while (true) {
            const { value, done } = await Promise.race([reader.read(), deadline]);
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new BodyTooLargeError();
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes.buffer;
    } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
    } finally { clearTimeout(timer); }
}
