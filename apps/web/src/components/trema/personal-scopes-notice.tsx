import { MessageSquareOff } from "lucide-react";
import { Link } from "react-router";

import { cn } from "#web/lib/utils.ts";

type PersonalScopesNoticeProps = {
  /** Whether the viewer can change the policy (owners and admins). */
  canManage?: boolean;
  className?: string;
};

/**
 * What renders in place of the composer when the organization has personal
 * scopes turned off: chat runs in the member's personal scope, so there is
 * nothing to type into. A structured explanation — what it means, who can
 * change it — not a disabled input (web 06 calls this a product moment).
 */
function PersonalScopesNotice({ canManage = false, className }: PersonalScopesNoticeProps) {
  return (
    <div
      data-slot="personal-scopes-notice"
      className={cn("rounded-lg border bg-card p-4", className)}
    >
      <div className="flex items-center gap-2">
        <MessageSquareOff className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-chrome font-medium">Chat is turned off for this organization</p>
      </div>
      <p className="mt-1.5 text-meta text-muted-foreground">
        Chatting with the agent runs in your personal scope, and this organization has personal
        scopes turned off. Your existing chats are kept and come back when the policy changes.
      </p>
      <p className="mt-1.5 text-meta text-muted-foreground">
        {canManage ? (
          <>
            You can turn personal scopes on under{" "}
            <Link to="/settings/scopes" className="text-moss hover:underline">
              Settings, Scopes
            </Link>
            .
          </>
        ) : (
          <>An organization owner or admin can turn personal scopes back on.</>
        )}
      </p>
    </div>
  );
}

export { PersonalScopesNotice, type PersonalScopesNoticeProps };
