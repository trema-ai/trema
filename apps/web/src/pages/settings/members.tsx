import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, RotateCcw, UsersRound, UserX, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { CopyButton } from "#/components/trema/copy-button.tsx";
import { DataTable, type DataTableColumn } from "#/components/trema/data-table.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "#/components/ui/alert-dialog.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import { useAuthenticatedSession } from "#/pages/home.tsx";

type Role = "owner" | "admin" | "member" | "viewer";

type Member = {
  principal: { id: string; displayName: string; email: string | null };
  role: Role;
  status: "active" | "deactivated";
  joinedAt: string;
};

type Invite = {
  id: string;
  role: Role;
  scopeId: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
};

const roleDescriptions: Record<Role, string> = {
  owner: "Everything an admin can, plus organization administration.",
  admin: "Manage members, connectors, policies, and organization content.",
  member: "Read and edit content, and install skills where allowed.",
  viewer: "Read organization content.",
};

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function memberQueryKey() {
  return orpc.members.list.queryOptions({}).queryKey;
}

function inviteQueryKey() {
  return orpc.members.invites.list.queryOptions().queryKey;
}

export function SettingsMembersPage() {
  const session = useAuthenticatedSession();
  const members = useQuery(orpc.members.list.queryOptions({}));
  const invites = useQuery(orpc.members.invites.list.queryOptions());
  const rows = (members.data ?? []) as Member[];
  const inviteRows = (invites.data ?? []) as Invite[];
  const columns: DataTableColumn<Member>[] = [
    {
      key: "name",
      header: "Name",
      render: (member) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{member.principal.displayName}</span>
          {member.status === "deactivated" ? <Badge variant="secondary">Deactivated</Badge> : null}
        </div>
      ),
    },
    {
      key: "email",
      header: "Email",
      render: (member) => member.principal.email ?? "Unavailable",
    },
    {
      key: "role",
      header: "Role",
      render: (member) =>
        member.principal.id === session.membership.principal.id ||
        member.status === "deactivated" ? (
          <span className="capitalize">{member.role}</span>
        ) : (
          <MemberRoleSelect member={member} />
        ),
    },
    {
      key: "joined",
      header: "Joined",
      render: (member) => <RelativeTime date={member.joinedAt} />,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      width: "3rem",
      align: "right",
      render: (member) =>
        member.principal.id === session.membership.principal.id ? null : (
          <MemberActions member={member} />
        ),
    },
  ];

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Members"
        description="Manage organization members, roles, and invitations."
        actions={<InviteMemberDialog />}
      />
      {members.error || invites.error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{members.error?.message ?? invites.error?.message}</AlertDescription>
        </Alert>
      ) : null}

      <section>
        <h2 className="text-chrome font-medium">Organization members</h2>
        <p className="mt-0.5 text-meta text-muted-foreground">
          Roles control access across the organization.
        </p>
        <DataTable
          className="mt-2"
          columns={columns}
          rows={rows}
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
      </section>

      {!invites.isPending && inviteRows.length > 0 ? <PendingInvites invites={inviteRows} /> : null}
    </main>
  );
}

