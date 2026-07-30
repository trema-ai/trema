import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { bindLogger, log } from "#server/lib/logger/index.js";
import { type CapabilityKey, enabledCapabilityKeys } from "#server/services/capabilities/index.js";
import {
  fetchUrl,
  fetchUrlInputSchema,
  searchWeb,
  searchWebInputSchema,
  WebCapabilityError,
} from "#server/services/capabilities/web.js";
import type {
  ConnectorFetch,
  McpClientFactory,
  PlatformAppDirectory,
} from "#server/services/connectors/index.js";
import { searchConnectorTools } from "#server/services/connectors/tool-search.js";
import { describeConnectorFailure, useConnector } from "#server/services/dataplane/connector.js";
import {
  type DataPlaneSession,
  DataPlaneToolError,
  getContextItem,
  searchContext,
  toDataPlaneSession,
} from "#server/services/dataplane/index.js";
import { saveMemory, updateMemory } from "#server/services/dataplane/memory.js";
import {
  fetchTranscriptInputSchema,
  getItemInputSchema,
  itemKindSchema,
  saveMemoryInputSchema,
  searchContextInputSchema,
  searchToolsInputSchema,
  USE_CONNECTOR_DESCRIPTION,
  USE_CONNECTOR_TITLE,
  USE_CONNECTOR_TOOL_NAME,
  updateMemoryInputSchema,
  useConnectorInputSchema,
} from "#server/services/dataplane/tools.js";
import { fetchTranscript } from "#server/services/dataplane/transcript.js";
import { ItemValidationError, memoryTypes } from "#server/services/items/index.js";
import {
  authenticateSession,
  isSessionExpired,
  SessionAuthenticationError,
} from "#server/services/sessions/index.js";

export const DATA_PLANE_SERVER_NAME = "trema-context";
export const DATA_PLANE_SERVER_VERSION = "1.0.0";

const searchResultSchema = z
  .object({
    id: z.string().describe("The item ID. Pass it to `get_item` for the body."),
    kind: itemKindSchema,
    title: z.string().describe("The item's title."),
    snippet: z.string().describe("A bounded excerpt of the matching text."),
    score: z.number().describe("The relevance score. Higher matches better."),
  })
  .describe("One match. The item body is never included.");

export interface DataPlaneDependencies {
  db: Database;
  env: Environment;
  /** The outbound fetch connector calls are proxied through. */
  connectorFetch?: ConnectorFetch;
  mcpClientFactory?: McpClientFactory;
  platformApps?: PlatformAppDirectory;
  providerFetch?: typeof fetch;
}

function textResult(payload: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(payload) }];
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * A refusal the harness can switch on. The message is for the model; the code
 * is the machine-readable half — `reconnect_needed` means send the person to
 * the reconnect flow, `args_changed` means ask for a new approval, and neither
 * is something to retry blindly.
 */
function codedToolError(code: string, message: string): CallToolResult {
  return { content: textResult({ code, message }), isError: true };
}

interface ToolErrorHandling {
  /** Turn a known failure into a result the model can act on. */
  describe?: (error: unknown) => { code: string; message: string } | undefined;
  /**
   * Whether an unexplained failure may be logged with the raw error object.
   * The connector path says no: a provider library's error can quote the
   * request that produced it, credential header included, and that path has
   * already logged a redacted summary where the failure happened.
   */
  logRawFailure?: boolean;
}

