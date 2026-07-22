import { useQuery } from "@tanstack/react-query";
import { UsersRound } from "lucide-react";

import { DataTable, type DataTableColumn } from "#/components/trema/data-table.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { orpc } from "#/lib/api.ts";

type Member = {
  principal: { id: string; displayName: string; email: string | null };
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: string;
};

const columns: DataTableColumn<Member>[] = [
  {
    key: "name",
    header: "Name",
    render: (member) => <span className="font-medium">{member.principal.displayName}</span>,
  },
  {
    key: "email",
    header: "Email",
    render: (member) => member.principal.email ?? "Unavailable",
  },
  {
    key: "role",
    header: "Role",
    render: (member) => <span className="capitalize">{member.role}</span>,
  },
  {
    key: "joined",
    header: "Joined",
    render: (member) => <RelativeTime date={member.joinedAt} />,
  },
];

export function SettingsMembersPage() {
  const members = useQuery(orpc.members.list.queryOptions({}));
  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader title="Members" description="View organization members and roles." />
      {members.error ? (
        <Alert variant="destructive">
          <AlertDescription>{members.error.message}</AlertDescription>
        </Alert>
      ) : (
        <DataTable
          columns={columns}
          rows={(members.data ?? []) as Member[]}
          rowKey={(member) => member.principal.id}
          loading={members.isPending}
          empty={
            <EmptyState
              icon={UsersRound}
              title="No members"
              description="This organization has no members to show."
            />
          }
        />
      )}
    </main>
  );
}
