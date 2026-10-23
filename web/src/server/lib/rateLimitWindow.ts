export function fixedWindowStart(timestamp: number, windowMs: number) {
    return Math.floor(timestamp / windowMs) * windowMs;
}
