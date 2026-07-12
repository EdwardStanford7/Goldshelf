export const MAX_CATEGORY_NAME_LENGTH = 160;
export const MAX_ENTRY_NAME_LENGTH = 240;
export const MAX_PROFILE_SEARCH_LENGTH = 120;
export const MAX_ADMIN_SEARCH_LENGTH = 120;

export function normalizeRequiredText(value: unknown, label: string, maxLength: number) {
    if (typeof value !== "string") {
        throw new Error(`${label} is required`);
    }

    const cleanValue = value.trim();
    if (!cleanValue) {
        throw new Error(`${label} is required`);
    }
    if (cleanValue.length > maxLength) {
        throw new Error(`${label} must be ${maxLength} characters or fewer`);
    }

    return cleanValue;
}

export function normalizeOptionalSearch(value: unknown, maxLength: number) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim().slice(0, maxLength);
}

export function isWithinTextLimit(value: string, maxLength: number) {
    return value.length <= maxLength;
}
