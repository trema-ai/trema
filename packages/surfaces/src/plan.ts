import type { Part, Projection, Segment } from "@trema/projection";

import type {
  ApplyResult,
  CapabilityDescriptor,
  PlanRenderOptions,
  RealizedMessage,
  RealizedSegment,
  RenderContent,
  RenderOperation,
  RenderPlan,
  SurfaceRealization,
} from "#surfaces/types.js";

type PlannedMessage = RealizedMessage & { content: RenderContent };

/**
 * Computes one coalesced operation batch from durable projection state.
 * Repeating the call after acknowledgement produces an empty batch.
 */
export function planRender(
  projection: Projection,
  realization: Pick<
    SurfaceRealization,
    "runId" | "renderedThroughSeq" | "segments" | "pendingPlan"
  >,
  capabilities: CapabilityDescriptor,
  options: PlanRenderOptions = {},
): RenderPlan {
  if (projection.runId !== realization.runId) {
    throw new Error(
      `projection run ${projection.runId} does not match realization run ${realization.runId}`,
    );
  }
  const cursorRegressed = projection.lastSeq < realization.renderedThroughSeq;
  if (cursorRegressed && options.allowCursorRegression !== true) {
    throw new Error(
      `projection cursor regressed from ${realization.renderedThroughSeq} to ${projection.lastSeq}`,
    );
  }
  if (!Number.isSafeInteger(capabilities.budgets.messageChars)) {
    throw new Error("messageChars must be a safe integer");
  }
  if (capabilities.budgets.messageChars <= 0) {
    throw new Error("messageChars must be greater than zero");
  }

  // A batch is staged before remote apply. Until it is acknowledged, replay
  // its exact operation identities and target state before planning from a
  // newer projection; the remote side may already have applied any subset.
  if (realization.pendingPlan !== undefined) {
    return {
      ...realization.pendingPlan,
      fromCursor: realization.renderedThroughSeq,
      toCursor: Math.min(realization.pendingPlan.toCursor, projection.lastSeq),
    };
  }

  const terminal = isTerminal(projection.status);
  // A render-once realization is immutable after its first acknowledged
  // delivery. Replays may advance or reconcile the cursor, but never mutate
  // the remote message or replace its durable description.
  if (capabilities.mutation === "render-once" && realization.segments.length > 0) {
    return {
      fromCursor: realization.renderedThroughSeq,
      toCursor: projection.lastSeq,
      operations: [],
      nextSegments: realization.segments,
    };
  }
  // Render-once drivers must not claim an applied cursor before anything was
  // delivered. At terminal they receive the full projection in one plan.
  if (capabilities.mutation === "render-once" && !terminal) {
    return {
      fromCursor: realization.renderedThroughSeq,
      toCursor: realization.renderedThroughSeq,
      operations: [],
      nextSegments: realization.segments,
    };
  }

  const existingById = new Map(realization.segments.map((segment) => [segment.id, segment]));
  const operations: RenderOperation[] = [];
  const nextSegments: RealizedSegment[] = [];
  let deferred = false;

  // A run can change lifecycle before it has content events. Give editable,
  // streaming surfaces one stable message that later reconciles into segment
  // zero, including when the run reaches a terminal state without content.
  const projectedSegments =
    projection.segments.length === 0
      ? [{ index: 0, parts: [] } satisfies Segment]
      : projection.segments;

  for (const segment of projectedSegments) {
    const segmentId = segmentIdentity(projection.runId, segment.index);
    // Immutable and non-streaming destinations wait for a semantic boundary,
    // then receive the settled snapshot once.
    if (
      (capabilities.mutation === "append-only" || capabilities.streaming === "none") &&
      segment.end === undefined &&
      !terminal
    ) {
      deferred = true;
      const existing = existingById.get(segmentId);
      if (existing !== undefined) nextSegments.push(existing);
      existingById.delete(segmentId);
      continue;
    }

    const existing = existingById.get(segmentId);
    const planned = realizeSegment(
      segment,
      segmentId,
      capabilities.budgets.messageChars,
      terminal,
      segment.index === 0 ? lifecycleState(projection) : undefined,
    );
    const messages: RealizedMessage[] =
      capabilities.mutation === "append-only" ? [...(existing?.messages ?? [])] : [];
    const plannedIds = new Set(planned.map((message) => message.id));
    const historicalLogicalIds = new Set(messages.map((message) => logicalMessageId(message.id)));
    const activeMessages = appendActiveMessages(existing);
    const activeByLogicalId = new Map(
      activeMessages.map((message) => [logicalMessageId(message.id), message]),
    );
    const nextActiveMessageIds: string[] = [];
    const activeMatches = planned.map((target) => {
      const active = activeByLogicalId.get(target.id);
      return active?.contentHash === target.contentHash && active.finalized === target.finalized;
    });
    let reusableMessageFollows = false;
    let changedBeforeReusableMessage = false;
    for (let index = activeMatches.length - 1; index >= 0; index -= 1) {
      if (activeMatches[index] === true) {
        reusableMessageFollows = true;
      } else if (reusableMessageFollows) {
        changedBeforeReusableMessage = true;
      }
    }
    const appendSnapshotRequired =
      capabilities.mutation === "append-only" &&
      (activeMessages.some((message) => !plannedIds.has(logicalMessageId(message.id))) ||
        changedBeforeReusableMessage);

    for (const target of planned) {
      if (capabilities.mutation === "append-only") {
        const latest = activeByLogicalId.get(target.id);
        if (
          !appendSnapshotRequired &&
          latest?.contentHash === target.contentHash &&
          latest.finalized === target.finalized
        ) {
          nextActiveMessageIds.push(latest.id);
          continue;
        }

        const immutableTarget =
          latest === undefined && !historicalLogicalIds.has(target.id)
            ? target
            : {
                ...target,
                id: `${target.id}:revision:${messages.length}`,
                index: messages.length,
              };
        operations.push({
          ...operationIdentity(immutableTarget, "create", realization.renderedThroughSeq),
          type: "create",
          content: immutableTarget.content,
          finalized: true,
        });
        messages.push(withoutContent({ ...immutableTarget, finalized: true }));
        nextActiveMessageIds.push(immutableTarget.id);
        continue;
      }

      const prior = existing?.messages.find((message) => message.id === target.id);
      const next = withoutContent(target);
      if (prior !== undefined) {
        if (prior.remoteRef !== undefined) next.remoteRef = prior.remoteRef;
        if (prior.metadata !== undefined) next.metadata = prior.metadata;
      }

      if (prior === undefined || prior.remoteRef === undefined) {
        operations.push({
          ...operationIdentity(target, "create", realization.renderedThroughSeq),
          type: "create",
          content: target.content,
          finalized: target.finalized,
        });
      } else if (target.contentHash !== prior.contentHash) {
        if (
          target.text !== prior.text &&
          !target.finalized &&
          capabilities.streaming === "delta" &&
          projection.lastSeq === realization.renderedThroughSeq + 1 &&
          target.content.parts.length > 0 &&
          target.content.parts.every((part) => part.kind === "text") &&
          target.text.startsWith(prior.text)
        ) {
          operations.push({
            ...operationIdentity(target, "append", realization.renderedThroughSeq),
            type: "append",
            remoteRef: prior.remoteRef,
            text: target.text.slice(prior.text.length),
            prior: priorRenderState(prior),
          });
        } else {
          operations.push({
            ...operationIdentity(
              target,
              target.finalized ? "finalize" : "replace",
              realization.renderedThroughSeq,
            ),
            type: target.finalized ? "finalize" : "replace",
            remoteRef: prior.remoteRef,
            content: target.content,
            prior: priorRenderState(prior),
          });
        }
      } else if (target.finalized && !prior.finalized) {
        operations.push({
          ...operationIdentity(target, "finalize", realization.renderedThroughSeq),
          type: "finalize",
          remoteRef: prior.remoteRef,
          content: target.content,
          prior: priorRenderState(prior),
        });
      }
      messages.push(next);
    }

    if (capabilities.mutation !== "append-only") {
      const targetIds = new Set(planned.map((message) => message.id));
      for (const prior of existing?.messages ?? []) {
        if (targetIds.has(prior.id)) continue;
        if (capabilities.mutation === "edit" && prior.remoteRef !== undefined) {
          operations.push({
            ...operationIdentity(prior, "delete", realization.renderedThroughSeq),
            type: "delete",
            remoteRef: prior.remoteRef,
          });
        } else if (capabilities.mutation !== "edit") {
          messages.push(prior);
        }
      }
    }

    if (messages.length > 0) {
      nextSegments.push({
        id: segmentId,
        index: segment.index,
        messages,
        ...(capabilities.mutation === "append-only"
          ? { activeMessageIds: nextActiveMessageIds }
          : {}),
      });
    }
    existingById.delete(segmentId);
  }

  // A replayed projection can remove a whole realized segment (for example,
  // after an operator-authorized event-log truncation). Editable surfaces
  // converge by deleting it; immutable ones preserve what was already sent.
  for (const existing of existingById.values()) {
    if (capabilities.mutation !== "edit") {
      nextSegments.push(existing);
      continue;
    }
    for (const message of existing.messages) {
      if (message.remoteRef === undefined) continue;
      operations.push({
        ...operationIdentity(message, "delete", realization.renderedThroughSeq),
        type: "delete",
        remoteRef: message.remoteRef,
      });
    }
  }

  nextSegments.sort((left, right) => left.index - right.index);
  return {
    fromCursor: realization.renderedThroughSeq,
    toCursor: deferred && !cursorRegressed ? realization.renderedThroughSeq : projection.lastSeq,
    operations,
    nextSegments,
  };
}

