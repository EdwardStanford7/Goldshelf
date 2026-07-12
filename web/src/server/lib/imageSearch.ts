import { fetchWithTimeout } from "./network";

const SEARCH_RESULT_COUNT = 18;
const MAX_SEARCH_QUERY_LENGTH = 120;
const IMAGE_SEARCH_TIMEOUT_MS = 8_000;

interface DuckDuckGoImageResult {
    image?: string;
    thumbnail?: string;
    width?: number;
    height?: number;
}

interface CandidateSource {
    imageUrl: string;
    thumbnailUrl: string;
    width: number;
    height: number;
}

export interface ImageSearchCandidate {
    id: string;
    imageUrl: string;
    thumbnailUrl: string;
    width: number;
    height: number;
}

interface TextResponse {
    text: string;
    cookie: string | null;
}

export async function searchImageCandidates(query: string): Promise<ImageSearchCandidate[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) {
        throw new Error("Search query is required");
    }
    if (cleanQuery.length > MAX_SEARCH_QUERY_LENGTH) {
        throw new Error("Search query is too long");
    }

    const queries = buildSearchQueries(cleanQuery);
    let firstError: unknown = null;

    for (const candidateQuery of queries) {
        try {
            const candidates = await fetchImageCandidates(candidateQuery);
            if (candidates.length > 0) {
                return candidates;
            }
        } catch (error) {
            firstError ??= error;
        }
    }

    if (firstError instanceof Error) {
        throw firstError;
    }

    throw new Error("No image candidates found");
}

function buildSearchQueries(query: string) {
    const queries: string[] = [];
    const addQuery = (value: string) => {
        const cleanValue = value.trim().replace(/\s+/g, " ");
        if (cleanValue && !queries.some((candidate) => candidate.toLowerCase() === cleanValue.toLowerCase())) {
            queries.push(cleanValue);
        }
    };

    addQuery(query);
    addQuery(query.replace(/\s*\([^)]*\)\s*$/u, ""));
    addQuery(query.replace(/\s*-\s*[^-]+$/u, ""));
    addQuery(query.replace(/[()]/gu, " "));

    return queries;
}

async function fetchImageCandidates(cleanQuery: string): Promise<ImageSearchCandidate[]> {
    const htmlUrl = new URL("https://duckduckgo.com/");
    htmlUrl.searchParams.set("q", cleanQuery);
    htmlUrl.searchParams.set("iax", "images");
    htmlUrl.searchParams.set("ia", "images");

    const htmlResponse = await fetchText(htmlUrl, {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        mode: "document",
        referer: "https://duckduckgo.com/"
    });
    const vqd = extractVqd(htmlResponse.text);
    if (!vqd) {
        throw new Error("Could not start image search");
    }

    const jsonUrl = new URL("https://duckduckgo.com/i.js");
    jsonUrl.searchParams.set("q", cleanQuery);
    jsonUrl.searchParams.set("vqd", vqd);
    jsonUrl.searchParams.set("o", "json");

    const jsonResponse = await fetchText(jsonUrl, {
        accept: "application/json, text/javascript, */*; q=0.01",
        cookie: htmlResponse.cookie,
        mode: "cors",
        referer: "https://duckduckgo.com/",
        requestedWith: "XMLHttpRequest"
    });
    const payload = JSON.parse(jsonResponse.text) as { results?: DuckDuckGoImageResult[] };
    const results = Array.isArray(payload.results) ? payload.results : [];

    return sourcesToCandidates(
        results
            .filter((result) => result.image && result.width && result.height)
            .map((result) => ({
                imageUrl: result.image ?? "",
                thumbnailUrl: result.thumbnail || result.image || "",
                width: result.width ?? 0,
                height: result.height ?? 0
            }))
    );
}

function sourcesToCandidates(sources: CandidateSource[]): ImageSearchCandidate[] {
    const seen = new Set<string>();

    return sources
        .filter((source) => source.imageUrl && source.width > 0 && source.height > 0)
        .filter((source) => {
            if (seen.has(source.imageUrl)) {
                return false;
            }
            seen.add(source.imageUrl);
            return true;
        })
        .slice(0, SEARCH_RESULT_COUNT)
        .map((source) => {
            const imageId = encodeImageUrl(source.imageUrl);
            const thumbnailId = encodeImageUrl(source.thumbnailUrl || source.imageUrl);
            return {
                id: imageId,
                imageUrl: `/api/image-proxy?u=${encodeURIComponent(imageId)}`,
                thumbnailUrl: `/api/image-proxy?u=${encodeURIComponent(thumbnailId)}`,
                width: source.width,
                height: source.height
            };
        });
}

export function encodeImageUrl(value: string) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

export function decodeImageUrl(value: string) {
    const base64 = value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function assertSafeImageUrl(value: string) {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Unsupported image URL");
    }

    if (isBlockedHost(url.hostname)) {
        throw new Error("Unsupported image host");
    }

    return url;
}

function extractVqd(html: string) {
    for (const pattern of ['vqd="', "vqd='"]) {
        const start = html.indexOf(pattern);
        if (start === -1) {
            continue;
        }

        const valueStart = start + pattern.length;
        const rest = html.slice(valueStart);
        const end = rest.search(/["']/);
        if (end !== -1) {
            return rest.slice(0, end);
        }
    }

    return null;
}

async function fetchText(
    url: URL,
    options: {
        accept: string;
        cookie?: string | null;
        mode: "document" | "cors";
        referer: string;
        requestedWith?: string;
    }
): Promise<TextResponse> {
    const headers = new Headers({
        "accept": options.accept,
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "referer": options.referer,
        "sec-fetch-dest": options.mode === "document" ? "document" : "empty",
        "sec-fetch-mode": options.mode === "document" ? "navigate" : "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    });
    if (options.cookie) {
        headers.set("cookie", options.cookie);
    }
    if (options.requestedWith) {
        headers.set("x-requested-with", options.requestedWith);
    }

    const response = await fetchWithTimeout(
        url,
        {
            headers
        },
        IMAGE_SEARCH_TIMEOUT_MS,
        "Image search timed out"
    );

    if (!response.ok) {
        throw new Error(`Image search failed with ${response.status}`);
    }

    return {
        text: await response.text(),
        cookie: response.headers.getSetCookie?.().map((cookie) => cookie.split(";")[0]).join("; ") ||
            response.headers.get("set-cookie")?.split(",").map((cookie) => cookie.split(";")[0]).join("; ") ||
            null
    };
}

function isBlockedHost(hostname: string) {
    const host = normalizeHostname(hostname);
    if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local")
    ) {
        return true;
    }

    if (host.includes(":") && isBlockedIpv6(host)) {
        return true;
    }

    return isBlockedIpv4(host);
}

function normalizeHostname(hostname: string) {
    return hostname
        .trim()
        .toLowerCase()
        .replace(/^\[(.*)]$/, "$1")
        .replace(/\.$/, "");
}

function isBlockedIpv6(host: string) {
    return (
        host.startsWith("::ffff:") ||
        host === "::" ||
        host === "::1" ||
        host.startsWith("fc") ||
        host.startsWith("fd") ||
        host.startsWith("fe8") ||
        host.startsWith("fe9") ||
        host.startsWith("fea") ||
        host.startsWith("feb")
    );
}

function isBlockedIpv4(host: string) {
    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!ipv4) {
        return false;
    }

    const [first, second] = ipv4.slice(1).map(Number);
    return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
    );
}
