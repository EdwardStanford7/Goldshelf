import { Link, createFileRoute } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import { Ban, RotateCcw, Search, Shield, ShieldOff, XCircle } from "lucide-react";
import { BrandLink } from "@/components/ui/BrandLink";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { hasAdminRole } from "@/lib/admin";
import { errorMessage } from "@/lib/format";
import { showToast } from "@/lib/toast";
import type {
    AdminSessionSummary,
    AdminUserDetailData,
    AdminUserListData,
    AdminUserSearchField,
    AdminUserSummary
} from "@/lib/types";
import {
    banAdminUser,
    loadAdminUserDetail,
    loadAdminUsers,
    revokeAdminUserSession,
    revokeAdminUserSessions,
    unbanAdminUser
} from "@/server/admin";
import { getSession } from "@/server/session";

const ADMIN_PAGE_SIZE = 20;

export const Route = createFileRoute("/admin")({
    head: () => ({
        meta: [
            { title: "Admin · Goldshelf" }
        ]
    }),
    loader: async () => {
        const session = await getSession();
        if (!session?.user) {
            return {
                viewer: null,
                forbidden: true,
                initialUsers: null
            };
        }

        const viewer = { id: session.user.id, name: session.user.name };
        if (!hasAdminRole(session.user)) {
            return {
                viewer,
                forbidden: true,
                initialUsers: null
            };
        }

        return {
            viewer,
            forbidden: false,
            initialUsers: await loadAdminUsers({
                data: {
                    search: "",
                    searchField: "all",
                    limit: ADMIN_PAGE_SIZE,
                    offset: 0
                }
            })
        };
    },
    component: AdminRoute
});

function AdminRoute() {
    const loaderData = Route.useLoaderData();
    const { viewer } = loaderData;
    if (!viewer) {
        return <AdminSignedOut />;
    }
    if (loaderData.forbidden) {
        return <AdminAccessDenied viewerName={viewer.name} />;
    }
    if (!loaderData.initialUsers) {
        return <AdminAccessDenied viewerName={viewer.name} />;
    }

    return <AdminContent initialUsers={loaderData.initialUsers} viewer={viewer} />;
}

function AdminSignedOut() {
    return (
        <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
            <Card className="grid w-[min(100%,32rem)] gap-4 rounded-lg px-4 text-center shadow-panel">
                <Shield className="mx-auto size-9 text-muted-foreground" />
                <div className="grid gap-1">
                    <h1 className="m-0 text-2xl font-bold">Sign in required</h1>
                    <p className="m-0 text-muted-foreground">Admin tools require a signed-in admin account.</p>
                </div>
                <Button asChild className="mx-auto w-fit">
                    <Link to="/signin">Sign in</Link>
                </Button>
            </Card>
        </main>
    );
}

