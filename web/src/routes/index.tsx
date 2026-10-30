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
    loader: async () => {
        const [home, trendingProfiles] = await Promise.all([loadHome(), loadPublicExplore()]);
        return { ...home, trendingProfiles };
    },
    component: Home
});

function Home() {
    const { dashboard, user, trendingProfiles } = Route.useLoaderData();

    if (!dashboard || !user) {
        return <MarketingLanding trendingProfiles={trendingProfiles} />;
    }

    return (
        <Dashboard
            initialDashboard={dashboard}
            userIsAdmin={user.isAdmin}
            userImage={user.image}
            userName={user.name}
        />
    );
}