/** Validates a whole-batch acknowledgement and attaches returned remote refs. */
export function acknowledge(plan: RenderPlan, result: ApplyResult): RealizedSegment[] {
  const expected = new Set(plan.operations.map((operation) => operation.id));
  const applied = new Set(result.appliedOperationIds);
  if (applied.size !== expected.size || [...expected].some((id) => !applied.has(id))) {
    throw new Error("surface driver did not acknowledge the complete render batch");
  }

  const returned = new Map(result.messages.map((message) => [message.messageId, message]));
  return plan.nextSegments.map((segment) => ({
    ...segment,
    messages: segment.messages.map((message) => {
      const resultMessage = returned.get(message.id);
      const created = plan.operations.some(
        (operation) => operation.type === "create" && operation.messageId === message.id,
      );
      const remoteRef = resultMessage?.remoteRef ?? message.remoteRef;
      if (created && remoteRef === undefined) {
        throw new Error(`surface driver omitted remote reference for ${message.id}`);
      }
      return {
        ...message,
        ...(remoteRef === undefined ? {} : { remoteRef }),
        ...(resultMessage?.metadata === undefined ? {} : { metadata: resultMessage.metadata }),
      };
    }),
  }));
}

function realizeSegment(
  segment: Segment,
  segmentId: string,
  budget: number,
  terminal: boolean,
  lifecycle: RenderContent["lifecycle"],
): PlannedMessage[] {
  const content = segment.parts.map((part) => ({
    part: driverPart(part),
    text: partText(part),
  }));
  const chunks = chunkContent(content, budget);
  if (chunks.length === 0 && lifecycle !== undefined) {
    chunks.push({ text: lifecycleText(lifecycle), parts: [] });
  }
  if (chunks[0] !== undefined && lifecycle !== undefined) {
    chunks[0] = { ...chunks[0], lifecycle };
  }
  const finalized = terminal || segment.end !== undefined;
  return chunks.map((renderContent, index) => {
    const id = `${segmentId}:message:${index}`;
    return {
      id,
      index,
      text: renderContent.text,
      contentHash: fingerprint(stableSerialize(renderContent)),
      finalized,
      content: renderContent,
    };
  });
}