function AdminContent({
    initialUsers,
    viewer
}: {
    initialUsers: AdminUserListData;
    viewer: { id: string; name: string };
}) {
    const [listData, setListData] = useState<AdminUserListData>(initialUsers);
    const [search, setSearch] = useState(initialUsers.search);
    const [searchField, setSearchField] = useState<AdminUserSearchField>(initialUsers.searchField);
    const [selectedDetail, setSelectedDetail] = useState<AdminUserDetailData | null>(null);
    const [banReason, setBanReason] = useState("");
    const [loadingList, setLoadingList] = useState(false);
    const [loadingDetailUserId, setLoadingDetailUserId] = useState<string | null>(null);
    const [actionBusy, setActionBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const totalPages = Math.max(1, Math.ceil(listData.total / listData.limit));
    const currentPage = Math.floor(listData.offset / listData.limit) + 1;

    async function reloadUsers(nextOffset = listData.offset) {
        setLoadingList(true);
        setError(null);
        try {
            const nextData = await loadAdminUsers({
                data: {
                    search,
                    searchField,
                    limit: ADMIN_PAGE_SIZE,
                    offset: nextOffset
                }
            });
            setListData(nextData);
        } catch (loadError) {
            setError(errorMessage(loadError));
        } finally {
            setLoadingList(false);
        }
    }

    async function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        await reloadUsers(0);
    }

    async function selectUser(userId: string) {
        setLoadingDetailUserId(userId);
        setError(null);
        try {
            const detail = await loadAdminUserDetail({ data: { userId } });
            setSelectedDetail(detail);
            setBanReason("");
            replaceListedUser(detail.user);
        } catch (loadError) {
            setError(errorMessage(loadError));
        } finally {
            setLoadingDetailUserId(null);
        }
    }

    async function handleBan(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selectedDetail) {
            return;
        }

        await runUserAction("ban", async () => {
            const detail = await banAdminUser({
                data: {
                    userId: selectedDetail.user.id,
                    reason: banReason
                }
            });
            setSelectedDetail(detail);
            replaceListedUser(detail.user);
            setBanReason("");
            showToast(`Banned ${detail.user.email}.`, "success");
        });
    }

    async function handleUnban() {
        if (!selectedDetail) {
            return;
        }

        await runUserAction("unban", async () => {
            const detail = await unbanAdminUser({ data: { userId: selectedDetail.user.id } });
            setSelectedDetail(detail);
            replaceListedUser(detail.user);
            showToast(`Unbanned ${detail.user.email}.`, "success");
        });
    }

    async function handleRevokeSession(sessionId: string) {
        if (!selectedDetail) {
            return;
        }

        await runUserAction(`session:${sessionId}`, async () => {
            const detail = await revokeAdminUserSession({
                data: {
                    userId: selectedDetail.user.id,
                    sessionId
                }
            });
            setSelectedDetail(detail);
            replaceListedUser(detail.user);
            showToast("Session revoked.", "success");
        });
    }

    async function handleRevokeAllSessions() {
        if (!selectedDetail) {
            return;
        }

        await runUserAction("sessions", async () => {
            const detail = await revokeAdminUserSessions({ data: { userId: selectedDetail.user.id } });
            setSelectedDetail(detail);
            replaceListedUser(detail.user);
            showToast(`Revoked sessions for ${detail.user.email}.`, "success");
        });
    }

    async function runUserAction(action: string, callback: () => Promise<void>) {
        setActionBusy(action);
        setError(null);
        try {
            await callback();
        } catch (actionError) {
            setError(errorMessage(actionError));
        } finally {
            setActionBusy(null);
        }
    }

    function replaceListedUser(user: AdminUserSummary) {
        setListData((current) => ({
            ...current,
            users: current.users.map((candidate) => candidate.id === user.id ? user : candidate)
        }));
    }

    return (
        <main className="min-h-screen bg-background text-foreground">
            <header className="sticky top-0 z-30 flex min-w-0 flex-wrap items-center gap-3 border-b border-border bg-background/95 px-[clamp(1rem,3vw,2rem)] py-3 shadow-sm backdrop-blur">
                <BrandLink />
                <div className="min-w-0 flex-1">
                    <h1 className="m-0 flex items-center gap-2 text-xl font-bold">
                        <Shield className="size-5 text-primary" />
                        Admin
                    </h1>
                    <p className="m-0 text-sm text-muted-foreground">Signed in as {viewer.name}</p>
                </div>
                <Button asChild variant="outline">
                    <Link to="/">Dashboard</Link>
                </Button>
            </header>

            <div className="grid w-full gap-4 px-[clamp(1rem,3vw,2rem)] py-4">
                <Card className="gap-3 rounded-lg px-4 shadow-panel">
                    <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_auto]" onSubmit={handleSearchSubmit}>
                        <label className="grid gap-1">
                            <span className="text-sm font-medium">Search users</span>
                            <Input
                                aria-label="Search users"
                                placeholder="Email, name, or user id"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                        </label>
                        <label className="grid gap-1">
                            <span className="text-sm font-medium">Field</span>
                            <select
                                aria-label="Search field"
                                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                                value={searchField}
                                onChange={(event) => setSearchField(event.target.value as AdminUserSearchField)}
                            >
                                <option value="all">All</option>
                                <option value="email">Email</option>
                                <option value="name">Name</option>
                            </select>
                        </label>
                        <Button className="self-end" disabled={loadingList} type="submit">
                            <Search />
                            Search
                        </Button>
                    </form>
                    {error ? (
                        <p className="m-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                </Card>

                <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,0.7fr)]">
                    <Card className="min-w-0 gap-0 rounded-lg shadow-panel">
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 pb-3">
                            <div>
                                <strong className="block">Users</strong>
                                <span className="text-sm text-muted-foreground">
                                    {listData.total} total
                                </span>
                            </div>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Button
                                    disabled={loadingList || listData.offset === 0}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                    onClick={() => void reloadUsers(Math.max(0, listData.offset - listData.limit))}
                                >
                                    Previous
                                </Button>
                                <span>Page {currentPage} of {totalPages}</span>
                                <Button
                                    disabled={loadingList || listData.offset + listData.limit >= listData.total}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                    onClick={() => void reloadUsers(listData.offset + listData.limit)}
                                >
                                    Next
                                </Button>
                            </div>
                        </div>
                        <div className="min-w-0 overflow-hidden">
                            <table className="w-full table-fixed border-collapse text-left text-sm">
                                <thead className="bg-muted/55 text-muted-foreground">
                                    <tr>
                                        <th className="w-[34%] px-4 py-2 font-medium">User</th>
                                        <th className="w-[21%] px-4 py-2 font-medium">Status</th>
                                        <th className="w-[20%] px-4 py-2 font-medium">Profile</th>
                                        <th className="w-[16%] px-4 py-2 font-medium">Data</th>
                                        <th className="w-[9%] px-4 py-2 font-medium">Sessions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {listData.users.map((user) => (
                                        <UserRow
                                            key={user.id}
                                            user={user}
                                            selected={selectedDetail?.user.id === user.id}
                                            loading={loadingDetailUserId === user.id}
                                            onSelect={() => void selectUser(user.id)}
                                        />
                                    ))}
                                    {listData.users.length === 0 ? (
                                        <tr>
                                            <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                                                No users found.
                                            </td>
                                        </tr>
                                    ) : null}
                                </tbody>
                            </table>
                        </div>
                    </Card>

                    <AdminDetailPanel
                        actionBusy={actionBusy}
                        banReason={banReason}
                        currentUserId={viewer.id}
                        detail={selectedDetail}
                        onBan={handleBan}
                        onBanReasonChange={setBanReason}
                        onRevokeAllSessions={handleRevokeAllSessions}
                        onRevokeSession={handleRevokeSession}
                        onUnban={handleUnban}
                    />
                </div>
            </div>
        </main>
    );
}

