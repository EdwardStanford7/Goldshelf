import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { MarketingLanding } from "@/components/marketing/MarketingLanding";
import { loadHome } from "@/server/dashboard";
import { loadPublicExplore } from "@/server/explore";

export const Route = createFileRoute("/")({
    head: () => ({
        links: [
            { rel: "canonical", href: "https://goldshelf.net/" }
        ]
    }),
    validateSearch: (search: Record<string, unknown>): { workspace?: "queue" } => (
        search.workspace === "queue" ? { workspace: "queue" } : {}
    ),
    loader: async () => {
        const home = await loadHome();
        // The marketing page is the only consumer of the anonymous directory.
        // Avoid its global aggregation for every signed-in dashboard navigation.
        const trendingProfiles = home.dashboard && home.user ? [] : await loadPublicExplore();
        return { ...home, trendingProfiles };
    },
    component: Home
});

function Home() {
    const { dashboard, user, trendingProfiles } = Route.useLoaderData();
    const { workspace } = Route.useSearch();

    if (!dashboard || !user) {
        return <MarketingLanding trendingProfiles={trendingProfiles} />;
    }

    return (
        <Dashboard
            initialDashboard={dashboard}
            initialWorkspace={workspace ?? "rankings"}
            userIsAdmin={user.isAdmin}
            userImage={user.image}
            userName={user.name}
        />
    );
}