// A tool call reports its own failures as data: an MCP client shows the text to
// the model, which can then try something else. Only an unexplained failure is
// the server's incident, and its detail stays in the log.
async function runTool(
  name: string,
  run: () => Promise<CallToolResult>,
  handling: ToolErrorHandling = {},
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    const described = handling.describe?.(error);
    if (described) return codedToolError(described.code, described.message);
    if (error instanceof DataPlaneToolError) return toolError(error.message);
    if (error instanceof WebCapabilityError) return codedToolError(error.code, error.message);
    // A body the service rejects is the caller's mistake as well, and its
    // message names the field to fix.
    if (error instanceof ItemValidationError) return toolError(error.message);
    if (handling.logRawFailure === false) {
      // The class of failure is safe to name and is often the whole diagnosis;
      // its message is not, because it may be a provider library's and quote
      // the request it failed on. Nothing here holds a redactor to clean it.
      log.error("Data-plane tool failed", {
        tool: name,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    } else {
      log.error("Data-plane tool failed", { tool: name, error });
    }
    return toolError("The context app could not complete the call");
  }
}

/**
 * Build the data-plane tool surface for one session. The tools close over the
 * session, so scope enforcement is in the handler and never a request field a
 * caller could set.
 */
export function createDataPlaneServer(
  dependencies: DataPlaneDependencies,
  session: DataPlaneSession,
  enabledCapabilities: readonly CapabilityKey[] = [],
): McpServer {
  const { db, env } = dependencies;
  const embedding = env.TREMA_CREDENTIAL_MASTER_KEY
    ? { masterKey: env.TREMA_CREDENTIAL_MASTER_KEY }
    : {};
  const connectorDependencies = {
    ...embedding,
    ...(dependencies.connectorFetch ? { fetch: dependencies.connectorFetch } : {}),
    ...(dependencies.mcpClientFactory ? { clientFactory: dependencies.mcpClientFactory } : {}),
    ...(dependencies.platformApps ? { platformApps: dependencies.platformApps } : {}),
  };
  const server = new McpServer(
    {
      name: DATA_PLANE_SERVER_NAME,
      title: "Trema context",
      version: DATA_PLANE_SERVER_VERSION,
    },
    {
      instructions:
        "Search this organization's context before you answer, read the matches you need, and save what is worth remembering. Every tool is scoped to the session; there is nothing to filter by hand.",
    },
  );

  server.registerTool(
    "search_context",
    {
      title: "Search context",
      description:
        "Search the organization's active context for items relevant to a question. Returns titles and short excerpts, never full bodies — call `get_item` with an id to read one.",
      inputSchema: searchContextInputSchema,
      outputSchema: { results: z.array(searchResultSchema) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, kinds, limit }) =>
      runTool("search_context", async () => {
        const results = await searchContext(db, session, {
          query,
          ...(kinds ? { kinds } : {}),
          ...(limit === undefined ? {} : { limit }),
          ...embedding,
        });
        return { content: textResult({ results }), structuredContent: { results } };
      }),
  );

  if (enabledCapabilities.includes("web.search")) {
    server.registerTool(
      "search_web",
      {
        title: "Search the web",
        description:
          "Search the public web for current information. Returns ranked page titles, URLs, and bounded snippets. Use `fetch_url` to read a promising page.",
        inputSchema: searchWebInputSchema,
        outputSchema: {
          results: z.array(
            z.object({
              title: z.string(),
              url: z.url(),
              snippet: z.string(),
              publishedAt: z.string().optional(),
            }),
          ),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (input) =>
        runTool("search_web", async () => {
          const searched = await searchWeb(db, session, input, {
            ...embedding,
            ...(dependencies.providerFetch ? { providerFetch: dependencies.providerFetch } : {}),
          });
          return { content: textResult(searched), structuredContent: { ...searched } };
        }),
    );
  }

  if (enabledCapabilities.includes("web.fetch")) {
    server.registerTool(
      "fetch_url",
      {
        title: "Fetch URL",
        description:
          "Extract one public HTTP or HTTPS page as bounded text through the configured provider.",
        inputSchema: fetchUrlInputSchema,
        outputSchema: {
          url: z.url(),
          title: z.string().optional(),
          contentType: z.string(),
          text: z.string(),
          truncated: z.boolean(),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (input) =>
        runTool("fetch_url", async () => {
          const fetched = await fetchUrl(db, session, input, {
            ...embedding,
            ...(dependencies.providerFetch ? { providerFetch: dependencies.providerFetch } : {}),
          });
          return { content: textResult(fetched), structuredContent: { ...fetched } };
        }),
    );
  }

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description:
        "Read one context item in full, by id. The id comes from `search_context`. Reading an item records that this run used it.",
      inputSchema: getItemInputSchema,
      outputSchema: {
        id: z.string().describe("The item ID."),
        kind: itemKindSchema,
        title: z.string().describe("The item's title."),
        body: z.record(z.string(), z.unknown()).describe("The kind-specific item body."),
        scopeId: z.string().describe("The scope the item belongs to."),
        disclosure: z
          .enum(["standing", "retrieved"])
          .describe("Whether the item is injected into every session or read on demand."),
        version: z.number().int().describe("The item's version. Every edit bumps it."),
        updatedAt: z.string().describe("When the item last changed. An ISO 8601 date-time."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      runTool("get_item", async () => {
        const item = await getContextItem(db, session, id);
        const structuredContent = {
          id: item.id,
          kind: item.kind,
          title: item.title,
          body: item.body as Record<string, unknown>,
          scopeId: item.scopeId,
          disclosure: item.disclosure,
          version: item.version,
          updatedAt: item.updatedAt.toISOString(),
        };
        return { content: textResult(structuredContent), structuredContent };
      }),
  );

  server.registerTool(
    "save_memory",
    {
      title: "Save memory",
      description:
        "Remember something for later runs. A `fact` or a `preference` takes effect at once; a `rule` or a `procedure` is proposed and waits for a person to confirm it. The memory is saved at this session's scope. When it restates a memory that is already there, it replaces it and the reply names what it superseded.",
      inputSchema: saveMemoryInputSchema,
      outputSchema: {
        id: z.string().describe("The memory's item ID."),
        type: z.enum(memoryTypes).describe("The memory type, as given."),
        title: z.string().describe("The memory's title."),
        scopeId: z.string().describe("The scope the memory was saved at."),
        status: z
          .enum(["active", "proposed", "archived"])
          .describe("`active` is in use now; `proposed` waits for a person to confirm it."),
        version: z.number().int().describe("The memory's version. Every edit bumps it."),
        superseded: z
          .string()
          .nullable()
          .describe("The ID of the memory this write replaced, or null when nothing matched."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ type, title, content }) =>
      runTool("save_memory", async () => {
        const { item, supersededId } = await saveMemory(db, session, {
          type,
          title,
          content,
          ...embedding,
        });
        const structuredContent = {
          id: item.id,
          type,
          title: item.title,
          scopeId: item.scopeId,
          status: item.status,
          version: item.version,
          superseded: supersededId ?? null,
        };
        return { content: textResult(structuredContent), structuredContent };
      }),
  );

  server.registerTool(
    "update_memory",
    {
      title: "Update memory",
      description:
        "Rewrite a memory that is now wrong or out of date. The memory keeps its type and title, and the earlier wording stays in its history. Only memories saved at this session's own scope can be rewritten, and only facts and preferences — a confirmed rule or procedure needs a person.",
      inputSchema: updateMemoryInputSchema,
      outputSchema: {
        id: z.string().describe("The memory's item ID."),
        type: z.enum(memoryTypes).describe("The memory type. An update never changes it."),
        title: z.string().describe("The memory's title. An update never changes it."),
        scopeId: z.string().describe("The scope the memory belongs to."),
        status: z.enum(["active", "proposed", "archived"]).describe("The memory's status."),
        version: z.number().int().describe("The memory's new version."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id, content }) =>
      runTool("update_memory", async () => {
        const item = await updateMemory(db, session, { itemId: id, content, ...embedding });
        const structuredContent = {
          id: item.id,
          type: (item.body as { type: (typeof memoryTypes)[number] }).type,
          title: item.title,
          scopeId: item.scopeId,
          status: item.status,
          version: item.version,
        };
        return { content: textResult(structuredContent), structuredContent };
      }),
  );

  server.registerTool(
    "fetch_transcript",
    {
      title: "Fetch transcript",
      description:
        "Read part of a captured conversation, word for word. Use it when a summary is not enough — the exact wording, an error string, or what came just before or after a message. The window is bounded: ask for a place in the thread and read around it, then ask again to move.",
      inputSchema: fetchTranscriptInputSchema,
      outputSchema: {
        conversationId: z.string().describe("The conversation's ID."),
        surface: z.string().describe("The surface the conversation happened on."),
        threadRef: z
          .string()
          .describe("The thread within the location. Empty when the surface reported none."),
        participants: z
          .array(
            z.object({
              principalId: z
                .string()
                .nullable()
                .describe("The participant's principal ID, when they are linked to one."),
              externalRef: z
                .string()
                .nullable()
                .describe("The participant's raw surface id, when they have no link."),
            }),
          )
          .describe("Everyone seen in the thread so far."),
        messageCount: z.number().int().describe("How many messages the whole conversation holds."),
        firstSeq: z
          .number()
          .int()
          .nullable()
          .describe("The first message number in the conversation. Null when it is empty."),
        lastSeq: z
          .number()
          .int()
          .nullable()
          .describe("The last message number in the conversation. Null when it is empty."),
        hasMoreBefore: z
          .boolean()
          .describe("Whether messages sit before this window. Ask again with a lower `aroundSeq`."),
        hasMoreAfter: z
          .boolean()
          .describe("Whether messages sit after this window. Ask again with a higher `aroundSeq`."),
        messages: z
          .array(
            z.object({
              seq: z.number().int().describe("The message's place in the thread."),
              sentAt: z.string().describe("When the message was sent. An ISO 8601 date-time."),
              authorPrincipalId: z
                .string()
                .nullable()
                .describe("The author's principal ID, when they are linked to one."),
              authorExternalRef: z
                .string()
                .nullable()
                .describe("The author's raw surface id, when they have no link."),
              text: z.string().describe("What was said, word for word."),
            }),
          )
          .describe("The window, oldest message first."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ conversationId, aroundSeq, window }) =>
      runTool("fetch_transcript", async () => {
        const transcript = await fetchTranscript(db, session, {
          conversationId,
          ...(aroundSeq === undefined ? {} : { aroundSeq }),
          ...(window === undefined ? {} : { window }),
        });
        const structuredContent = {
          conversationId: transcript.conversationId,
          surface: transcript.surface,
          threadRef: transcript.threadRef,
          participants: transcript.participants,
          messageCount: transcript.messageCount,
          firstSeq: transcript.firstSeq,
          lastSeq: transcript.lastSeq,
          hasMoreBefore: transcript.hasMoreBefore,
          hasMoreAfter: transcript.hasMoreAfter,
          messages: transcript.messages.map((message) => ({
            seq: message.seq,
            sentAt: message.sentAt.toISOString(),
            authorPrincipalId: message.authorPrincipalId,
            authorExternalRef: message.authorExternalRef,
            text: message.text,
          })),
        };
        return { content: textResult(structuredContent), structuredContent };
      }),
  );

  server.registerTool(
    "search_tools",
    {
      title: "Search connector tools",
      description:
        "Search current authorized connected-system operations with lexical and semantic ranking. Returns tool keys and input schemas for use with `use_connector`.",
      inputSchema: searchToolsInputSchema,
      outputSchema: {
        tools: z.array(
          z.object({
            key: z.string(),
            name: z.string(),
            title: z.string(),
            description: z.string(),
            inputSchema: z.record(z.string(), z.unknown()),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      runTool("search_tools", async () => {
        const tools = await searchConnectorTools(db, session, input, embedding);
        const structuredContent = {
          tools: tools.map(({ key, name, title, description, schema }) => ({
            key: key!,
            name,
            title,
            description,
            inputSchema: schema as Record<string, unknown>,
          })),
        };
        return { content: textResult(structuredContent), structuredContent };
      }),
  );

  server.registerTool(
    USE_CONNECTOR_TOOL_NAME,
    {
      title: USE_CONNECTOR_TITLE,
      description: USE_CONNECTOR_DESCRIPTION,
      // Shared with session resolution, which renders the same shape for the
      // model port — one definition, two transports.
      inputSchema: useConnectorInputSchema,
      outputSchema: {
        status: z
          .enum(["executed", "approval_required"])
          .describe(
            "`executed`: the call ran. `approval_required`: a person must approve it first.",
          ),
        toolKey: z.string().describe("The tool this reply is about."),
        mode: z
          .enum(["ask", "delegated", "full"])
          .describe("The approval mode the call ran under."),
        escalationReason: z
          .string()
          .optional()
          .describe("Why a delegated-mode call paused, when the classifier escalated it."),
        result: z.unknown().optional().describe("What the connected system replied, when it ran."),
        approvalId: z
          .string()
          .optional()
          .describe("The approval waiting on a person. Pass it back once it is approved."),
        expiresAt: z
          .string()
          .optional()
          .describe("When the approval stops waiting. An ISO 8601 date-time."),
        message: z.string().optional().describe("What to say when the call did not run."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ toolKey, args, reason, approvalId }) =>
      runTool(
        "use_connector",
        async () => {
          const outcome = await useConnector(db, session, {
            toolKey,
            args,
            reason,
            ...(approvalId ? { approvalId } : {}),
            ...connectorDependencies,
          });
          return { content: textResult(outcome), structuredContent: { ...outcome } };
        },
        { describe: describeConnectorFailure, logRawFailure: false },
      ),
  );

  return server;
}

/** Every way a data-plane call is refused before a tool runs. */
type DataPlaneRejection =
  | "session_token_required"
  | "invalid_session_token"
  | "session_expired"
  | "session_closed"
  | "sse_unsupported";

// Rejections travel as JSON-RPC errors, so an MCP client surfaces the reason
// instead of an opaque status. The `code` field is what a harness switches on:
// `session_expired` means open a new session, not retry.
function rejection(status: number, code: DataPlaneRejection, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message, data: { code } } },
    { status },
  );
}

async function resolveSession(
  db: Database,
  request: Request,
): Promise<DataPlaneSession | Response> {
  const match = request.headers.get("authorization")?.match(/^Bearer (\S+)$/);
  if (!match) {
    log.warn("Data-plane session token required");
    return rejection(401, "session_token_required", "A session token is required");
  }

  try {
    const session = await authenticateSession(db, match[1]!);
    if (session.closedAt) {
      log.warn("Data-plane call rejected", { sessionId: session.id, reason: "closed" });
      return rejection(401, "session_closed", "Session is already closed");
    }
    if (isSessionExpired(session)) {
      log.warn("Data-plane call rejected", { sessionId: session.id, reason: "expired" });
      return rejection(401, "session_expired", "Session token has expired");
    }
    bindLogger({
      orgId: session.orgId,
      principalId: session.agentPrincipalId,
      sessionId: session.id,
      actor: "session",
    });
    // Projected rather than passed whole: the tools enforce against these
    // fields, and a field they must not read is a field they cannot see.
    return toDataPlaneSession(session);
  } catch (error) {
    if (error instanceof SessionAuthenticationError) {
      log.warn("Data-plane session token rejected");
      return rejection(401, "invalid_session_token", "Invalid session token");
    }
    throw error;
  }
}

/**
 * Serve one data-plane MCP request.
 *
 * The mount is stateless: every call carries its own session token, so a
 * request builds its own server and transport and drops both when it answers.
 * Nothing is kept between calls, which is what lets any number of processes
 * serve the same session.
 */
export async function handleDataPlaneRequest(
  request: Request,
  dependencies: DataPlaneDependencies,
): Promise<Response> {
  // Server-initiated messages have no place here — every data-plane call is a
  // request the client made. Refusing the standalone stream tells a client to
  // stop waiting for one; the specification allows exactly this answer.
  if (request.method === "GET") {
    return rejection(405, "sse_unsupported", "This endpoint does not open a server stream");
  }

  const resolved = await resolveSession(dependencies.db, request);
  if (resolved instanceof Response) return resolved;

  const capabilities = await enabledCapabilityKeys(dependencies.db, resolved.orgId);
  const server = createDataPlaneServer(dependencies, resolved, capabilities);
  // No session id generator: the transport stays stateless, because the
  // session token already identifies everything the call needs.
  const transport = new WebStandardStreamableHTTPServerTransport({
    // The response body is complete when handleRequest resolves, so the
    // request owns the whole exchange and can close the server after it.
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
