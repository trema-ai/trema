import {
  assertSlackOk,
  callSlackApi,
  postSlackMessage,
  resolveSlackBotToken,
  updateSlackMessage,
} from "@chat-adapter/slack/api";
import { inputRequestToSlackBlocks } from "@chat-adapter/slack/blocks";
import { linkBareSlackMentions, markdownBoldToSlackMrkdwn } from "@chat-adapter/slack/format";
import type {
  AppliedOperation,
  ApplyResult,
  CapabilityDescriptor,
  ElicitationContent,
  MessageContent,
  RenderOperation,
  SurfaceRef,
  SurfaceRenderDriver,
} from "#chat/contracts.js";
import { SurfaceDriverError } from "#chat/errors.js";
import type { SlackDriverOptions } from "#chat/slack/contracts.js";
import { mapSlackError } from "#chat/slack/errors.js";

export const slackCapabilities = {
  mutation: "edit",
  streaming: "delta",
  dialect: "mrkdwn",
  affordances: {
    buttons: true,
    files: true,
    presence: true,
    reactions: true,
    threads: true,
  },
  budgets: {
    actionsPerMessage: 25,
    firstPaintMs: 3_000,
    flushIntervalMs: 600,
    messageChars: 11_500,
  },
  quirks: {
    blocksOnlyAtFinal: true,
    ephemeralImmutable: true,
    updateAppends: ["task_update.details"],
  },
} as const satisfies CapabilityDescriptor;

interface RealizedMessage {
  blocks?: unknown[];
  text: string;
}

interface SlackStreamResponse {
  error?: string;
  ok: boolean;
  ts?: string;
  [key: string]: unknown;
}