function lifecycleState(projection: Projection): RenderContent["lifecycle"] {
  if (projection.status === "pending") return { state: "queued" };
  if (projection.status === "paused") {
    const waitingForApproval = projection.segments.some((segment) =>
      segment.parts.some(
        (part) =>
          part.kind === "elicitation" &&
          (part.elicitationKind === "approval" || part.elicitationKind === "confirmation") &&
          part.blocking &&
          part.resolution === undefined,
      ),
    );
    return { state: waitingForApproval ? "waiting_for_approval" : "paused" };
  }
  return { state: projection.status };
}

function lifecycleText(lifecycle: NonNullable<RenderContent["lifecycle"]>): string {
  return lifecycle.state === "waiting_for_approval"
    ? "Waiting for approval"
    : lifecycle.state === "cancelled"
      ? "Canceled"
      : `${lifecycle.state[0]?.toUpperCase()}${lifecycle.state.slice(1)}`;
}

function driverPart(part: Part): Part {
  return part.kind === "reasoning" && part.redacted === true ? { ...part, text: "" } : part;
}

function partText(part: Part): string {
  switch (part.kind) {
    case "text":
      return part.markdown;
    case "reasoning":
      return part.redacted === true ? "Reasoning redacted" : part.text;
    case "activity": {
      const lines = [part.title, ...part.notes];
      if (part.result !== undefined) lines.push(part.result.summary);
      return lines.join("\n");
    }
    case "steering":
      return `${part.author.displayName ?? part.author.principalId}: ${part.text}`;
    case "elicitation": {
      const answer = part.resolution?.optionId;
      if (answer !== undefined) return `${part.prompt}\nAnswer: ${answer}`;
      const options = part.options.map((option, index) => `${index + 1}. ${option.label}`);
      return [part.prompt, ...options].join("\n");
    }
    case "error":
      return `Error: ${part.message}`;
    case "data":
      return "";
  }
}

