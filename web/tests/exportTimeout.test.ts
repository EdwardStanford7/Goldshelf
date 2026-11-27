import { afterEach, expect, it, vi } from "vitest";
import { withExportTimeout } from "../src/lib/exportTimeout";

afterEach(() => vi.useRealTimers());

it("rejects a stalled export and clears the deadline", async () => {
    vi.useFakeTimers();
    const operation = withExportTimeout(new Promise<never>(() => {}), 100);
    const failed = expect(operation).rejects.toThrow("Export took too long. Please try again.");
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
});

it("returns completed exports without leaving a timer", async () => {
    vi.useFakeTimers();
    await expect(withExportTimeout(Promise.resolve("workbook"))).resolves.toBe("workbook");
    expect(vi.getTimerCount()).toBe(0);
});

it("preserves errors from the fetch or compressor", async () => {
    vi.useFakeTimers();
    await expect(withExportTimeout(Promise.reject(new Error("Compression failed")))).rejects.toThrow("Compression failed");
    expect(vi.getTimerCount()).toBe(0);
});
