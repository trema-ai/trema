import { createHash } from "node:crypto";

import type { Part } from "@trema/projection";
import type { RenderContent } from "@trema/surfaces";

export interface SlackUrlSource {
  type: "url";
  text: string;
  url: string;
}

export interface SlackTaskUpdate {
  type: "task_update";
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
  output?: string;
  sources?: SlackUrlSource[];
}

export type SlackStreamChunk =
  | { type: "markdown_text"; text: string }
  | { type: "plan_update"; title: string }
  | SlackTaskUpdate;

export interface SlackThinkingState {
  version: 1;
  narrativeText: string;
  planTitled: boolean;
  taskFingerprints: Record<string, string>;
}

export interface SlackThinkingRealization {
  narrativeText: string;
  tasks: SlackTaskUpdate[];
}

const CHUNK_TEXT_LIMIT = 256;
const SOURCE_TEXT_LIMIT = 200;
const SOURCE_URL_LIMIT = 3_000;
const MAX_SOURCES = 10;
const MAX_TASKS = 48;
const PLAN_TITLE = "Progress";
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu;

/** Builds only safe, user-facing Slack state; raw inputs and redacted reasoning never enter it. */
export function realizeSlackThinking(
  content: RenderContent,
  messageId: string,
): SlackThinkingRealization {
  const narrative: string[] = [];
  const tasks: SlackTaskUpdate[] = [];

  if (content.lifecycle !== undefined) {
    tasks.push(lifecycleTask(content.lifecycle.state, messageId));
  }

  for (const part of content.parts) {
    const narrativeText = narrativePartText(part);
    if (narrativeText !== undefined && narrativeText.length > 0) narrative.push(narrativeText);

    const task = taskForPart(part, messageId);
    if (task !== undefined) tasks.push(task);
  }

  const narrativeText =
    narrative.length > 0
      ? narrative.join("\n\n")
      : content.parts.length === 0 && content.lifecycle !== undefined
        ? lifecycleNarrative(content.lifecycle.state)
        : "";
  const narrativeSources = markdownSources(narrativeText);
  if (narrativeSources.length > 0) {
    tasks.push({
      type: "task_update",
      id: stableTaskId(messageId, "sources", "citations"),
      title: "Sources",
      status: "complete",
      output: `${narrativeSources.length} ${narrativeSources.length === 1 ? "source" : "sources"}`,
      sources: narrativeSources,
    });
  }

  return { narrativeText, tasks: tasks.slice(0, MAX_TASKS) };
}

export function initialThinkingChunks(realization: SlackThinkingRealization): {
  chunks: SlackStreamChunk[];
  state: SlackThinkingState;
} {
  const planTitled = realization.tasks.length > 0;
  const chunks: SlackStreamChunk[] = [
    ...(planTitled ? [{ type: "plan_update" as const, title: PLAN_TITLE }] : []),
    ...realization.tasks,
    ...(realization.narrativeText.length > 0
      ? [{ type: "markdown_text" as const, text: realization.narrativeText }]
      : []),
  ];
  return { chunks, state: thinkingState(realization, planTitled) };
}

export function changedThinkingChunks(
  realization: SlackThinkingRealization,
  prior: SlackThinkingState,
): {
  chunks: SlackStreamChunk[];
  narrativeReplaced: boolean;
  removedTask: boolean;
  state: SlackThinkingState;
} {
  const currentIds = new Set(realization.tasks.map(({ id }) => id));
  const removedTask = Object.keys(prior.taskFingerprints).some((id) => !currentIds.has(id));
  const planTitled = prior.planTitled || realization.tasks.length > 0;
  const narrativeReplaced = !realization.narrativeText.startsWith(prior.narrativeText);
  const chunks: SlackStreamChunk[] = [];

  if (!prior.planTitled && realization.tasks.length > 0) {
    chunks.push({ type: "plan_update", title: PLAN_TITLE });
  }
  for (const task of realization.tasks) {
    if (prior.taskFingerprints[task.id] !== taskFingerprint(task)) chunks.push(task);
  }
  if (!narrativeReplaced) {
    const delta = realization.narrativeText.slice(prior.narrativeText.length);
    if (delta.length > 0) chunks.push({ type: "markdown_text", text: delta });
  }

  return {
    chunks,
    narrativeReplaced,
    removedTask,
    state: thinkingState(realization, planTitled),
  };
}

export function appendThinkingText(prior: SlackThinkingState, delta: string): SlackThinkingState {
  return { ...prior, narrativeText: `${prior.narrativeText}${delta}` };
}

export function parseThinkingState(
  metadata: Record<string, unknown> | undefined,
): SlackThinkingState | undefined {
  const value = metadata?.slackThinking;
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (
    typeof value.narrativeText !== "string" ||
    typeof value.planTitled !== "boolean" ||
    !isStringRecord(value.taskFingerprints)
  ) {
    return undefined;
  }
  return {
    version: 1,
    narrativeText: value.narrativeText,
    planTitled: value.planTitled,
    taskFingerprints: value.taskFingerprints,
  };
}

