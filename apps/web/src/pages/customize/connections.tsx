import { useQuery } from "@tanstack/react-query";
import { Cable } from "lucide-react";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { orpc } from "#/lib/api.ts";
import type { CatalogEntry, ConnectorBody, Item, Scope } from "#/pages/customize/types.ts";

export function ConnectionsTab({
  items,
  scope,
  loading,
}: {
  items: Item[];
  scope: Scope;
  loading: boolean;
}) {
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const entries = (catalog.data ?? []) as CatalogEntry[];
  const names = new Map(entries.map((entry) => [entry.key, entry.displayName]));
  const installations = items.filter(
    (item) => item.kind === "connector" && item.status !== "archived",
  );

  if (loading || catalog.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-chrome font-medium text-muted-foreground">Connections in this scope</h3>
        <p className="mt-1 text-meta text-muted-foreground">
          {scope.kind === "personal"
            ? "Personal connection setup belongs in the member connections page."
            : "The agent uses these provider bindings in shared sessions. Admins manage them in settings."}
        </p>
      </div>
      {installations.length === 0 ? (
        <div className="rounded-md border bg-card">
          <EmptyState
            icon={Cable}
            title="No connections in this scope"
            description={
              scope.kind === "personal"
                ? "No provider account is connected to this personal scope."
                : "An admin can add a connector from the admin settings area."
            }
          />
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-md border bg-card">
          {installations.map((item) => {
            const body = item.body as ConnectorBody;
            return (
              <div key={item.id} className="px-4 py-3">
                <p className="font-medium text-chrome">
                  {names.get(body.catalogKey) ?? item.title}
                </p>
                <p className="mt-0.5 text-meta text-muted-foreground">
                  {body.enabledTools === "all"
                    ? "All tools"
                    : `${body.enabledTools.length} enabled tools`}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
