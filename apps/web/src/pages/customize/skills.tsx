import { FileText, Wrench } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { EmptyState } from "#/components/trema/empty-state.tsx";
import { KeyValueList } from "#/components/trema/key-value-list.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { StatusDot } from "#/components/trema/status-dot.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { cn } from "#/lib/utils.ts";
import { ArchiveItemButton, LifecycleActions } from "#/pages/customize/item-editor.tsx";
import type { Item, SkillBody } from "#/pages/customize/types.ts";

const statusTone = { active: "go", proposed: "wait", archived: "neutral" } as const;

export function SkillsTab({ items, loading }: { items: Item[]; loading: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const skills = items.filter((item) => item.kind === "skill" && item.status !== "archived");
  const selectedId = searchParams.get("skill");
  const selected = skills.find((item) => item.id === selectedId) ?? skills[0];

  function selectSkill(item: Item) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set("skill", item.id);
      return params;
    });
  }

  if (loading) {
    return (
      <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (skills.length === 0) {
    return (
      <div className="rounded-md border bg-card">
        <EmptyState
          icon={Wrench}
          title="No skills in this scope yet"
          description="Skills are procedures the agent loads on demand. Installed skills and ones the agent proposes from repeated work appear here."
        />
      </div>
    );
  }
  return (
    <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="self-start overflow-hidden rounded-md border bg-card p-2">
        {skills.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => selectSkill(item)}
            aria-current={selected?.id === item.id ? "true" : undefined}
            className={cn(
              "flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-chrome focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected?.id === item.id ? "bg-muted font-medium" : "hover:bg-muted/60",
            )}
          >
            <span className="truncate">{item.title}</span>
            {item.status === "proposed" ? <StatusDot tone="wait" /> : null}
          </button>
        ))}
      </aside>
      {selected ? <SkillDetail key={`${selected.id}:${selected.version}`} item={selected} /> : null}
    </div>
  );
}

function SkillDetail({ item }: { item: Item }) {
  const body = item.body as SkillBody;
  const files = Object.entries(body.files ?? {}).sort(([left], [right]) => {
    if (left === "SKILL.md") return -1;
    if (right === "SKILL.md") return 1;
    return left.localeCompare(right);
  });
  const [selectedFile, setSelectedFile] = useState(
    files.some(([name]) => name === "SKILL.md") ? "SKILL.md" : (files[0]?.[0] ?? ""),
  );
  const content = body.files?.[selectedFile];

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium">{item.title}</h3>
        <span className="inline-flex items-center gap-1.5 capitalize text-chrome">
          <StatusDot tone={statusTone[item.status]} />
          {item.status}
        </span>
      </div>
      <KeyValueList
        items={[
          { label: "Source", value: body.source ?? "Unavailable" },
          { label: "Version", value: item.version },
          { label: "Updated", value: <RelativeTime date={item.updatedAt} /> },
        ]}
      />
      {files.length > 0 ? (
        <div className="grid overflow-hidden rounded-md border bg-card md:grid-cols-[13rem_minmax(0,1fr)]">
          <div className="border-b p-2 md:border-r md:border-b-0">
            {files.map(([name]) => (
              <button
                key={name}
                type="button"
                onClick={() => setSelectedFile(name)}
                aria-current={selectedFile === name ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-chrome",
                  selectedFile === name ? "bg-muted font-medium" : "hover:bg-muted/60",
                )}
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
              </button>
            ))}
          </div>
          <pre className="min-h-48 overflow-auto whitespace-pre-wrap p-4 font-mono text-chrome">
            {content}
          </pre>
        </div>
      ) : (
        <div className="rounded-md border bg-card px-4 py-3">
          <p className="text-chrome text-muted-foreground">This skill has no content yet.</p>
        </div>
      )}
      {item.status === "proposed" ? (
        <div className="flex flex-wrap gap-2 rounded-md border bg-card p-3">
          <LifecycleActions item={item} compact />
          <ArchiveItemButton item={item} compact label="Dismiss" />
        </div>
      ) : null}
    </section>
  );
}
