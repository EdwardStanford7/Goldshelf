import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/format";

/** Shown for unmatched URLs (router `defaultNotFoundComponent`). */
export function DefaultNotFound() {
    return (
        <RouteFallbackShell
            title="Page not found"
            body="The page you’re looking for doesn’t exist or has moved."
        />
    );
}

/** Shown when a route throws (router `defaultErrorComponent`). */
export function DefaultErrorComponent({ error }: { error: Error }) {
    return (
        <RouteFallbackShell
            title="Something went wrong"
            body={errorMessage(error) || "An unexpected error occurred. Please try again."}
        />
    );
}

function RouteFallbackShell({ title, body }: { title: string; body: string }) {
    return (
        <main className="grid min-h-screen place-items-center bg-background p-8 text-foreground">
            <Card className="grid w-[min(100%,32rem)] gap-4 px-4 text-center shadow-panel">
                <h1 className="text-2xl font-bold">{title}</h1>
                <p className="text-muted-foreground">{body}</p>
                <Button asChild className="mx-auto w-fit">
                    <Link to="/">Back to Goldshelf</Link>
                </Button>
            </Card>
        </main>
    );
}
