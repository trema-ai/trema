import { createHash } from "node:crypto";

import { assertSlackOk, callSlackApi, resolveSlackBotToken } from "@chat-adapter/slack/api";
import { inputRequestToSlackBlocks } from "@chat-adapter/slack/blocks";
import { linkBareSlackMentions, markdownBoldToSlackMrkdwn } from "@chat-adapter/slack/format";
import type { ElicitationPart } from "@trema/projection";
import {
  type AppliedMessage,
  type ApplyResult,
  type CapabilityDescriptor,
  type RenderContent,
  type RenderOperation,
  type SurfaceApplyContext,
  type SurfaceDriver,
  SurfaceDriverError,
  type SurfaceEvent,
  type SurfaceRef,
} from "@trema/surfaces";

import type { SlackDriverOptions, SlackRecipient } from "#chat/slack/contracts.js";
import { isSlackPlatformError, mapSlackError } from "#chat/slack/errors.js";
import {
  appendThinkingText,
  changedThinkingChunks,
  initialThinkingChunks,
  parseThinkingState,
  realizeSlackThinking,
  type SlackStreamChunk,
  type SlackThinkingState,
  staticThinkingBlock,
} from "#chat/slack/thinking.js";

export const slackCapabilities = {
  mutation: "edit",
  streaming: "delta",
  dialect: "mrkdwn",
  affordances: {
    buttons: true,
    forms: false,
    files: true,
    presence: true,
    reactions: true,
    threads: true,
  },
  budgets: {
    actionsPerMessage: 25,
    firstPaintMs: 3_000,
    flushIntervalMs: 600,
    // Slack stream markdown is capped at 12,000 characters. Leave room for
    // deterministic fallback text without making the core Slack-aware.
    messageChars: 11_500,
    streamWindowMs: 60_000,
  },
  quirks: {
    blocksOnlyAtFinal: true,
    ephemeralImmutable: true,
    updateAppends: ["task_update.details"],
  },
} as const satisfies CapabilityDescriptor;

interface SlackResponse {
  error?: string;
  ok: boolean;
  ts?: string;
  [key: string]: unknown;
}

interface SlackDestination {
  channelRef: string;
  teamRef?: string;
  threadRef?: string;
}

interface RealizedMessage {
  blocks: unknown[];
  text: string;
}

