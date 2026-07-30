import { ExternalLink, Search } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import type { ActivityState } from "#web/components/trema/activity-card.tsx";
import { StatusDot } from "#web/components/trema/status-dot.tsx";
import { Badge } from "#web/components/ui/badge.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#web/components/ui/collapsible.tsx";
import { cn } from "#web/lib/utils.ts";

interface WebSearchInput {
  query?: string;
  limit?: number;
  recency?: "day" | "week" | "month" | "year";
}

interface WebSearchSummary {
  count?: number;
  provider?: string;
}

export type WebSearchResult = {
  title: string;
  url: string;
};

type WebSearchActivityProps = {
  input?: string;
  notes?: string;
  resultSummary?: string;
  state?: ActivityState;
  children?: ReactNode;
};

const recencyLabels = {
  day: "Past day",
  week: "Past week",
  month: "Past month",
  year: "Past year",
} as const;

export function parseWebSearchInput(input: string | undefined): WebSearchInput {
  if (input === undefined) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.query === "string" ? { query: record.query } : {}),
      ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
      ...(record.recency === "day" ||
      record.recency === "week" ||
      record.recency === "month" ||
      record.recency === "year"
        ? { recency: record.recency }
        : {}),
    };
  } catch {
    return {};
  }
}

export function parseWebSearchResults(value: string): WebSearchResult[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const results = (parsed as Record<string, unknown>).results;
    if (!Array.isArray(results)) return undefined;
    return results.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (
        typeof record.title !== "string" ||
        typeof record.url !== "string" ||
        !/^https?:\/\//.test(record.url)
      ) {
        return [];
      }
      return [
        {
          title: record.title,
          url: record.url,
        },
      ];
    });
  } catch {
    return undefined;
  }
}

function resultHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function WebSearchResults({ results }: { results: readonly WebSearchResult[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? results : results.slice(0, 3);

  if (results.length === 0) {
    return <p className="text-meta text-muted-foreground">No matching pages were returned.</p>;
  }

  return (
    <div data-slot="web-search-results" className="space-y-1">
      <div className="">
        {visible.map((result) => (
          <a
            key={result.url}
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="-mx-1.5 flex gap-2.5 rounded-sm px-1.5 py-2 hover:bg-muted/50"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">{result.title}</span>
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
              </span>
              <span className="block truncate text-meta text-muted-foreground">
                {resultHost(result.url)}
              </span>
            </span>
          </a>
        ))}
      </div>
      {results.length > 3 && (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="text-meta font-medium text-muted-foreground hover:text-foreground"
        >
          {showAll ? "Show fewer results" : `Show all ${results.length} results`}
        </button>
      )}
    </div>
  );
}

export function parseWebSearchSummary(summary: string | undefined): WebSearchSummary {
  if (summary === undefined) return {};
  const match = /^Found (\d+) web results(?: · (.+))?$/.exec(summary);
  if (match === null) return {};
  const count = Number.parseInt(match[1] ?? "", 10);
  return {
    ...(Number.isFinite(count) ? { count } : {}),
    ...(match[2] === undefined ? {} : { provider: match[2] }),
  };
}

function activityTitle(state: ActivityState | undefined): string {
  switch (state) {
    case "running":
      return "Searching the web…";
    case "ok":
      return "Searched the web";
    case "error":
      return "Web search failed";
    case "denied":
      return "Web search denied";
    default:
      return "Search the web";
  }
}

export function WebSearchActivity({
  input,
  notes,
  resultSummary,
  state,
  children,
}: WebSearchActivityProps) {
  const search = parseWebSearchInput(input);
  const summary = parseWebSearchSummary(resultSummary);
  const expandable =
    search.recency !== undefined ||
    search.limit !== undefined ||
    notes !== undefined ||
    ((state === "error" || state === "denied") && resultSummary !== undefined) ||
    children !== undefined;

  const header = (
    <>
      <Search
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          state === "error" || state === "denied" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 text-chrome font-medium",
            (state === "error" || state === "denied") && "text-destructive",
          )}
        >
          {activityTitle(state)}
        </span>
        {search.query !== undefined && (
          <span className="truncate text-sm">for “{search.query}”</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {summary.provider !== undefined && (
          <Badge
            variant="outline"
            className="h-5 border-border/70 bg-muted/60 px-1.5 text-[10px] text-foreground/80"
          >
            {summary.provider}
          </Badge>
        )}
        {(state === "running" || state === "error") && (
          <StatusDot tone={state === "running" ? "run" : "destructive"} />
        )}
      </span>
    </>
  );

  if (!expandable) {
    return (
      <div
        data-slot="activity-card"
        data-activity="web-search"
        className="flex items-center gap-2 rounded-md px-1.5 py-1.5"
      >
        {header}
      </div>
    );
  }

  return (
    <Collapsible
      data-slot="activity-card"
      data-activity="web-search"
      style={{ "--animation-duration": "200ms" } as CSSProperties}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md text-muted-foreground text-left hover:text-foreground">
        {header}
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "overflow-hidden outline-none",
          "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-[state=closed]:animate-collapsible-up",
          "data-[state=open]:animate-collapsible-down",
          "data-[state=closed]:pointer-events-none data-[state=closed]:fill-mode-forwards",
          "data-[state=closed]:duration-(--animation-duration)",
          "data-[state=open]:duration-(--animation-duration)",
        )}
      >
        <div className="mt-1 mb-1.5 ml-1.25 space-y-3">
          {(search.recency !== undefined || search.limit !== undefined) && (
            <div className="flex flex-wrap gap-1.5">
              {search.recency !== undefined && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  {recencyLabels[search.recency]}
                </Badge>
              )}
              {search.limit !== undefined && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  Up to {search.limit} results
                </Badge>
              )}
            </div>
          )}
          {notes !== undefined && <p className="text-meta text-muted-foreground">{notes}</p>}
          {(state === "error" || state === "denied") && resultSummary !== undefined && (
            <p className="text-meta text-destructive">{resultSummary}</p>
          )}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
