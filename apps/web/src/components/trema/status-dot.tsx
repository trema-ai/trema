import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "#web/lib/utils.ts";

const statusDotVariants = cva("inline-block size-1.5 shrink-0 rounded-full", {
  variants: {
    tone: {
      go: "bg-go",
      wait: "bg-wait",
      run: "animate-pulse bg-moss",
      destructive: "bg-destructive",
      neutral: "bg-muted-foreground",
    },
  },
  defaultVariants: {
    tone: "neutral",
  },
});

type StatusDotProps = React.ComponentProps<"span"> & VariantProps<typeof statusDotVariants>;

function StatusDot({ className, tone = "neutral", ...props }: StatusDotProps) {
  return (
    <span
      data-slot="status-dot"
      data-tone={tone}
      className={cn(statusDotVariants({ tone }), className)}
      {...props}
    />
  );
}

export { StatusDot, type StatusDotProps, statusDotVariants };
