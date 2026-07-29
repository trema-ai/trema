import type * as React from "react";
import { createContext, isValidElement, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CopyButton } from "#web/components/trema/copy-button.tsx";
import { cn } from "#web/lib/utils.ts";

const CodeBlockContext = createContext(false);

function codeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeText).join("");
  if (isValidElement<{ children?: React.ReactNode }>(node)) return codeText(node.props.children);
  return "";
}

function Pre({ className, children, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  const child = isValidElement<{ className?: string; children?: React.ReactNode }>(children)
    ? children
    : undefined;
  const language = child?.props.className?.match(/language-([\w-]+)/)?.[1];
  const code = codeText(child?.props.children ?? children).replace(/\n$/, "");

  return (
    <div className="my-3 min-w-0">
      <div
        data-slot="code-header"
        className="flex items-center justify-between rounded-t-md border-b bg-muted px-3 py-1"
      >
        <span className="text-chrome font-medium text-muted-foreground">{language ?? "code"}</span>
        <CopyButton value={code} aria-label="Copy code" />
      </div>
      <CodeBlockContext.Provider value>
        <pre
          className={cn("overflow-x-auto rounded-b-md bg-muted p-3 font-mono text-log", className)}
          {...props}
        >
          {children}
        </pre>
      </CodeBlockContext.Provider>
    </div>
  );
}

function Code({ className, ...props }: React.ComponentPropsWithoutRef<"code">) {
  const block = useContext(CodeBlockContext);
  return (
    <code
      className={cn(
        block ? "font-mono text-log" : "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em]",
        className,
      )}
      {...props}
    />
  );
}

const markdownProseComponents: Components = {
  h1: ({ className, ...props }) => (
    <h1
      className={cn("mt-5 mb-2 text-[17px] leading-snug font-medium first:mt-0", className)}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn("mt-5 mb-2 text-[16px] leading-snug font-medium first:mt-0", className)}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn("mt-4 mb-1.5 text-[15px] leading-snug font-medium first:mt-0", className)}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4 className={cn("mt-4 mb-1.5 text-chat font-medium first:mt-0", className)} {...props} />
  ),
  p: ({ className, ...props }) => (
    <p className={cn("my-3 text-chat first:mt-0 last:mb-0", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a className={cn("text-moss underline-offset-2 hover:underline", className)} {...props} />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("my-3 list-disc pl-6 text-chat", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-3 list-decimal pl-6 text-chat", className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn("my-1", className)} {...props} />,
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn("my-3 border-l-2 pl-4 text-muted-foreground", className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("my-5 border-border", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table className={cn("w-full border-collapse text-chat", className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th className={cn("border bg-muted px-3 py-1.5 text-left font-medium", className)} {...props} />
  ),
  td: ({ className, ...props }) => (
    <td className={cn("border px-3 py-1.5", className)} {...props} />
  ),
};

const components: Components = {
  ...markdownProseComponents,
  pre: Pre,
  code: Code,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div data-slot="text-part" className={cn("min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export { markdownProseComponents };
