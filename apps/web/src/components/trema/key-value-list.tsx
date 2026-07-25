import type * as React from "react";

import { cn } from "#web/lib/utils.ts";

type KeyValueItem = {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
};

type KeyValueListProps = React.ComponentProps<"dl"> & {
  items: KeyValueItem[];
};

function KeyValueList({ items, className, ...props }: KeyValueListProps) {
  return (
    <dl data-slot="key-value-list" className={cn("space-y-2", className)} {...props}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-4">
          <dt className="min-w-30 shrink-0 text-meta text-muted-foreground">{item.label}</dt>
          <dd className={cn("min-w-0 flex-1 text-chrome", item.mono && "font-mono text-meta")}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export { type KeyValueItem, KeyValueList, type KeyValueListProps };
