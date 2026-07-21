import type * as React from "react";

import { cn } from "#/lib/utils.ts";

type MonoLabelProps = React.ComponentProps<"span">;

function MonoLabel({ className, ...props }: MonoLabelProps) {
  return <span data-slot="mono-label" className={cn("mono-label", className)} {...props} />;
}

export { MonoLabel, type MonoLabelProps };
