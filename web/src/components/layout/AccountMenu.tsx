import { useEffect, useState } from "react";
import { Download, LogOut, Palette, Settings, Shield, Upload, User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuCheckboxItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth-client";
import { hasStoredImage } from "@/lib/images";
import type { ThemeMode } from "@/lib/theme";
import type { QueueSettings } from "@/lib/types";

export function AccountMenu({
    busy,
    contentAlign = "end",
    listLocked,
    settings,
    onExport,
    onOpenImport,
    onOpenProfile,
    onSaveSettings,
    onShowEntryPercentileChange,
    onThemeChange,
    showEntryPercentile,
    themeMode,
    triggerClassName,
    userIsAdmin,
    userImage,
    userImageVersion,
    userName
}: {
    busy: boolean;
    contentAlign?: "start" | "center" | "end";
    listLocked: boolean;
    settings: QueueSettings;
    onExport: () => Promise<void>;
    onOpenImport: () => void;
    onOpenProfile: () => void;
    onSaveSettings: (settings: QueueSettings, options?: { quiet?: boolean }) => Promise<void>;
    onShowEntryPercentileChange: (showEntryPercentile: boolean) => void;
    onThemeChange: (themeMode: ThemeMode) => void;
    showEntryPercentile: boolean;
    themeMode: ThemeMode;
    triggerClassName?: string;
    userIsAdmin: boolean;
    userImage: string | null;
    userImageVersion: number;
    userName: string;
}) {
    const [enabled, setEnabled] = useState(settings.enabled);
    const [promptForMissingImages, setPromptForMissingImages] = useState(settings.promptForMissingImages);
    const [randomizeReadyEntries, setRandomizeReadyEntries] = useState(settings.randomizeReadyEntries);
    const [quickSaving, setQuickSaving] = useState(false);
    const importDisabled = busy || listLocked;

    useEffect(() => {
        setEnabled(settings.enabled);
        setPromptForMissingImages(settings.promptForMissingImages);
        setRandomizeReadyEntries(settings.randomizeReadyEntries);
    }, [
        settings.enabled,
        settings.promptForMissingImages,
        settings.randomizeReadyEntries
    ]);

    async function saveSettingsImmediately(nextSettings: QueueSettings) {
        setQuickSaving(true);
        try {
            await onSaveSettings(nextSettings, { quiet: true });
        } finally {
            setQuickSaving(false);
        }
    }

    async function updateToggle<K extends "enabled" | "promptForMissingImages" | "randomizeReadyEntries">(
        key: K,
        value: QueueSettings[K]
    ) {
        if (key === "enabled") {
            setEnabled(Boolean(value));
        } else if (key === "promptForMissingImages") {
            setPromptForMissingImages(Boolean(value));
        } else {
            setRandomizeReadyEntries(Boolean(value));
        }

        await saveSettingsImmediately({
            ...settings,
            enabled: key === "enabled" ? Boolean(value) : enabled,
            promptForMissingImages: key === "promptForMissingImages" ? Boolean(value) : promptForMissingImages,
            randomizeReadyEntries: key === "randomizeReadyEntries" ? Boolean(value) : randomizeReadyEntries
        });
    }

    return (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <button
                    aria-label="Account menu"
                    className={triggerClassName ?? "ml-auto flex h-[2.7rem] w-[2.7rem] flex-none items-center justify-center rounded-full p-0"}
                    type="button"
                >
                    <AccountAvatar imageKey={userImage} imageVersion={userImageVersion} />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={contentAlign} className="w-56">
                <DropdownMenuItem
                    aria-label={`Open ${userName} account`}
                    className="flex items-center gap-3 px-1.5 py-2"
                    onSelect={onOpenProfile}
                >
                    <AccountAvatar imageKey={userImage} imageVersion={userImageVersion} large />
                    <div className="min-w-0">
                        <strong className="block min-w-0 truncate">{userName}</strong>
                        <span className="mt-[0.1rem] block text-[0.82rem] font-normal text-muted-foreground">Account</span>
                    </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onOpenProfile}>
                    <User />Profile
                </DropdownMenuItem>
                {userIsAdmin ? (
                    <DropdownMenuItem onSelect={() => window.location.assign("/admin")}>
                        <Shield />Admin
                    </DropdownMenuItem>
                ) : null}
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Settings />Settings
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-64 max-[720px]:w-[min(14rem,calc(100vw-1rem))] max-[720px]:data-[side=right]:-translate-x-[calc(100%-0.5rem)]">
                        <DropdownMenuCheckboxItem
                            checked={promptForMissingImages}
                            disabled={busy || quickSaving}
                            onCheckedChange={(value) => void updateToggle("promptForMissingImages", value)}
                            onSelect={(event) => event.preventDefault()}
                        >
                            Image prompts
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                            checked={enabled}
                            disabled={busy || quickSaving}
                            onCheckedChange={(value) => void updateToggle("enabled", value)}
                            onSelect={(event) => event.preventDefault()}
                        >
                            Queue entries
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                            checked={randomizeReadyEntries}
                            disabled={busy || quickSaving}
                            onCheckedChange={(value) => void updateToggle("randomizeReadyEntries", value)}
                            onSelect={(event) => event.preventDefault()}
                        >
                            Randomize queue ranking
                        </DropdownMenuCheckboxItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Palette />Appearance
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-56 max-[720px]:w-[min(14rem,calc(100vw-1rem))] max-[720px]:data-[side=right]:-translate-x-[calc(100%-0.5rem)]">
                        <DropdownMenuRadioGroup
                            value={themeMode}
                            onValueChange={(value) => onThemeChange(value as ThemeMode)}
                        >
                            <DropdownMenuRadioItem value="light">Light mode</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="dark">Dark mode</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuCheckboxItem
                            checked={showEntryPercentile}
                            onCheckedChange={(value) => onShowEntryPercentileChange(Boolean(value))}
                            onSelect={(event) => event.preventDefault()}
                        >
                            Show entry percentiles
                        </DropdownMenuCheckboxItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem disabled={importDisabled} onSelect={onOpenImport}>
                    <Upload />Import xlsx
                </DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onSelect={() => void onExport()}>
                    <Download />Export xlsx
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void signOut().then(() => window.location.assign("/"))}
                >
                    <LogOut />Sign Out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function AccountAvatar({
    imageKey,
    imageVersion,
    large = false
}: {
    imageKey: string | null;
    imageVersion: number;
    large?: boolean;
}) {
    const src = hasStoredImage(imageKey)
        ? `/api/profile-image?v=${encodeURIComponent(`${imageVersion}:${imageKey}`)}`
        : null;

    return (
        <Avatar aria-hidden="true" className={large ? "size-[2.55rem]" : "size-[2.4rem]"}>
            {src ? <AvatarImage alt="" decoding="async" src={src} /> : null}
            <AvatarFallback className="border border-avatar-line [background:radial-gradient(circle_at_50%_38%,var(--avatar-ink)_0_21%,transparent_22%),radial-gradient(circle_at_50%_110%,var(--avatar-ink)_0_39%,transparent_40%),var(--avatar-bg)]" />
        </Avatar>
    );
}
