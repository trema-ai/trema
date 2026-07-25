import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import type * as React from "react";
import { memo } from "react";
import remarkGfm from "remark-gfm";

import { CopyButton } from "#web/components/trema/copy-button.tsx";
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
  h1: ({ className, ...props }: React.ComponentPropsWithoutRef<"h1">) => (
    <h1
      className={cn("mt-5 mb-2 text-[17px] leading-snug font-semibold first:mt-0", className)}
      {...props}
    />
  ),
  h2: ({ className, ...props }: React.ComponentPropsWithoutRef<"h2">) => (
    <h2
      className={cn("mt-5 mb-2 text-[16px] leading-snug font-semibold first:mt-0", className)}
      {...props}
    />
  ),
  h3: ({ className, ...props }: React.ComponentPropsWithoutRef<"h3">) => (
    <h3
      className={cn("mt-4 mb-1.5 text-[15px] leading-snug font-semibold first:mt-0", className)}
      {...props}
    />
  ),
  h4: ({ className, ...props }: React.ComponentPropsWithoutRef<"h4">) => (
    <h4 className={cn("mt-4 mb-1.5 text-chat font-semibold first:mt-0", className)} {...props} />
  ),
  p: ({ className, ...props }: React.ComponentPropsWithoutRef<"p">) => (
    <p className={cn("my-3 text-chat first:mt-0 last:mb-0", className)} {...props} />
  ),
  a: ({ className, ...props }: React.ComponentPropsWithoutRef<"a">) => (
    <a className={cn("text-moss underline-offset-2 hover:underline", className)} {...props} />
  ),
  ul: ({ className, ...props }: React.ComponentPropsWithoutRef<"ul">) => (
    <ul className={cn("my-3 list-disc pl-6 text-chat", className)} {...props} />
  ),
  ol: ({ className, ...props }: React.ComponentPropsWithoutRef<"ol">) => (
    <ol className={cn("my-3 list-decimal pl-6 text-chat", className)} {...props} />
  ),
  li: ({ className, ...props }: React.ComponentPropsWithoutRef<"li">) => (
    <li className={cn("my-1", className)} {...props} />
  ),
  blockquote: ({ className, ...props }: React.ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className={cn("my-3 border-l-2 pl-4 text-muted-foreground", className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }: React.ComponentPropsWithoutRef<"hr">) => (
    <hr className={cn("my-5 border-border", className)} {...props} />
  ),
  table: ({ className, ...props }: React.ComponentPropsWithoutRef<"table">) => (
    <div className="my-3 overflow-x-auto">
      <table className={cn("w-full border-collapse text-chat", className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }: React.ComponentPropsWithoutRef<"th">) => (
    <th
      className={cn("border bg-muted px-3 py-1.5 text-left font-semibold", className)}
      {...props}
    />
  ),
  td: ({ className, ...props }: React.ComponentPropsWithoutRef<"td">) => (
    <td className={cn("border px-3 py-1.5", className)} {...props} />
  ),
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
