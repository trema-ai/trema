import { cn } from "#/lib/utils.ts";
import { diffWords } from "#/pages/customize-types.ts";

/* Prose diff: one merged reading flow instead of paired −/+ lines. Additions
   are tinted chips; removals stay visible in place, struck through. */
export function VersionDiffViewer({ before, after }: { before: string; after: string }) {
  const seen = new Map<string, number>();
  const segments = diffWords(before, after).map((segment) => {
    const base = `${segment.kind}:${segment.text}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { ...segment, key: `${base}:${occurrence}` };
  });
  return (
    <p className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-[0.8125rem] leading-relaxed">
      {segments.map((segment) => {
        const { key } = segment;
        if (segment.kind === "same") return <span key={key}>{segment.text}</span>;
        return (
          <span
            key={key}
            className={cn(
              "rounded-xs px-0.5",
              segment.kind === "added"
                ? "bg-go-soft text-foreground"
                : "bg-destructive-soft text-muted-foreground line-through decoration-destructive/70",
            )}
          >
            {segment.text}
          </span>
        );
      })}
    </p>
  );
}
