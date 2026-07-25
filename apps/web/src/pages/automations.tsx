import { Workflow } from "lucide-react";

import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";

export function AutomationsPage() {
  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <PageHeader title="Automations" description="Run repeatable work on a schedule." />
      <EmptyState
        icon={Workflow}
        title="No automations yet"
        description="Automations will appear here after they are created."
      />
    </main>
  );
}
