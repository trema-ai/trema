import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import type * as React from "react";
import { memo } from "react";
import remarkGfm from "remark-gfm";

import { CopyButton } from "#web/components/trema/copy-button.tsx";
import { markdownProseComponents } from "#web/components/trema/markdown.tsx";
import { cn } from "#web/lib/utils.ts";

/*
 * Markdown renderer for assistant messages. Prose styles are written by
 * hand against the app tokens; there is no typography plugin.
 */

function CodeHeader({ language, code }: CodeHeaderProps) {
  return (
    <div
      data-slot="code-header"
      className="flex items-center justify-between rounded-t-md border-b bg-muted px-3 py-1"
    >
      <span className="text-chrome font-medium text-muted-foreground">{language ?? "code"}</span>
      <CopyButton value={code} aria-label="Copy code" />
    </div>
  );
}

function Code({ className, ...props }: React.ComponentPropsWithoutRef<"code">) {
  const isCodeBlock = useIsMarkdownCodeBlock();

  return (
    <code
      className={cn(
        isCodeBlock
          ? "font-mono text-log"
          : "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em]",
        className,
      )}
      {...props}
    />
  );
}

const markdownComponents = {
  ...markdownProseComponents,
  pre: ({ className, ...props }: React.ComponentPropsWithoutRef<"pre">) => (
    <pre
      className={cn("overflow-x-auto rounded-b-md bg-muted p-3 font-mono text-log", className)}
      {...props}
    />
  ),
  code: Code,
  CodeHeader,
};

const MarkdownTextImpl = () => (
  <MarkdownTextPrimitive
    className="min-w-0 break-words"
    remarkPlugins={[remarkGfm]}
    components={markdownComponents}
  />
);

const MarkdownText = memo(MarkdownTextImpl);
MarkdownText.displayName = "MarkdownText";

export { MarkdownText };
