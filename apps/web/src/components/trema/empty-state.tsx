import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
};

function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center"
    >
      {Icon ? <Icon aria-hidden="true" className="mb-2 size-8 text-muted-foreground/60" /> : null}
      <div className="text-chrome font-medium">{title}</div>
      {description ? <p className="text-meta text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