const SLACK_SECTION_TEXT_LIMIT = 3_000;
const SLACK_MESSAGE_BLOCK_LIMIT = 50;
const SLACK_ACTION_ID_LIMIT = 255;
const SLACK_BUTTON_TEXT_LIMIT = 75;
const SLACK_BUTTON_VALUE_LIMIT = 2_000;
const EMPTY_MESSAGE = "\u200b";
const SLACK_MRKDWN_TOKEN =
  /```[\s\S]*?```|`[^`\n]*`|<[^>\n]+>|:[A-Za-z0-9_+-]+:|\*(?=\S)[^*\n]*\S\*|_(?=\S)[^_\n]*\S_|~(?=\S)[^~\n]*\S~/gu;

/**
 * Durable Slack adapter. Stable operation ids become Slack client message ids,
 * so replay after an uncertain response converges on the same remote message.
 */
export class SlackDriver implements SurfaceDriver {
  readonly capabilities = slackCapabilities;
  readonly #options: SlackDriverOptions;
  #nextRequestAt = 0;
  #requestTail: Promise<void> = Promise.resolve();

  constructor(options: SlackDriverOptions) {
    this.#options = options;
  }

  async apply(operations: RenderOperation[], context: SurfaceApplyContext): Promise<ApplyResult> {
    const destination = slackDestination(context.ref);
    const appliedOperationIds: string[] = [];
    const messages: AppliedMessage[] = [];

    for (const operation of operations) {
      const message = await this.#applyOne(operation, context, destination);
      appliedOperationIds.push(operation.id);
      messages.push(message);
    }
    return { appliedOperationIds, messages };
  }

  async presence(_state: "working" | "idle", _context: SurfaceApplyContext): Promise<void> {
    // DEV-97 owns Slack lifecycle and presence UI. Presence is advisory and is
    // deliberately a no-op until it can be derived from committed run state.
  }

  normalize(_event: unknown, _ref: SurfaceRef): SurfaceEvent | null {
    // Slack webhook normalization remains in SlackIngressDriver. This method
    // satisfies the shared driver seam without making the render adapter route
    // or authorize native ingress payloads.
    return null;
  }

  async callNative(method: string, arguments_: Record<string, unknown>): Promise<unknown> {
    try {
      const token = await resolveSlackBotToken(this.#options.token);
      if (this.#options.nativeCall !== undefined) {
        return await this.#options.nativeCall(method, arguments_, token);
      }
      const { WebClient } = await import("@slack/web-api");
      const client = new WebClient(token, {
        rejectRateLimitedCalls: true,
        retryConfig: { retries: 0 },
        ...(this.#options.apiUrl === undefined ? {} : { slackApiUrl: this.#options.apiUrl }),
      });
      return await client.apiCall(method, arguments_);
    } catch (error) {
      throw mapSlackError(error, method);
    }
  }

  async #applyOne(
    operation: RenderOperation,
    context: SurfaceApplyContext,
    destination: SlackDestination,
  ): Promise<AppliedMessage> {
    switch (operation.type) {
      case "create":
        return this.#create(operation, context, destination);
      case "append": {
        const prior =
          parseThinkingState(operation.prior.metadata) ?? emptyThinkingState(operation.prior.text);
        const next = appendThinkingText(prior, operation.text);
        await this.#call("chat.appendStream", destination.channelRef, {
          channel: destination.channelRef,
          client_msg_id: slackClientMessageId(operation.id),
          chunks: [{ type: "markdown_text", text: nonEmpty(operation.text) }],
          ts: operation.remoteRef,
        });
        return appliedMessage(
          operation,
          operation.remoteRef,
          slackMetadata(operation.prior.metadata, "stream", next),
        );
      }
      case "replace": {
        return this.#replace(operation, destination);
      }
      case "finalize":
        return this.#finalize(operation, destination);
      case "delete":
        try {
          await this.#call("chat.delete", destination.channelRef, {
            channel: destination.channelRef,
            ts: operation.remoteRef,
          });
        } catch (error) {
          // A replayed delete has already converged when Slack no longer has
          // the message. Other not-found cases keep their distinct meaning.
          if (!(error instanceof SurfaceDriverError && error.code === "message_not_found")) {
            throw error;
          }
        }
        return appliedMessage(operation, operation.remoteRef, { mode: "deleted" });
    }
  }

  async #create(
    operation: Extract<RenderOperation, { type: "create" }>,
    context: SurfaceApplyContext,
    destination: SlackDestination,
  ): Promise<AppliedMessage> {
    const clientMessageId = slackClientMessageId(operation.id);
    const thinking = realizeSlackThinking(operation.content, operation.messageId);
    const initial = initialThinkingChunks(thinking);
    if (!operation.finalized) {
      if (destination.threadRef === undefined) {
        throw new SurfaceDriverError(
          "invalid_request",
          "Slack streaming requires a destination thread reference",
          { retryable: false },
        );
      }
      const recipient = await this.#recipient(context);
      const response = await this.#call("chat.startStream", destination.channelRef, {
        channel: destination.channelRef,
        client_msg_id: clientMessageId,
        chunks: nonEmptyChunks(initial.chunks),
        task_display_mode: "plan",
        thread_ts: destination.threadRef,
        ...(recipient === undefined
          ? {}
          : {
              recipient_team_id: recipient.teamRef,
              recipient_user_id: recipient.userRef,
            }),
      });
      return appliedMessage(operation, requiredMessageRef(response, "chat.startStream"), {
        clientMessageId,
        mode: "stream",
        slackThinking: initial.state,
      });
    }

    const realized = realizeMessage(operation.content, operation.messageId);
    const response = await this.#call("chat.postMessage", destination.channelRef, {
      blocks: realized.blocks,
      channel: destination.channelRef,
      client_msg_id: clientMessageId,
      text: realized.text,
      ...(destination.threadRef === undefined ? {} : { thread_ts: destination.threadRef }),
    });
    return appliedMessage(operation, requiredMessageRef(response, "chat.postMessage"), {
      clientMessageId,
      mode: "final",
      slackThinking: initial.state,
    });
  }

  async #replace(
    operation: Extract<RenderOperation, { type: "replace" }>,
    destination: SlackDestination,
  ): Promise<AppliedMessage> {
    const thinking = realizeSlackThinking(operation.content, operation.messageId);
    const prior = parseThinkingState(operation.prior.metadata);
    const priorMode = operation.prior.metadata?.mode;

    if (prior !== undefined && priorMode === "stream") {
      const changed = changedThinkingChunks(thinking, prior);
      if (!changed.narrativeReplaced && !changed.removedTask) {
        if (changed.chunks.length > 0) {
          await this.#call("chat.appendStream", destination.channelRef, {
            channel: destination.channelRef,
            chunks: changed.chunks,
            client_msg_id: slackClientMessageId(operation.id),
            ts: operation.remoteRef,
          });
        }
        return appliedMessage(
          operation,
          operation.remoteRef,
          slackMetadata(operation.prior.metadata, "stream", changed.state),
        );
      }
    }

    // Event-log reconciliation can shrink text or remove tasks, neither of
    // which Slack's append-only stream chunks can express. Converge through a
    // complete Block Kit snapshot instead of duplicating visible content.
    const realized = realizeMessage(operation.content, operation.messageId);
    await this.#call("chat.update", destination.channelRef, {
      blocks: realized.blocks,
      channel: destination.channelRef,
      text: realized.text,
      ts: operation.remoteRef,
    });
    const state = initialThinkingChunks(thinking).state;
    return appliedMessage(
      operation,
      operation.remoteRef,
      slackMetadata(operation.prior.metadata, "snapshot", state),
    );
  }

  async #finalize(
    operation: Extract<RenderOperation, { type: "finalize" }>,
    destination: SlackDestination,
  ): Promise<AppliedMessage> {
    const thinking = realizeSlackThinking(operation.content, operation.messageId);
    const prior = parseThinkingState(operation.prior.metadata);
    const priorMode = operation.prior.metadata?.mode;

    if (prior !== undefined && priorMode === "stream") {
      const changed = changedThinkingChunks(thinking, prior);
      if (!changed.narrativeReplaced && !changed.removedTask) {
        await this.#stopStream(destination.channelRef, {
          channel: destination.channelRef,
          client_msg_id: slackClientMessageId(operation.id),
          ...(changed.chunks.length === 0 ? {} : { chunks: changed.chunks }),
          ...finalizeBlocks(operation.content),
          ts: operation.remoteRef,
        });
        return appliedMessage(
          operation,
          operation.remoteRef,
          slackMetadata(operation.prior.metadata, "final", changed.state),
        );
      }
    }

    if (priorMode === "snapshot" || priorMode === "final") {
      const realized = realizeMessage(operation.content, operation.messageId);
      await this.#call("chat.update", destination.channelRef, {
        blocks: realized.blocks,
        channel: destination.channelRef,
        text: realized.text,
        ts: operation.remoteRef,
      });
    } else {
      await this.#stopStream(destination.channelRef, {
        channel: destination.channelRef,
        client_msg_id: slackClientMessageId(operation.id),
        markdown_text: nonEmpty(operation.content.text),
        ...finalizeBlocks(operation.content),
        ts: operation.remoteRef,
      });
    }
    const state = initialThinkingChunks(thinking).state;
    return appliedMessage(
      operation,
      operation.remoteRef,
      slackMetadata(operation.prior.metadata, "final", state),
    );
  }

  async #recipient(context: SurfaceApplyContext): Promise<SlackRecipient | undefined> {
    const configured = this.#options.recipient;
    return typeof configured === "function" ? configured(context) : configured;
  }

  async #stopStream(destination: string, body: Record<string, unknown>): Promise<void> {
    try {
      await this.#call("chat.stopStream", destination, body);
    } catch (error) {
      // Slack may have finalized the stream before its response was observed.
      // Replaying that durable operation has already converged, but a truly
      // missing message must continue to fail.
      if (!isSlackPlatformError(error, "message_not_in_streaming_state")) throw error;
    }
  }

  async #call(
    method: string,
    destination: string,
    body: Record<string, unknown>,
  ): Promise<SlackResponse> {
    await this.#throttle(destination);
    let retryAfterMs: number | undefined;
    const baseFetch = this.#options.fetch ?? fetch;
    const request: typeof fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (response.status === 429) retryAfterMs = parseRetryAfter(response.headers);
      return response;
    };

    try {
      const response = await callSlackApi<SlackResponse>(method, body, {
        token: this.#options.token,
        contentType: "json",
        ...(this.#options.apiUrl === undefined ? {} : { apiUrl: this.#options.apiUrl }),
        fetch: request,
      });
      assertSlackOk(method, response);
      return response;
    } catch (error) {
      throw mapSlackError(error, method, retryAfterMs);
    }
  }

  async #throttle(_destination: string): Promise<void> {
    const interval =
      this.#options.minRequestIntervalMs ?? this.capabilities.budgets.flushIntervalMs;
    if (interval <= 0) return;

    const previous = this.#requestTail;
    let release: (() => void) | undefined;
    this.#requestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const now = this.#options.now?.() ?? Date.now();
      const delay = Math.max(0, this.#nextRequestAt - now);
      if (delay > 0) {
        await (this.#options.sleep ?? defaultSleep)(delay);
      }
      const afterWait = this.#options.now?.() ?? Date.now();
      this.#nextRequestAt = Math.max(this.#nextRequestAt, afterWait) + interval;
    } finally {
      release?.();
    }
  }
}

function slackDestination(ref: SurfaceRef): SlackDestination {
  if (ref.surface !== "slack") {
    throw new SurfaceDriverError("invalid_request", "Slack driver received a non-Slack surface", {
      retryable: false,
    });
  }
  const separator = ref.locationRef.lastIndexOf(":");
  const teamRef = separator === -1 ? undefined : ref.locationRef.slice(0, separator);
  const channelRef = separator === -1 ? ref.locationRef : ref.locationRef.slice(separator + 1);
  if (!/^[A-Z][A-Z0-9]{1,31}$/.test(channelRef)) {
    throw new SurfaceDriverError("invalid_request", "Slack location has an invalid channel ID", {
      retryable: false,
    });
  }
  return {
    channelRef,
    ...(teamRef === undefined || teamRef.length === 0 ? {} : { teamRef }),
    ...(ref.threadRef === undefined ? {} : { threadRef: ref.threadRef }),
  };
}

function appliedMessage(
  operation: RenderOperation,
  remoteRef: string,
  metadata: Record<string, unknown>,
): AppliedMessage {
  return { messageId: operation.messageId, remoteRef, metadata };
}

function requiredMessageRef(response: SlackResponse, method: string): string {
  if (typeof response.ts === "string" && response.ts.length > 0) return response.ts;
  throw new SurfaceDriverError("unavailable", `Slack ${method} returned no message reference`, {
    retryable: true,
  });
}

function realizeMessage(content: RenderContent, messageId: string): RealizedMessage {
  const thinking = realizeSlackThinking(content, messageId);
  const narrative = toSlackMrkdwn(thinking.narrativeText);
  const text = nonEmpty(toSlackMrkdwn(content.text));
  const plan = staticThinkingBlock(thinking);
  const controls = unresolvedElicitationBlocks(content);
  const sectionLimit = SLACK_MESSAGE_BLOCK_LIMIT - (plan === undefined ? 0 : 1) - controls.length;
  return {
    text,
    blocks: [
      ...(plan === undefined ? [] : [plan]),
      ...slackMarkdownSections(narrative).slice(0, sectionLimit),
      ...controls,
    ],
  };
}

function finalizeBlocks(content: RenderContent): { blocks?: unknown[] } {
  const blocks = unresolvedElicitationBlocks(content);
  return blocks.length === 0 ? {} : { blocks };
}

function unresolvedElicitationBlocks(content: RenderContent): unknown[] {
  const elicitation = content.parts.find(
    (part): part is ElicitationPart =>
      part.kind === "elicitation" && part.blocking && part.resolution === undefined,
  );
  return elicitation === undefined ? [] : realizeElicitation(elicitation);
}

function realizeElicitation(elicitation: ElicitationPart): unknown[] {
  for (const option of elicitation.options) {
    validateSlackField(option.id, SLACK_BUTTON_VALUE_LIMIT, "button value");
  }
  const prompt = toSlackMrkdwn(elicitation.prompt);
  const [firstPrompt = "", ...remainingPrompt] = splitSlackMrkdwn(prompt);
  const generated = inputRequestToSlackBlocks({
    prompt: firstPrompt,
    requestId: elicitation.elicitationId,
    options: elicitation.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.style === undefined ? {} : { style: option.style }),
    })),
  });
  validateSlackInputBlocks(generated);
  const promptBlock = generated[0];
  if (promptBlock === undefined || remainingPrompt.length === 0) return generated;
  return [
    promptBlock,
    ...remainingPrompt.map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
    ...generated.slice(1),
  ];
}

function validateSlackInputBlocks(blocks: readonly Record<string, unknown>[]): void {
  for (const block of blocks) {
    if (!Array.isArray(block.elements)) continue;
    for (const element of block.elements) {
      if (!isRecord(element)) continue;
      validateSlackField(element.action_id, SLACK_ACTION_ID_LIMIT, "action ID");
      validateSlackField(element.value, SLACK_BUTTON_VALUE_LIMIT, "button value");
      if (isRecord(element.text)) {
        validateSlackField(element.text.text, SLACK_BUTTON_TEXT_LIMIT, "button text");
      }
    }
  }
}

function validateSlackField(value: unknown, limit: number, field: string): void {
  if (typeof value !== "string" || value.length <= limit) return;
  throw new SurfaceDriverError(
    "invalid_request",
    `Slack ${field} exceeds the ${limit}-character limit`,
    { retryable: false },
  );
}

function slackMarkdownSections(text: string): unknown[] {
  return splitSlackMrkdwn(text).map((section) => ({
    type: "section",
    text: { type: "mrkdwn", text: section },
  }));
}

function splitSlackMrkdwn(text: string, limit = SLACK_SECTION_TEXT_LIMIT): string[] {
  const sections: string[] = [];
  let current = "";
  let currentLength = 0;

  const flush = (): void => {
    if (currentLength === 0) return;
    sections.push(current);
    current = "";
    currentLength = 0;
  };
  const appendPlain = (plain: string): void => {
    for (const character of plain) {
      if (currentLength === limit) flush();
      current += character;
      currentLength += 1;
    }
  };
  const appendToken = (token: string): void => {
    const tokenLength = Array.from(token).length;
    if (tokenLength > limit) {
      flush();
      sections.push(...splitOversizedSlackToken(token, limit));
      return;
    }
    if (currentLength + tokenLength > limit) flush();
    current += token;
    currentLength += tokenLength;
  };

  let offset = 0;
  for (const match of text.matchAll(SLACK_MRKDWN_TOKEN)) {
    appendPlain(text.slice(offset, match.index));
    appendToken(match[0]);
    offset = match.index + match[0].length;
  }
  appendPlain(text.slice(offset));
  flush();
  return sections;
}

function splitOversizedSlackToken(token: string, limit: number): string[] {
  const delimiter = slackTokenDelimiter(token);
  if (delimiter === undefined) {
    return splitSlackPlainText(escapeSlackControlCharacters(token), limit);
  }
  const delimiterLength = Array.from(delimiter).length;
  const contentLimit = limit - delimiterLength * 2;
  if (contentLimit < 1) return splitSlackPlainText(token, limit);
  const content = token.slice(delimiter.length, -delimiter.length);
  return splitSlackMrkdwn(content, contentLimit).map(
    (section) => `${delimiter}${section}${delimiter}`,
  );
}

function slackTokenDelimiter(token: string): string | undefined {
  if (token.startsWith("```") && token.endsWith("```")) return "```";
  const delimiter = token[0];
  return delimiter !== undefined && "`*_~".includes(delimiter) && token.endsWith(delimiter)
    ? delimiter
    : undefined;
}

