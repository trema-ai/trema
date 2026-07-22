import { LibraryBig } from "lucide-react";

import { EmptyState } from "#/components/trema/empty-state.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";

export function ContextPage() {
  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <PageHeader title="Context" description="Review what the agent knows and may use." />
      <EmptyState
        icon={LibraryBig}
        title="No context items yet"
        description="Context items will appear here after they are added."
      />
    </main>
  );
}