export function staticThinkingBlock(
  realization: SlackThinkingRealization,
): Record<string, unknown> | undefined {
  if (realization.tasks.length === 0) return undefined;
  return {
    type: "plan",
    title: PLAN_TITLE,
    tasks: realization.tasks.map((task) => ({
      type: "task_card",
      task_id: task.id,
      title: task.title,
      status: task.status,
      ...(task.output === undefined ? {} : { output: richText(task.output) }),
      ...(task.sources === undefined ? {} : { sources: task.sources }),
    })),
  };
}

function taskForPart(part: Part, messageId: string): SlackTaskUpdate | undefined {
  if (part.kind === "reasoning") {
    return {
      type: "task_update",
      id: stableTaskId(messageId, part.kind, part.id),
      title: "Thinking",
      status: part.status === "streaming" ? "in_progress" : "complete",
    };
  }
  if (part.kind === "elicitation" && part.elicitationKind === "approval") {
    const resolution = part.resolution;
    const selected =
      resolution === undefined
        ? undefined
        : (part.options.find((option) => option.id === resolution.optionId)?.label ??
          resolution.optionId);
    const actor = resolution?.by.displayName ?? resolution?.by.principalId;
    return {
      type: "task_update",
      id: stableTaskId(messageId, "approval", part.elicitationId),
      title: resolution === undefined ? "Approval required" : "Approval resolved",
      status:
        resolution?.optionId === "expired"
          ? "error"
          : resolution === undefined
            ? "pending"
            : "complete",
      ...(resolution === undefined ? {} : taskOutput(`${selected} by ${actor}`)),
    };
  }
  if (part.kind !== "activity") return undefined;

  return {
    type: "task_update",
    id: stableTaskId(messageId, part.kind, part.id),
    title: boundedText(plainText(part.title), CHUNK_TEXT_LIMIT) || "Task",
    status:
      part.result?.status === "error" || part.result?.status === "denied"
        ? "error"
        : part.result !== undefined || part.status === "done"
          ? "complete"
          : "in_progress",
  };
}

function lifecycleTask(
  state: NonNullable<RenderContent["lifecycle"]>["state"],
  messageId: string,
): SlackTaskUpdate {
  const presentation = {
    queued: ["Run queued", "pending"],
    running: ["Run active", "in_progress"],
    waiting_for_approval: ["Waiting for approval", "pending"],
    paused: ["Run paused", "pending"],
    completed: ["Run completed", "complete"],
    failed: ["Run failed", "error"],
    cancelled: ["Run canceled", "complete"],
  } as const;
  const [title, status] = presentation[state];
  return {
    type: "task_update",
    id: stableTaskId(messageId, "lifecycle", "run"),
    title,
    status,
  };
}

function lifecycleNarrative(state: NonNullable<RenderContent["lifecycle"]>["state"]): string {
  return {
    queued: "Queued",
    running: "Running",
    waiting_for_approval: "Waiting for approval",
    paused: "Paused",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Canceled",
  }[state];
}

function narrativePartText(part: Part): string | undefined {
  switch (part.kind) {
    case "text":
      return part.markdown;
    case "reasoning":
    case "activity":
    case "data":
      return undefined;
    case "steering":
      return `${part.author.displayName ?? part.author.principalId}: ${part.text}`;
    case "elicitation": {
      const answer = part.resolution?.optionId;
      if (answer !== undefined) return `${part.prompt}\nAnswer: ${answer}`;
      // Unresolved elicitations become native controls when the message is
      // finalized. Keeping them out of the narrative avoids duplicating the
      // prompt and choices above those controls.
      return undefined;
    }
    case "error":
      return `Error: ${part.message}`;
  }
}

function taskOutput(value: string): { output?: string } {
  const output = boundedText(plainText(value), CHUNK_TEXT_LIMIT);
  return output.length === 0 ? {} : { output };
}

function markdownSources(value: string): SlackUrlSource[] {
  const sources: SlackUrlSource[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(MARKDOWN_LINK)) {
    const rawUrl = match[2];
    if (rawUrl === undefined || seen.has(rawUrl)) continue;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      rawUrl.length > SOURCE_URL_LIMIT
    ) {
      continue;
    }
    seen.add(rawUrl);
    const label = plainText(match[1] ?? "");
    sources.push({
      type: "url",
      text: boundedText(label || url.hostname, SOURCE_TEXT_LIMIT),
      url: rawUrl,
    });
    if (sources.length === MAX_SOURCES) break;
  }
  return sources;
}

function plainText(value: string): string {
  return value
    .replace(MARKDOWN_LINK, "$1")
    .replaceAll(/[`*_~]/gu, "")
    .trim();
}

function boundedText(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function stableTaskId(messageId: string, kind: string, partId: string): string {
  return `task_${createHash("sha256").update(`${messageId}:${kind}:${partId}`).digest("hex").slice(0, 32)}`;
}

function taskFingerprint(task: SlackTaskUpdate): string {
  return createHash("sha256").update(JSON.stringify(task)).digest("hex").slice(0, 16);
}

function thinkingState(
  realization: SlackThinkingRealization,
  planTitled: boolean,
): SlackThinkingState {
  return {
    version: 1,
    narrativeText: realization.narrativeText,
    planTitled,
    taskFingerprints: Object.fromEntries(
      realization.tasks.map((task) => [task.id, taskFingerprint(task)]),
    ),
  };
}

function richText(text: string): Record<string, unknown> {
  return {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
