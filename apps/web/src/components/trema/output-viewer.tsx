import { Download, File } from "lucide-react";
import * as React from "react";

import { cn } from "#web/lib/utils.ts";

type OutputContent =
  | { type: "json"; value: unknown }
  | { type: "text"; value: string }
  | { type: "image"; src: string; alt?: string }
  | { type: "file"; name: string; href: string; size?: string };

type OutputViewerProps = {
  output: OutputContent;
  truncated?: boolean;
  className?: string;
};

const COLLAPSE_THRESHOLD = 20;

function getEntries(value: unknown): readonly (readonly [string, unknown])[] | null {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item] as const);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>);
  }
  return null;
}

function JsonLeaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">{String(value)}</span>;
  }
  if (typeof value === "string") {
    return <span className="text-go">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="text-moss">{String(value)}</span>;
  }
  return <span>{String(value)}</span>;
}

function JsonNode({ label, value }: { label?: string; value: unknown }) {
  const entries = getEntries(value);
  const [open, setOpen] = React.useState(
    () => entries === null || entries.length <= COLLAPSE_THRESHOLD,
  );

  const labelPrefix =
    label !== undefined ? <span className="text-muted-foreground">{label}: </span> : null;

  if (entries === null) {
    return (
      <div>
        {labelPrefix}
        <JsonLeaf value={value} />
      </div>
    );
  }

  const [openBracket, closeBracket] = Array.isArray(value)
    ? (["[", "]"] as const)
    : (["{", "}"] as const);

  if (entries.length === 0) {
    return (
      <div>
        {labelPrefix}
        <span className="text-muted-foreground">
          {openBracket}
          {closeBracket}
        </span>
      </div>
    );
  }

  return (
    <div>
      <div>
        {labelPrefix}
        {entries.length > COLLAPSE_THRESHOLD ? (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="text-muted-foreground hover:text-foreground"
          >
            {open ? openBracket : `${openBracket} ${entries.length} entries ${closeBracket}`}
          </button>
        ) : (
          <span className="text-muted-foreground">{openBracket}</span>
        )}
      </div>
      {open && (
        <>
          <div className="pl-4">
            {entries.map(([key, entryValue]) => (
              <JsonNode key={key} label={key} value={entryValue} />
            ))}
          </div>
          <div className="text-muted-foreground">{closeBracket}</div>
        </>
      )}
    </div>
  );
}

function OutputBody({ output }: { output: OutputContent }) {
  switch (output.type) {
    case "json":
      return (
        <div className="max-h-96 overflow-auto rounded-sm bg-muted p-2 font-mono text-log">
          <JsonNode value={output.value} />
        </div>
      );
    case "text":
      return (
        <pre className="max-h-96 overflow-auto rounded-sm bg-muted p-2 font-mono text-log whitespace-pre-wrap">
          {output.value}
        </pre>
      );
    case "image":
      return (
        <img src={output.src} alt={output.alt ?? ""} className="max-w-full rounded-sm border" />
      );
    case "file":
      return (
        <a
          href={output.href}
          download
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-chrome hover:bg-muted"
        >
          <File className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">{output.name}</span>
          {output.size !== undefined && (
            <span className="text-meta text-muted-foreground">{output.size}</span>
          )}
          <Download className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        </a>
      );
  }
}

function OutputViewer({ output, truncated, className }: OutputViewerProps) {
  return (
    <div data-slot="output-viewer" data-type={output.type} className={cn("space-y-1", className)}>
      <OutputBody output={output} />
      {truncated && <div className="text-meta text-wait">Output truncated</div>}
    </div>
  );
}

export { type OutputContent, OutputViewer, type OutputViewerProps };