function AdminAccessDenied({ viewerName }: { viewerName: string }) {
    return (
        <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
            <Card className="grid w-[min(100%,32rem)] gap-4 rounded-lg px-4 text-center shadow-panel">
                <ShieldOff className="mx-auto size-9 text-muted-foreground" />
                <div className="grid gap-1">
                    <h1 className="m-0 text-2xl font-bold">Admin access required</h1>
                    <p className="m-0 text-muted-foreground">
                        {viewerName} does not have access to admin tools.
                    </p>
                </div>
                <Button asChild className="mx-auto w-fit" variant="outline">
                    <Link to="/">Back to Goldshelf</Link>
                </Button>
            </Card>
        </main>
    );
}

function UserRow({
    loading,
    onSelect,
    selected,
    user
}: {
    loading: boolean;
    onSelect: () => void;
    selected: boolean;
    user: AdminUserSummary;
}) {
    function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
        }
    }

    return (
        <tr
            aria-busy={loading}
            aria-selected={selected}
            className={`${selected ? "bg-accent/35" : "border-t border-border"} cursor-pointer outline-none transition-colors hover:bg-muted/55 focus-visible:bg-muted/70`}
            role="button"
            tabIndex={0}
            onClick={onSelect}
            onKeyDown={handleKeyDown}
        >
            <td className="min-w-0 px-4 py-3 align-top">
                <strong className="block truncate">{user.email}</strong>
                <span className="block truncate text-muted-foreground">{user.name}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{user.id}</span>
            </td>
            <td className="min-w-0 px-4 py-3 align-top">
                <div className="flex flex-wrap gap-1.5">
                    <StatusPill tone={user.banned ? "danger" : "default"}>
                        {user.banned ? "Banned" : "Active"}
                    </StatusPill>
                    <StatusPill tone={user.role.includes("admin") ? "accent" : "muted"}>
                        {user.role}
                    </StatusPill>
                    {user.emailVerified ? <StatusPill tone="muted">Verified</StatusPill> : null}
                </div>
            </td>
            <td className="min-w-0 px-4 py-3 align-top">
                {user.profileSlug ? (
                    <div className="min-w-0">
                        <span className="block truncate">{user.profileSlug}</span>
                        <span className="block truncate text-muted-foreground">
                            {user.profileIsPublic ? "Public" : "Private"}
                        </span>
                    </div>
                ) : (
                    <span className="text-muted-foreground">No profile</span>
                )}
            </td>
            <td className="px-4 py-3 align-top text-muted-foreground">
                {user.categoryCount} categories<br />
                {user.entryCount} entries<br />
                {user.queuedEntryCount} queued
            </td>
            <td className="px-4 py-3 align-top">{loading ? "..." : user.activeSessionCount}</td>
        </tr>
    );
}