function chunkContent(content: { part: Part; text: string }[], budget: number): RenderContent[] {
  const chunks: RenderContent[] = [];
  const pendingParts: Part[] = [];
  let current: RenderContent | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    chunks.push(current);
    current = undefined;
  };

  for (const { part, text } of content) {
    if (text.length === 0) {
      if (current === undefined) pendingParts.push(part);
      else current = { ...current, parts: [...current.parts, part] };
      continue;
    }

    const separator = current === undefined ? "" : "\n\n";
    if (current !== undefined && characterCount(`${current.text}${separator}${text}`) <= budget) {
      current = { text: `${current.text}${separator}${text}`, parts: [...current.parts, part] };
      continue;
    }

    flush();
    const fragments = splitMarkdownAtBudget(text, budget);
    for (const [index, fragment] of fragments.entries()) {
      const fragmentPart = partFragment(part, fragment, fragments.length, index);
      const next = {
        text: fragment,
        parts: [
          ...(index === 0 ? pendingParts.splice(0) : []),
          ...(fragmentPart === undefined ? [] : [fragmentPart]),
        ],
      };
      if (index === fragments.length - 1) current = next;
      else chunks.push(next);
    }
  }

  if (pendingParts.length > 0) {
    if (current === undefined) current = { text: "", parts: pendingParts };
    else current = { ...current, parts: [...current.parts, ...pendingParts] };
  }
  flush();
  return chunks;
}

function partFragment(
  part: Part,
  text: string,
  fragmentCount: number,
  fragmentIndex: number,
): Part | undefined {
  if (fragmentCount === 1) return part;
  if (part.kind === "text") return { ...part, markdown: text };
  if (part.kind === "reasoning" && part.redacted !== true) return { ...part, text };
  return fragmentIndex === 0 ? part : undefined;
}

type MarkdownBlock =
  | { kind: "plain"; text: string }
  | { kind: "fence"; text: string; opening: string; body: string; marker: string };

function splitMarkdownAtBudget(value: string, budget: number): string[] {
  if (characterCount(value) <= budget) return [value];

  const pieces = markdownBlocks(value).flatMap((block) => {
    if (characterCount(block.text) <= budget) return [block.text];
    return block.kind === "fence"
      ? splitOversizedFence(block.opening, block.body, block.marker, budget)
      : splitPlainText(block.text, budget);
  });

  const chunks: string[] = [];
  for (const piece of pieces) {
    const prior = chunks.at(-1);
    if (prior !== undefined && characterCount(prior + piece) <= budget) {
      chunks[chunks.length - 1] = prior + piece;
    } else {
      chunks.push(piece);
    }
  }
  return chunks;
}

