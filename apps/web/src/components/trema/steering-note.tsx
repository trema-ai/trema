import type * as React from "react";

import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { cn } from "#/lib/utils.ts";

type SteeringNoteProps = {
  author: string;
  at: Date | string;
  children: React.ReactNode;
  className?: string;
};

function SteeringNote({ author, at, children, className }: SteeringNoteProps) {
  return (
    <div data-slot="steering-note" className={cn("border-l-2 border-moss pl-3", className)}>
      <div className="flex items-center gap-2 text-meta text-muted-foreground">
        <span className="font-medium text-foreground">{author}</span>
        <RelativeTime date={at} />
      </div>
      <p className="mt-0.5 text-chat">{children}</p>
    </div>
  );
}

export { SteeringNote, type SteeringNoteProps };
