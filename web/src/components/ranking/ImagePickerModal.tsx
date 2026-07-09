import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { redirectIfUnauthorized } from "@/lib/errors";
import { errorMessage, isTransientRequestFailure } from "@/lib/format";
import {
    imageCandidateToPosterBlob,
    imageElementToPosterBlob,
    imageUrlToPosterBlob,
    uploadImageForTarget,
    withCacheBust,
    type ImagePickerTarget,
    type ImageSearchCandidate
} from "@/lib/posterImage";
import { markImageUnavailable } from "@/server/entries";

const IMAGE_SEARCH_TIMEOUT_MS = 15_000;
const STATUS_CLASS =
    "rounded-sm border-l-4 border-l-gold bg-status px-3 py-[0.6rem] whitespace-pre-line";

export function ImagePickerModal({
    target,
    onClose,
    onSaved
}: {
    target: ImagePickerTarget;
    onClose: () => void;
    onSaved: () => Promise<void>;
}) {
    const defaultQuery = `${target.item.name} (${target.category.name})`;
    const [query, setQuery] = useState(defaultQuery);
    const [candidates, setCandidates] = useState<ImageSearchCandidate[]>([]);
    const [loading, setLoading] = useState(false);
    const [savingCandidateId, setSavingCandidateId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const candidatesRef = useRef<ImageSearchCandidate[]>([]);
    const candidatesByQueryRef = useRef<Map<string, ImageSearchCandidate[]>>(new Map());
    const thumbnailPosterBlobsRef = useRef<Map<string, Blob>>(new Map());
    const displayedQueryRef = useRef<string | null>(null);
    const searchRequestIdRef = useRef(0);
    const activeSearchControllerRef = useRef<AbortController | null>(null);
    const pendingTransientSearchRef = useRef<string | null>(null);
    const loadingRef = useRef(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    useEscapeKey(true, onClose);

    function interruptSearch() {
        searchRequestIdRef.current += 1;
        activeSearchControllerRef.current?.abort();
        activeSearchControllerRef.current = null;
        setLoading(false);
    }

    function resetFileInput() {
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    }

    const search = useCallback(async (searchQuery: string) => {
        const requestId = searchRequestIdRef.current + 1;
        searchRequestIdRef.current = requestId;
        const submittedQuery = searchQuery.trim();
        if (!submittedQuery) {
            setLoading(false);
            setError("Search query is required.");
            return;
        }

        pendingTransientSearchRef.current = null;
        const cachedCandidates = candidatesByQueryRef.current.get(submittedQuery.toLowerCase());
        if (cachedCandidates && cachedCandidates.length > 0) {
            pendingTransientSearchRef.current = null;
            candidatesRef.current = cachedCandidates;
            thumbnailPosterBlobsRef.current.clear();
            displayedQueryRef.current = submittedQuery;
            setCandidates(cachedCandidates);
            setError(null);
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);
        const cacheBust = crypto.randomUUID();
        activeSearchControllerRef.current?.abort();
        const controller = new AbortController();
        activeSearchControllerRef.current = controller;
        const timeoutId = window.setTimeout(() => controller.abort(), IMAGE_SEARCH_TIMEOUT_MS);

        try {
            const url = new URL("/api/image-search", window.location.origin);
            url.searchParams.set(target.kind === "entry" ? "entryId" : "queuedEntryId", target.item.id);
            url.searchParams.set("query", submittedQuery);
            url.searchParams.set("refresh", cacheBust);
            const response = await fetch(url, {
                cache: "no-store",
                signal: controller.signal
            });
            const body = await response.json().catch(() => ({})) as {
                candidates?: ImageSearchCandidate[];
                message?: string;
            };

            if (!response.ok) {
                throw new Error(body.message ?? "Image search failed");
            }

            if (requestId !== searchRequestIdRef.current) {
                return;
            }

            const candidates = Array.isArray(body.candidates) ? body.candidates : [];
            const nextCandidates = candidates.map((candidate) => ({
                ...candidate,
                imageUrl: withCacheBust(candidate.imageUrl, cacheBust),
                thumbnailUrl: withCacheBust(candidate.thumbnailUrl, cacheBust)
            }));
            if (nextCandidates.length === 0) {
                throw new Error("No image candidates found");
            }

            candidatesRef.current = nextCandidates;
            candidatesByQueryRef.current.set(submittedQuery.toLowerCase(), nextCandidates);
            thumbnailPosterBlobsRef.current.clear();
            displayedQueryRef.current = submittedQuery;
            pendingTransientSearchRef.current = null;
            setCandidates(nextCandidates);
        } catch (searchError) {
            if (requestId !== searchRequestIdRef.current) {
                return;
            }

            if (isTransientRequestFailure(searchError)) {
                pendingTransientSearchRef.current = submittedQuery;
                if (candidatesRef.current.length > 0) {
                    setCandidates(candidatesRef.current);
                } else {
                    setCandidates([]);
                }
                setError(null);
                return;
            }

            if (candidatesRef.current.length > 0) {
                setCandidates(candidatesRef.current);
                const previousQuery = displayedQueryRef.current
                    ? ` for "${displayedQueryRef.current}"`
                    : "";
                setError(`${errorMessage(searchError)}. Showing previous results${previousQuery}.`);
            } else {
                setCandidates([]);
                setError(errorMessage(searchError));
            }
        } finally {
            window.clearTimeout(timeoutId);
            if (requestId === searchRequestIdRef.current) {
                if (activeSearchControllerRef.current === controller) {
                    activeSearchControllerRef.current = null;
                }
                setLoading(false);
            }
        }
    }, [target.kind, target.item.id]);

    useEffect(() => {
        loadingRef.current = loading;
    }, [loading]);

    useEffect(() => {
        setQuery(defaultQuery);
        candidatesRef.current = [];
        candidatesByQueryRef.current.clear();
        thumbnailPosterBlobsRef.current.clear();
        displayedQueryRef.current = null;
        setCandidates([]);
        void search(defaultQuery);
    }, [defaultQuery, search]);

    useEffect(() => () => {
        searchRequestIdRef.current += 1;
        activeSearchControllerRef.current?.abort();
    }, []);

    useEffect(() => {
        function retryPendingTransientSearch() {
            const pendingQuery = pendingTransientSearchRef.current;
            if (!pendingQuery || loadingRef.current) {
                return;
            }

            pendingTransientSearchRef.current = null;
            void search(pendingQuery);
        }

        function handleVisibilityChange() {
            if (document.visibilityState === "visible") {
                retryPendingTransientSearch();
            }
        }

        function handlePageShow() {
            retryPendingTransientSearch();
        }

        window.addEventListener("focus", retryPendingTransientSearch);
        window.addEventListener("online", retryPendingTransientSearch);
        window.addEventListener("pageshow", handlePageShow);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("focus", retryPendingTransientSearch);
            window.removeEventListener("online", retryPendingTransientSearch);
            window.removeEventListener("pageshow", handlePageShow);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [search]);

    async function selectCandidate(
        candidate: ImageSearchCandidate,
        renderedThumbnail: HTMLImageElement | null
    ) {
        setSavingCandidateId(candidate.id);
        setError(null);

        try {
            const blob = await imageCandidateToPosterBlob(
                candidate,
                renderedThumbnail,
                thumbnailPosterBlobsRef.current.get(candidate.id) ?? null
            );
            await uploadImageForTarget(target, blob);
            await onSaved();
        } catch (saveError) {
            setError(errorMessage(saveError));
        } finally {
            resetFileInput();
            setSavingCandidateId(null);
        }
    }

    function cacheRenderedThumbnail(candidate: ImageSearchCandidate, image: HTMLImageElement) {
        void imageElementToPosterBlob(image)
            .then((blob) => {
                thumbnailPosterBlobsRef.current.set(candidate.id, blob);
            })
            .catch(() => {
                thumbnailPosterBlobsRef.current.delete(candidate.id);
            });
    }

    async function uploadLocalFile(file: File) {
        interruptSearch();
        setSavingCandidateId("local");
        setError(null);

        try {
            const objectUrl = URL.createObjectURL(file);
            try {
                const blob = await imageUrlToPosterBlob(objectUrl);
                await uploadImageForTarget(target, blob);
                await onSaved();
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        } catch (saveError) {
            setError(errorMessage(saveError));
        } finally {
            resetFileInput();
            setSavingCandidateId(null);
        }
    }

    async function saveNoImage() {
        interruptSearch();
        setSavingCandidateId("none");
        setError(null);

        try {
            await markImageUnavailable({
                data: {
                    targetKind: target.kind,
                    targetId: target.item.id
                }
            });
            await onSaved();
        } catch (saveError) {
            if (!redirectIfUnauthorized(saveError)) {
                setError(errorMessage(saveError));
            }
        } finally {
            setSavingCandidateId(null);
        }
    }

    return (
        <div
            className="fixed inset-0 z-60 grid place-items-center bg-modal-backdrop p-4 max-[720px]:block max-[720px]:p-0"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section className="grid max-h-[min(760px,calc(100vh-2rem))] w-[min(920px,100%)] max-w-[calc(100vw-2rem)] gap-[0.9rem] overflow-x-hidden overflow-y-auto rounded-md border border-border bg-card p-4 shadow-panel max-[720px]:h-dvh max-[720px]:max-h-dvh max-[720px]:w-full max-[720px]:max-w-none max-[720px]:rounded-none max-[720px]:border-0 max-[720px]:p-3 [&_h2]:m-0 [&_p]:m-0">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-[0.7rem] max-[720px]:sticky max-[720px]:top-0 max-[720px]:z-10 max-[720px]:-mx-3 max-[720px]:-mt-3 max-[720px]:mb-1 max-[720px]:flex-nowrap max-[720px]:bg-card max-[720px]:px-3 max-[720px]:py-3 max-[720px]:shadow-sm *:max-w-full *:min-w-0">
                    <div className="min-w-0">
                        <h2 className="truncate text-lg font-semibold">Pick Image</h2>
                        <p className="text-muted-foreground">{target.item.name} - {target.category.name}</p>
                    </div>
                    <Button className="shrink-0" variant="outline" type="button" onClick={onClose}>Close</Button>
                </div>

                <form
                    className="flex flex-wrap items-center gap-[0.7rem] max-[720px]:grid max-[720px]:grid-cols-2 max-[720px]:items-stretch *:max-w-full *:min-w-0"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void search(query);
                    }}
                >
                    <Input
                        className="flex-[1_1_12rem] max-[720px]:col-span-2"
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            if (error) {
                                setError(null);
                            }
                        }}
                        placeholder="Search"
                    />
                    <Button className="max-[720px]:w-full" disabled={loading || Boolean(savingCandidateId)} type="submit">Search</Button>
                    <Button
                        className="max-[720px]:w-full"
                        variant="outline"
                        disabled={loading || Boolean(savingCandidateId)}
                        type="button"
                        onClick={() => {
                            setQuery(defaultQuery);
                            void search(defaultQuery);
                        }}
                    >
                        Default
                    </Button>
                </form>

                <div className="flex flex-wrap items-center gap-[0.65rem] max-[720px]:grid max-[720px]:grid-cols-2">
                    <label className="relative w-fit cursor-pointer rounded-sm border border-border bg-card px-[0.8rem] py-[0.55rem] text-center text-foreground max-[720px]:w-full">
                        <span>Upload File</span>
                        <input
                            accept="image/*"
                            className="absolute h-px w-px overflow-hidden [clip:rect(0,0,0,0)]"
                            disabled={Boolean(savingCandidateId)}
                            ref={fileInputRef}
                            type="file"
                            onClick={(event) => {
                                event.currentTarget.value = "";
                            }}
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                if (file) {
                                    void uploadLocalFile(file);
                                }
                                event.currentTarget.value = "";
                            }}
                        />
                    </label>
                    <Button
                        className="max-[720px]:w-full"
                        variant="outline"
                        disabled={Boolean(savingCandidateId)}
                        type="button"
                        onClick={() => void saveNoImage()}
                    >
                        {savingCandidateId === "none" ? "Saving..." : "Use No Image"}
                    </Button>
                </div>

                {error ? <div className={STATUS_CLASS}>{error}</div> : null}
                {loading ? <div className={STATUS_CLASS}>Searching for images...</div> : null}

                <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-[0.7rem] max-[720px]:grid-cols-2 max-[720px]:gap-2">
                    {candidates.map((candidate) => (
                        <button
                            className="relative block aspect-4/5 cursor-pointer overflow-hidden rounded-sm border border-border bg-secondary transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-55"
                            disabled={Boolean(savingCandidateId)}
                            key={candidate.id}
                            type="button"
                            onClick={(event) => {
                                const renderedThumbnail = event.currentTarget.querySelector("img");
                                void selectCandidate(candidate, renderedThumbnail);
                            }}
                        >
                            <img
                                alt=""
                                className="block h-full w-full object-cover"
                                src={candidate.thumbnailUrl}
                                loading="lazy"
                                decoding="async"
                                onLoad={(event) => cacheRenderedThumbnail(candidate, event.currentTarget)}
                            />
                            {savingCandidateId === candidate.id ? <span className="absolute inset-x-0 bottom-0 bg-overlay-strip p-[0.45rem] text-center text-overlay-button-ink">Saving...</span> : null}
                        </button>
                    ))}
                </div>

                {!loading && candidates.length === 0 ? (
                    <div className="text-muted-foreground">No image candidates loaded.</div>
                ) : null}
            </section>
        </div>
    );
}
