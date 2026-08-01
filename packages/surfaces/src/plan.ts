import type { Part, Projection, Segment } from "@trema/projection";

import type {
  ApplyResult,
  CapabilityDescriptor,
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
  realization: Pick<SurfaceRealization, "runId" | "renderedThroughSeq" | "segments" | "version">,
  capabilities: CapabilityDescriptor,
): RenderPlan {
  if (projection.runId !== realization.runId) {
    throw new Error(
      `projection run ${projection.runId} does not match realization run ${realization.runId}`,
    );
  }
  if (!Number.isSafeInteger(capabilities.budgets.messageChars)) {
    throw new Error("messageChars must be a safe integer");
  }
  if (capabilities.budgets.messageChars <= 0) {
    throw new Error("messageChars must be greater than zero");
  }

  const terminal = isTerminal(projection.status);
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

  for (const segment of projection.segments) {
    // An append-only destination cannot correct an in-flight message. Wait for
    // its semantic boundary, then deliver the settled snapshot once.
    if (capabilities.mutation === "append-only" && segment.end === undefined && !terminal) {
      continue;
    }

    const segmentId = segmentIdentity(projection.runId, segment.index);
    const existing = existingById.get(segmentId);
    const planned = realizeSegment(segment, segmentId, capabilities.budgets.messageChars, terminal);
    const messages: RealizedMessage[] =
      capabilities.mutation === "append-only" ? [...(existing?.messages ?? [])] : [];

    for (const target of planned) {
      if (capabilities.mutation === "append-only") {
        const applied = existing?.messages.find(
          (message) =>
            (message.id === target.id || message.id.startsWith(`${target.id}:revision:`)) &&
            message.contentHash === target.contentHash &&
            message.finalized === target.finalized,
        );
        if (applied !== undefined) continue;

        const hasPrior = existing?.messages.some(
          (message) => message.id === target.id || message.id.startsWith(`${target.id}:revision:`),
        );
        const immutableTarget = hasPrior
          ? {
              ...target,
              id: `${target.id}:revision:${target.contentHash}`,
              index: messages.length,
            }
          : target;
        operations.push({
          ...operationIdentity(immutableTarget, "create", realization.version),
          type: "create",
          content: immutableTarget.content,
          finalized: true,
        });
        messages.push(withoutContent({ ...immutableTarget, finalized: true }));
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
          ...operationIdentity(target, "create", realization.version),
          type: "create",
          content: target.content,
          finalized: target.finalized,
        });
      } else if (target.text !== prior.text) {
        if (
          !target.finalized &&
          capabilities.streaming === "delta" &&
          projection.lastSeq === realization.renderedThroughSeq + 1 &&
          target.text.startsWith(prior.text)
        ) {
          operations.push({
            ...operationIdentity(target, "append", realization.version),
            type: "append",
            remoteRef: prior.remoteRef,
            text: target.text.slice(prior.text.length),
          });
        } else {
          operations.push({
            ...operationIdentity(
              target,
              target.finalized ? "finalize" : "replace",
              realization.version,
            ),
            type: target.finalized ? "finalize" : "replace",
            remoteRef: prior.remoteRef,
            content: target.content,
          });
        }
      } else if (target.finalized && !prior.finalized) {
        operations.push({
          ...operationIdentity(target, "finalize", realization.version),
          type: "finalize",
          remoteRef: prior.remoteRef,
          content: target.content,
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
            ...operationIdentity(prior, "delete", realization.version),
            type: "delete",
            remoteRef: prior.remoteRef,
          });
        } else if (capabilities.mutation !== "edit") {
          messages.push(prior);
        }
      }
    }

    if (messages.length > 0) {
      nextSegments.push({ id: segmentId, index: segment.index, messages });
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
        ...operationIdentity(message, "delete", realization.version),
        type: "delete",
        remoteRef: message.remoteRef,
      });
    }
  }

  nextSegments.sort((left, right) => left.index - right.index);
  return {
    fromCursor: realization.renderedThroughSeq,
    toCursor: projection.lastSeq,
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
): PlannedMessage[] {
  const content = segment.parts.map((part) => ({ part, text: partText(part) })).filter(hasText);
  const chunks = chunkContent(content, budget);
  const finalized = terminal || segment.end !== undefined;
  return chunks.map((renderContent, index) => {
    const id = `${segmentId}:message:${index}`;
    return {
      id,
      index,
      text: renderContent.text,
      contentHash: fingerprint(renderContent.text),
      finalized,
      content: renderContent,
    };
  });
}

function hasText(value: { part: Part; text: string }): boolean {
  return value.text.length > 0;
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
  let current: RenderContent | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    chunks.push(current);
    current = undefined;
  };

  for (const { part, text } of content) {
    const separator = current === undefined ? "" : "\n\n";
    if (current !== undefined && characterCount(`${current.text}${separator}${text}`) <= budget) {
      current = { text: `${current.text}${separator}${text}`, parts: [...current.parts, part] };
      continue;
    }

    flush();
    const fragments = splitMarkdownAtBudget(text, budget);
    for (const [index, fragment] of fragments.entries()) {
      const fragmentPart = partFragment(part, fragment, fragments.length, index);
      const next = { text: fragment, parts: fragmentPart === undefined ? [] : [fragmentPart] };
      if (index === fragments.length - 1) current = next;
      else chunks.push(next);
    }
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

function operationIdentity(
  message: Pick<RealizedMessage, "id" | "index" | "contentHash">,
  kind: RenderOperation["type"],
  realizationVersion: number,
): Omit<RenderOperation, "type" | "content" | "finalized" | "remoteRef" | "text"> {
  const segmentId = message.id.slice(0, message.id.lastIndexOf(":message:"));
  const segmentIndexText = segmentId.slice(segmentId.lastIndexOf(":") + 1);
  return {
    id:
      kind === "create"
        ? `${message.id}:create`
        : `${message.id}:${kind}:${realizationVersion}:${message.contentHash}`,
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

function isTerminal(status: Projection["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