function splitSlackPlainText(text: string, limit: number): string[] {
  const characters = Array.from(text);
  const sections: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    sections.push(characters.slice(offset, offset + limit).join(""));
  }
  return sections;
}

function toSlackMrkdwn(markdown: string): string {
  const protectedCode: string[] = [];
  const withoutCode = markdown.replace(/```[\s\S]*?```|`[^`\n]*`/gu, (code) => {
    const placeholder = `\u{e000}${protectedCode.length}\u{e001}`;
    protectedCode.push(code);
    return placeholder;
  });
  const escaped = escapeSlackControlCharacters(withoutCode)
    .replace(/^ {0,3}#{1,6}[ \t]+(.+)$/gmu, "*$1*")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu, "<$2|$1>")
    .replace(/~~([^~\n]+)~~/gu, "~$1~");
  const converted = linkBareSlackMentions(markdownBoldToSlackMrkdwn(escaped));
  return converted.replace(/\u{e000}(\d+)\u{e001}/gu, (_placeholder, index: string) =>
    escapeSlackControlCharacters(protectedCode[Number(index)] ?? ""),
  );
}

function escapeSlackControlCharacters(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackClientMessageId(operationId: string): string {
  const digest = createHash("sha256").update(operationId).digest("hex").slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function nonEmpty(text: string): string {
  return text.length === 0 ? EMPTY_MESSAGE : text;
}

function nonEmptyChunks(chunks: SlackStreamChunk[]): SlackStreamChunk[] {
  return chunks.length === 0 ? [{ type: "markdown_text", text: EMPTY_MESSAGE }] : chunks;
}

function emptyThinkingState(narrativeText: string): SlackThinkingState {
  return { version: 1, narrativeText, planTitled: false, taskFingerprints: {} };
}

function slackMetadata(
  prior: Record<string, unknown> | undefined,
  mode: "final" | "snapshot" | "stream",
  thinking: SlackThinkingState,
): Record<string, unknown> {
  return { ...prior, mode, slackThinking: thinking };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