const SLACK_SECTION_TEXT_LIMIT = 3_000;
const SLACK_MRKDWN_TOKEN =
  /```[\s\S]*?```|`[^`\n]*`|<[^>\n]+>|\*(?=\S)[^*\n]*\S\*|_(?=\S)[^_\n]*\S_|~(?=\S)[^~\n]*\S~/gu;

export class SlackDriver implements SurfaceRenderDriver {
  readonly capabilities = slackCapabilities;
  readonly #options: SlackDriverOptions;

  constructor(options: SlackDriverOptions) {
    this.#options = options;
  }

  async apply(operations: readonly RenderOperation[], surface: SurfaceRef): Promise<ApplyResult> {
    const applied: AppliedOperation[] = [];
    for (const operation of operations) {
      applied.push(await this.#applyOne(operation, surface));
    }
    return { applied };
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

  async #applyOne(operation: RenderOperation, surface: SurfaceRef): Promise<AppliedOperation> {
    switch (operation.type) {
      case "post":
        return this.#post(operation.operationId, operation.content, surface);
      case "replace":
        return this.#replace(
          operation.operationId,
          operation.messageRef,
          operation.content,
          surface,
        );
      case "stream-start":
        return this.#startStream(operation.operationId, operation.initialMarkdown, surface);
      case "stream-append":
        return this.#appendStream(
          operation.operationId,
          operation.messageRef,
          operation.deltaMarkdown,
          surface,
        );
      case "stream-stop":
        return this.#stopStream(operation, surface);
    }
  }

  async #post(
    operationId: string,
    content: MessageContent,
    surface: SurfaceRef,
  ): Promise<AppliedOperation> {
    const realized = realizeMessage(content);
    const posted = await this.#sdkCall("chat.postMessage", (request) =>
      postSlackMessage({
        channel: surface.channelRef,
        text: realized.text,
        threadTs: surface.threadRef,
        token: this.#options.token,
        ...(realized.blocks === undefined ? {} : { blocks: realized.blocks }),
        ...(this.#options.apiUrl === undefined ? {} : { apiUrl: this.#options.apiUrl }),
        fetch: request,
      }),
    );
    return { operationId, messageRef: posted.id };
  }

  async #replace(
    operationId: string,
    messageRef: string,
    content: MessageContent,
    surface: SurfaceRef,
  ): Promise<AppliedOperation> {
    const realized = realizeMessage(content);
    const updated = await this.#sdkCall("chat.update", (request) =>
      updateSlackMessage({
        channel: surface.channelRef,
        text: realized.text,
        token: this.#options.token,
        ts: messageRef,
        blocks: realized.blocks ?? [],
        ...(this.#options.apiUrl === undefined ? {} : { apiUrl: this.#options.apiUrl }),
        fetch: request,
      }),
    );
    return { operationId, messageRef: updated.id };
  }

  async #startStream(
    operationId: string,
    initialMarkdown: string,
    surface: SurfaceRef,
  ): Promise<AppliedOperation> {
    requireText(initialMarkdown, "stream-start");
    const response = await this.#streamCall("chat.startStream", {
      channel: surface.channelRef,
      markdown_text: initialMarkdown,
      thread_ts: surface.threadRef,
      ...(surface.recipient === undefined
        ? {}
        : {
            recipient_team_id: surface.recipient.teamRef,
            recipient_user_id: surface.recipient.userRef,
          }),
    });
    const messageRef = response.ts;
    if (messageRef === undefined || messageRef.length === 0) {
      throw new SurfaceDriverError("Slack chat.startStream returned no message reference", {
        category: "transient",
        method: "chat.startStream",
        retryable: true,
      });
    }
    return { operationId, messageRef };
  }

  async #appendStream(
    operationId: string,
    messageRef: string,
    deltaMarkdown: string,
    surface: SurfaceRef,
  ): Promise<AppliedOperation> {
    requireText(deltaMarkdown, "stream-append");
    await this.#streamCall("chat.appendStream", {
      channel: surface.channelRef,
      markdown_text: deltaMarkdown,
      ts: messageRef,
    });
    return { operationId, messageRef };
  }

  async #stopStream(
    operation: Extract<RenderOperation, { type: "stream-stop" }>,
    surface: SurfaceRef,
  ): Promise<AppliedOperation> {
    const body: Record<string, unknown> = {
      channel: surface.channelRef,
      ts: operation.messageRef,
    };
    if (operation.finalMarkdown !== undefined) body.markdown_text = operation.finalMarkdown;
    if (operation.elicitation !== undefined) {
      body.blocks = realizeElicitation(operation.elicitation);
    }
    await this.#streamCall("chat.stopStream", body);
    return { operationId: operation.operationId, messageRef: operation.messageRef };
  }

  async #streamCall(method: string, body: Record<string, unknown>): Promise<SlackStreamResponse> {
    return this.#sdkCall(method, async (request) => {
      const response = await callSlackApi<SlackStreamResponse>(method, body, {
        token: this.#options.token,
        contentType: "json",
        ...(this.#options.apiUrl === undefined ? {} : { apiUrl: this.#options.apiUrl }),
        fetch: request,
      });
      assertSlackOk(method, response);
      return response;
    });
  }

  async #sdkCall<T>(method: string, call: (request: typeof fetch) => Promise<T>): Promise<T> {
    let retryAfterMs: number | undefined;
    const baseFetch = this.#options.fetch ?? fetch;
    const request: typeof fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (response.status === 429) retryAfterMs = parseRetryAfter(response.headers);
      return response;
    };
    try {
      return await call(request);
    } catch (error) {
      throw mapSlackError(error, method, retryAfterMs);
    }
  }
}

function realizeMessage(content: MessageContent): RealizedMessage {
  const text = toSlackMrkdwn(content.markdown);
  if (content.elicitation === undefined) return { text };

  const elicitationBlocks = realizeElicitation(content.elicitation);
  const blocks = [...slackMarkdownSections(text), ...elicitationBlocks];
  const optionText = content.elicitation.options.map((option) => option.label).join(", ");
  const fallback = [text, toSlackMrkdwn(content.elicitation.prompt), optionText]
    .filter(Boolean)
    .join("\n\n");
  return { blocks, text: fallback };
}

function slackMarkdownSections(text: string): unknown[] {
  return splitSlackMrkdwn(text).map(slackMarkdownSection);
}

function slackMarkdownSection(text: string): unknown {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function realizeElicitation(elicitation: ElicitationContent): unknown[] {
  const prompt = toSlackMrkdwn(elicitation.prompt);
  const [firstPrompt = "", ...remainingPrompt] = splitSlackMrkdwn(prompt);
  const generated = inputRequestToSlackBlocks({
    prompt: firstPrompt,
    requestId: elicitation.id,
    options: elicitation.options,
  });
  const promptBlock = generated[0];
  if (promptBlock === undefined || remainingPrompt.length === 0) return generated;
  return [promptBlock, ...remainingPrompt.map(slackMarkdownSection), ...generated.slice(1)];
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
    const index = match.index;
    appendPlain(text.slice(offset, index));
    appendToken(match[0]);
    offset = index + match[0].length;
  }
  appendPlain(text.slice(offset));
  flush();
  return sections;
}

function splitOversizedSlackToken(token: string, limit: number): string[] {
  const delimiter = slackTokenDelimiter(token);
  if (delimiter === undefined)
    return splitSlackPlainText(escapeSlackControlCharacters(token), limit);

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

function escapeSlackControlCharacters(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
  return linkBareSlackMentions(markdownBoldToSlackMrkdwn(markdown));
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function requireText(text: string, operation: string): void {
  if (text.length === 0) {
    throw new SurfaceDriverError(`${operation} requires text`, {
      category: "invalid-request",
      retryable: false,
    });
  }
}
