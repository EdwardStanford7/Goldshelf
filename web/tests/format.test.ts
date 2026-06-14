import { describe, expect, it } from "vitest";
import {
    REQUEST_LOAD_FAILURE_MESSAGE,
    errorMessage,
    isTransientRequestFailure
} from "../src/lib/format";
import { UnauthorizedError } from "../src/lib/errors";

describe("transient request failures", () => {
    it.each([
        "Load failed",
        "Failed to fetch",
        "NetworkError",
        "fetch failed"
    ])("classifies %s as transient", (message) => {
        const error = new TypeError(message);

        expect(isTransientRequestFailure(error)).toBe(true);
        expect(errorMessage(error)).toBe(REQUEST_LOAD_FAILURE_MESSAGE);
    });

    it("does not classify normal application errors as transient", () => {
        expect(isTransientRequestFailure(new Error("Category name is required"))).toBe(false);
    });

    it("does not classify auth errors as transient", () => {
        expect(isTransientRequestFailure(new UnauthorizedError())).toBe(false);
    });
});
