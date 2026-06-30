import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { MarketingLanding } from "@/components/marketing/MarketingLanding";
import { loadHome } from "@/server/dashboard";

export const Route = createFileRoute("/")({
    head: () => ({
        links: [
            { rel: "canonical", href: "https://goldshelf.net/" }
        ]
    }),
    loader: () => loadHome(),
    component: Home
});

function Home() {
    const { dashboard, user } = Route.useLoaderData();

    if (!dashboard || !user) {
        return <MarketingLanding />;
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
