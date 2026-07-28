/// <reference types="vite/client" />

import type { ReactNode } from "react";
import { useEffect } from "react";
import {
    HeadContent,
    Outlet,
    ScriptOnce,
    Scripts,
    createRootRoute
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { applyThemeMode, readInitialThemeMode, themeInitScript } from "@/lib/theme";
import "../styles/global.css";

const SITE_DESCRIPTION = "Build personal ranked lists for movies, books, games, and more by comparing choices one at a time.";

export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { name: "application-name", content: "Goldshelf" },
            { name: "apple-mobile-web-app-title", content: "Goldshelf" },
            { name: "description", content: SITE_DESCRIPTION },
            { name: "author", content: "Edward Stanford" },
            { name: "theme-color", content: "#1c1409" },
            { property: "og:site_name", content: "Goldshelf" },
            { property: "og:type", content: "website" },
            { property: "og:title", content: "Goldshelf" },
            { property: "og:description", content: SITE_DESCRIPTION },
            { property: "og:url", content: "https://goldshelf.net/" },
            { name: "twitter:card", content: "summary" },
            { name: "twitter:title", content: "Goldshelf" },
            { name: "twitter:description", content: SITE_DESCRIPTION },
            { title: "Goldshelf" }
        ],
        links: [
            { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
            { rel: "apple-touch-icon", href: "/favicon.svg" },
            { rel: "manifest", href: "/site.webmanifest" }
        ]
    }),
    component: RootComponent
});

function RootComponent() {
    useEffect(() => {
        return applyThemeMode(readInitialThemeMode());
    }, []);

    // Marks client-side hydration so e2e tests can wait before interacting.
    useEffect(() => {
        document.documentElement.dataset.hydrated = "true";
    }, []);

    return (
        <RootDocument>
            <Outlet />
        </RootDocument>
    );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <ScriptOnce>{themeInitScript}</ScriptOnce>
                <HeadContent />
            </head>
            <body>
                {children}
                <Toaster position="bottom-left" />
                <Scripts />
            </body>
        </html>
    );
}