function AdminDetailPanel({
    actionBusy,
    banReason,
    currentUserId,
    detail,
    onBan,
    onBanReasonChange,
    onRevokeAllSessions,
    onRevokeSession,
    onUnban
}: {
    actionBusy: string | null;
    banReason: string;
    currentUserId: string;
    detail: AdminUserDetailData | null;
    onBan: (event: FormEvent<HTMLFormElement>) => void;
    onBanReasonChange: (value: string) => void;
    onRevokeAllSessions: () => void;
    onRevokeSession: (sessionId: string) => void;
    onUnban: () => void;
}) {
    if (!detail) {
        return (
            <Card className="grid min-h-[20rem] place-items-center rounded-lg px-4 text-center shadow-panel">
                <div className="grid gap-2">
                    <Shield className="mx-auto size-8 text-muted-foreground" />
                    <strong>Select a user</strong>
                    <span className="text-sm text-muted-foreground">User sessions and support actions appear here.</span>
                </div>
            </Card>
        );
    }

    const user = detail.user;
    const isSelf = user.id === currentUserId;
    const canBan = !user.banned && !isSelf;

    return (
        <Card className="min-w-0 rounded-lg px-4 shadow-panel">
            <div className="grid gap-1 border-b border-border pb-3">
                <strong className="truncate">{user.email}</strong>
                <span className="truncate text-sm text-muted-foreground">{user.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{user.id}</span>
            </div>

            <div className="grid gap-3">
                <div className="flex flex-wrap gap-1.5">
                    <StatusPill tone={user.banned ? "danger" : "default"}>
                        {user.banned ? "Banned" : "Active"}
                    </StatusPill>
                    <StatusPill tone={user.role.includes("admin") ? "accent" : "muted"}>{user.role}</StatusPill>
                    <StatusPill tone="muted">Joined {formatDate(user.createdAt)}</StatusPill>
                </div>

                {user.banned ? (
                    <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
                        <strong className="text-destructive">Ban reason</strong>
                        <span>{user.banReason ?? "No reason recorded"}</span>
                        <Button
                            disabled={Boolean(actionBusy)}
                            type="button"
                            variant="outline"
                            onClick={onUnban}
                        >
                            <ShieldOff />
                            Unban User
                        </Button>
                    </div>
                ) : (
                    <form className="grid gap-2 rounded-md border border-border p-3" onSubmit={onBan}>
                        <label className="grid gap-1">
                            <span className="text-sm font-medium">Ban reason</span>
                            <Input
                                aria-label="Ban reason"
                                disabled={!canBan || Boolean(actionBusy)}
                                maxLength={500}
                                placeholder={isSelf ? "You cannot ban yourself" : "Required"}
                                value={banReason}
                                onChange={(event) => onBanReasonChange(event.target.value)}
                            />
                        </label>
                        <Button
                            disabled={!canBan || Boolean(actionBusy) || !banReason.trim()}
                            type="submit"
                            variant="destructive"
                        >
                            <Ban />
                            Ban User
                        </Button>
                    </form>
                )}

                <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-2">
                        <strong>Sessions</strong>
                        <Button
                            disabled={Boolean(actionBusy) || detail.sessions.length === 0}
                            size="sm"
                            type="button"
                            variant="outline"
                            onClick={onRevokeAllSessions}
                        >
                            <XCircle />
                            Revoke All
                        </Button>
                    </div>
                    <div className="grid gap-2">
                        {detail.sessions.map((session) => (
                            <SessionRow
                                key={session.id}
                                busy={actionBusy === `session:${session.id}`}
                                session={session}
                                onRevoke={() => onRevokeSession(session.id)}
                            />
                        ))}
                        {detail.sessions.length === 0 ? (
                            <p className="m-0 rounded-md border border-border px-3 py-4 text-sm text-muted-foreground">
                                No active sessions.
                            </p>
                        ) : null}
                    </div>
                </div>
            </div>
        </Card>
    );
}

function SessionRow({
    busy,
    onRevoke,
    session
}: {
    busy: boolean;
    onRevoke: () => void;
    session: AdminSessionSummary;
}) {
    return (
        <div className="grid gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <strong className="block font-mono text-xs">{session.id.slice(0, 14)}</strong>
                    <span className="block text-muted-foreground">Expires {formatDateTime(session.expiresAt)}</span>
                </div>
                <Button disabled={busy} size="sm" type="button" variant="outline" onClick={onRevoke}>
                    <RotateCcw />
                    Revoke
                </Button>
            </div>
            <div className="min-w-0 text-muted-foreground">
                <span className="block truncate">{session.ipAddress ?? "Unknown IP"}</span>
                <span className="block truncate">{session.userAgent ?? "Unknown user agent"}</span>
            </div>
        </div>
    );
}

function StatusPill({
    children,
    tone
}: {
    children: ReactNode;
    tone: "accent" | "danger" | "default" | "muted";
}) {
    const className = {
        accent: "border-accent bg-accent text-accent-foreground",
        danger: "border-destructive/30 bg-destructive/10 text-destructive",
        default: "border-primary/30 bg-primary/15 text-foreground",
        muted: "border-border bg-muted text-muted-foreground"
    }[tone];

    return (
        <span className={`inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs ${className}`}>
            {children}
        </span>
    );
}

function formatDate(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric"
    }).format(new Date(timestamp));
}

function formatDateTime(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(new Date(timestamp));
}