function MemberRoleSelect({ member }: { member: Member }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (role: Role) =>
      rpcClient.members.setRole({ principalId: member.principal.id, role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: memberQueryKey() });
      toast.success("Member role updated");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  return (
    <Select
      value={member.role}
      disabled={mutation.isPending}
      onValueChange={(role) => mutation.mutate(role as Role)}
    >
      <SelectTrigger className="w-28" aria-label={`Role for ${member.principal.displayName}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(roleDescriptions) as Role[]).map((role) => (
          <SelectItem key={role} value={role} className="capitalize">
            {role}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MemberActions({ member }: { member: Member }) {
  const queryClient = useQueryClient();
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const deactivate = useMutation({
    mutationFn: () => rpcClient.members.deactivate({ id: member.principal.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: memberQueryKey() });
      toast.success("Member deactivated");
      setConfirmDeactivate(false);
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const reactivate = useMutation({
    mutationFn: () => rpcClient.members.reactivate({ id: member.principal.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: memberQueryKey() });
      toast.success("Member reactivated");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${member.principal.displayName}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {member.status === "deactivated" ? (
            <DropdownMenuItem disabled={reactivate.isPending} onSelect={() => reactivate.mutate()}>
              <RotateCcw />
              Reactivate
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDeactivate(true)}>
              <UserX />
              Deactivate
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmDeactivate} onOpenChange={setConfirmDeactivate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {member.principal.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Sign-in will be blocked, service credentials will be revoked, and identity links will
              be removed. Nothing this member created will be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deactivate.isPending}
              onClick={() => deactivate.mutate()}
            >
              {deactivate.isPending ? "Deactivating…" : "Deactivate member"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function InviteMemberDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    mutationFn: (inviteRole: Role) => rpcClient.members.invites.create({ role: inviteRole }),
    onSuccess: async (invite) => {
      await queryClient.invalidateQueries({ queryKey: inviteQueryKey() });
      setLink(invite.link);
      toast.success("Invite created");
    },
  });

  function reset() {
    setRole("member");
    setLink(undefined);
    setError(undefined);
    mutation.reset();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      await mutation.mutateAsync(role);
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        Invite member
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent>
          {link ? (
            <>
              <DialogHeader>
                <DialogTitle>Invite link created</DialogTitle>
                <DialogDescription>
                  Share this link with the person you want to invite.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="invite-link">Join link</Label>
                <div className="flex items-center rounded-md border bg-muted/30 pr-1">
                  <Input
                    id="invite-link"
                    value={link}
                    readOnly
                    className="border-0 bg-transparent"
                  />
                  <CopyButton value={link} />
                </div>
                <p className="text-meta text-muted-foreground">
                  This link is shown only once. Create another invite if you lose it.
                </p>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button>Done</Button>
                </DialogClose>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={submit} className="contents">
              <DialogHeader>
                <DialogTitle>Invite member</DialogTitle>
                <DialogDescription>
                  Create a single-use link that expires in seven days.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="invite-role">Role</Label>
                <Select value={role} onValueChange={(value) => setRole(value as Role)}>
                  <SelectTrigger id="invite-role" className="w-full" autoFocus>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(roleDescriptions) as Role[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        <span className="capitalize">{value}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-meta text-muted-foreground">{roleDescriptions[role]}</p>
              </div>
              {error ? <p className="text-meta text-destructive">{error}</p> : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? "Creating…" : "Create invite"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function PendingInvites({ invites }: { invites: Invite[] }) {
  const columns: DataTableColumn<Invite>[] = [
    {
      key: "role",
      header: "Role",
      render: (invite) => <span className="capitalize">{invite.role}</span>,
    },
    { key: "invited-by", header: "Invited by", render: (invite) => invite.invitedBy },
    {
      key: "created",
      header: "Created",
      render: (invite) => <RelativeTime date={invite.createdAt} />,
    },
    {
      key: "expires",
      header: "Expires",
      render: (invite) => <RelativeTime date={invite.expiresAt} />,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      width: "3rem",
      align: "right",
      render: (invite) => <RevokeInviteButton invite={invite} />,
    },
  ];

  return (
    <section className="mt-8">
      <h2 className="text-chrome font-medium">Pending invites</h2>
      <p className="mt-0.5 text-meta text-muted-foreground">
        Unused invite links that have not expired.
      </p>
      <DataTable className="mt-2" columns={columns} rows={invites} rowKey={(invite) => invite.id} />
    </section>
  );
}

function RevokeInviteButton({ invite }: { invite: Invite }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => rpcClient.members.invites.revoke({ id: invite.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteQueryKey() });
      toast.success("Invite revoked");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Revoke invite">
          <X />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke invite?</AlertDialogTitle>
          <AlertDialogDescription>
            This invite link will stop working. You cannot restore a revoked invite.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Revoking…" : "Revoke invite"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
