const WWW_HOST = "www.goldshelf.net";
const CANONICAL_HOST = "goldshelf.net";

export function canonicalUrl(value: string | URL) {
    const url = new URL(value);
    if (url.hostname !== WWW_HOST) {
        return null;
    }

    url.hostname = CANONICAL_HOST;
    return url;
}
