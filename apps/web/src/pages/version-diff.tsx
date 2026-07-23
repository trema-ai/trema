import { useTheme } from "next-themes";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";

const diffStyles = {
  variables: {
    light: {
      diffViewerBackground: "var(--card)",
      diffViewerColor: "var(--foreground)",
      addedBackground: "var(--go-soft)",
      addedColor: "var(--foreground)",
      removedBackground: "var(--destructive-soft)",
      removedColor: "var(--foreground)",
      wordAddedBackground: "color-mix(in srgb, var(--go) 28%, transparent)",
      wordRemovedBackground: "color-mix(in srgb, var(--destructive) 28%, transparent)",
      addedGutterBackground: "var(--go-soft)",
      removedGutterBackground: "var(--destructive-soft)",
      gutterBackground: "var(--muted)",
      gutterColor: "var(--muted-foreground)",
      diffViewerTitleBorderColor: "var(--border)",
    },
    dark: {
      diffViewerBackground: "var(--card)",
      diffViewerColor: "var(--foreground)",
      addedBackground: "var(--go-soft)",
      addedColor: "var(--foreground)",
      removedBackground: "var(--destructive-soft)",
      removedColor: "var(--foreground)",
      wordAddedBackground: "color-mix(in srgb, var(--go) 35%, transparent)",
      wordRemovedBackground: "color-mix(in srgb, var(--destructive) 35%, transparent)",
      addedGutterBackground: "var(--go-soft)",
      removedGutterBackground: "var(--destructive-soft)",
      gutterBackground: "var(--muted)",
      gutterColor: "var(--muted-foreground)",
      diffViewerTitleBorderColor: "var(--border)",
    },
  },
  diffContainer: {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    overflow: "hidden",
  },
  contentText: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.75rem",
    lineHeight: "1.45",
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  line: {
    paddingBlock: "0.125rem",
  },
} as const;

export function VersionDiffViewer({ before, after }: { before: string; after: string }) {
  const { resolvedTheme } = useTheme();

  return (
    <ReactDiffViewer
      oldValue={before}
      newValue={after}
      compareMethod={DiffMethod.LINES}
      splitView={false}
      hideLineNumbers
      hideSummary
      showDiffOnly={false}
      useDarkTheme={resolvedTheme === "dark"}
      styles={diffStyles}
    />
  );
}