function markdownBlocks(value: string): MarkdownBlock[] {
  const lines = value.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const blocks: MarkdownBlock[] = [];
  let plain = "";

  const flushPlain = (): void => {
    if (plain.length === 0) return;
    blocks.push({ kind: "plain", text: plain });
    plain = "";
  };

  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index]!;
    const match = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(opening);
    if (match === null) {
      plain += opening;
      continue;
    }

    flushPlain();
    const marker = match[1]!;
    const closingPattern = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)`);
    let body = "";
    let closing = "";
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (closingPattern.test(line)) {
        closing = line;
        break;
      }
      body += line;
    }
    blocks.push({ kind: "fence", text: opening + body + closing, opening, body, marker });
  }

  flushPlain();
  return blocks;
}

function splitOversizedFence(
  opening: string,
  body: string,
  marker: string,
  budget: number,
): string[] {
  const normalizedOpening = opening.endsWith("\n") ? opening : `${opening}\n`;
  const wrapperSize = characterCount(normalizedOpening) + characterCount(marker) + 2;
  const bodyBudget = budget - wrapperSize;
  if (bodyBudget <= 0) {
    // A valid fenced block cannot fit. Preserve its payload as plain text rather
    // than emitting unmatched fence markers.
    return splitPlainText(body.length === 0 ? opening.replace(marker, "") : body, budget);
  }

  const fragments = body.length === 0 ? [""] : splitPlainText(body, bodyBudget);
  return fragments.map((fragment) => {
    const beforeClose = fragment.endsWith("\n") ? "" : "\n";
    return `${normalizedOpening}${fragment}${beforeClose}${marker}\n`;
  });
}

function splitPlainText(value: string, budget: number): string[] {
  const characters = Array.from(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; ) {
    const limit = Math.min(offset + budget, characters.length);
    let end = limit;
    if (limit < characters.length) {
      const candidate = characters.slice(offset, limit).join("");
      const minimum = Math.floor(budget / 2);
      const paragraph = candidate.lastIndexOf("\n\n");
      const line = candidate.lastIndexOf("\n");
      const space = candidate.lastIndexOf(" ");
      const boundary =
        paragraph >= minimum
          ? paragraph + 2
          : line >= minimum
            ? line + 1
            : space >= minimum
              ? space + 1
              : 0;
      if (boundary > 0) end = offset + Array.from(candidate.slice(0, boundary)).length;
    }
    chunks.push(characters.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function segmentIdentity(runId: string, index: number): string {
  return `${runId}:segment:${index}`;
}

function logicalMessageId(messageId: string): string {
  const revision = messageId.indexOf(":revision:");
  return revision === -1 ? messageId : messageId.slice(0, revision);
}

function appendActiveMessages(segment: RealizedSegment | undefined): RealizedMessage[] {
  if (segment === undefined) return [];
  if (segment.activeMessageIds !== undefined) {
    const byId = new Map(segment.messages.map((message) => [message.id, message]));
    return segment.activeMessageIds.flatMap((id) => {
      const message = byId.get(id);
      return message === undefined ? [] : [message];
    });
  }

  const latestByLogicalId = new Map<string, RealizedMessage>();
  for (const message of segment.messages) {
    const logicalId = logicalMessageId(message.id);
    const current = latestByLogicalId.get(logicalId);
    if (current === undefined || message.index > current.index) {
      latestByLogicalId.set(logicalId, message);
    }
  }
  return [...latestByLogicalId.values()];
}

function operationIdentity(
  message: Pick<RealizedMessage, "id" | "index" | "contentHash">,
  kind: RenderOperation["type"],
  appliedCursor: number,
): Omit<RenderOperation, "type" | "content" | "finalized" | "remoteRef" | "text"> {
  const segmentId = message.id.slice(0, message.id.lastIndexOf(":message:"));
  const segmentIndexText = segmentId.slice(segmentId.lastIndexOf(":") + 1);
  return {
    id:
      kind === "create"
        ? `${message.id}:create`
        : `${message.id}:${kind}:${appliedCursor}:${message.contentHash}`,
    messageId: message.id,
    segmentId,
    segmentIndex: Number(segmentIndexText),
    messageIndex: message.index,
  };
}

function withoutContent(message: PlannedMessage): RealizedMessage {
  return {
    id: message.id,
    index: message.index,
    text: message.text,
    contentHash: message.contentHash,
    finalized: message.finalized,
    ...(message.remoteRef === undefined ? {} : { remoteRef: message.remoteRef }),
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  };
}

function priorRenderState(
  message: Pick<RealizedMessage, "text" | "metadata">,
): NonNullable<Extract<RenderOperation, { type: "append" }>["prior"]> {
  return {
    text: message.text,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  };
}

function fingerprint(value: string): string {
  // FNV-1a is sufficient here: this is a change fingerprint, never a security
  // boundary. Keeping it local also leaves the renderer package browser-safe.
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableSerialize(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nested: unknown) => {
      if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested;
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }) ?? "undefined"
  );
}

function isTerminal(status: Projection["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
