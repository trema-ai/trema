import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Database } from "#/lib/db/index.js";
import type { Environment } from "#/lib/env/schema.js";
import { bindLogger, log } from "#/lib/logger/index.js";
import {
  type DataPlaneSession,
  DataPlaneToolError,
  getContextItem,
  SEARCH_CONTEXT_DEFAULT_LIMIT,
  SEARCH_CONTEXT_MAX_LIMIT,
  searchContext,
} from "#/services/dataplane/index.js";
import { saveMemory, updateMemory } from "#/services/dataplane/memory.js";
import { ItemValidationError, memoryTypes } from "#/services/items/index.js";
import {
  authenticateSession,
  isSessionExpired,
  SessionAuthenticationError,
} from "#/services/sessions/index.js";

export const DATA_PLANE_SERVER_NAME = "trema-context";
export const DATA_PLANE_SERVER_VERSION = "1.0.0";

const itemKindSchema = z
  .enum(["memory", "skill", "instruction", "connector", "conversation"])
  .describe("The item kind.");

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
}

function textResult(payload: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: JSON.stringify(payload) }];
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// A tool call reports its own failures as data: an MCP client shows the text to
// the model, which can then try something else. Only an unexplained failure is
// the server's incident, and its detail stays in the log.
async function runTool(name: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DataPlaneToolError) return toolError(error.message);
    // A body the service rejects is the caller's mistake as well, and its
    // message names the field to fix.
    if (error instanceof ItemValidationError) return toolError(error.message);
    log.error("Data-plane tool failed", { tool: name, error });
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
): McpServer {
  const { db, env } = dependencies;
  const embedding = env.TREMA_CREDENTIAL_MASTER_KEY
    ? { masterKey: env.TREMA_CREDENTIAL_MASTER_KEY }
    : {};
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
      inputSchema: {
        query: z.string().min(1).describe("What to look for, in plain words."),
        kinds: z
          .array(itemKindSchema)
          .optional()
          .describe("Restrict the search to these item kinds. Omit it to search all kinds."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_CONTEXT_MAX_LIMIT)
          .optional()
          .describe(`How many matches to return. Defaults to ${SEARCH_CONTEXT_DEFAULT_LIMIT}.`),
      },
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

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description:
        "Read one context item in full, by id. The id comes from `search_context`. Reading an item records that this run used it.",
      inputSchema: {
        id: z.string().min(1).describe("The item ID, as returned by `search_context`."),
      },
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
      inputSchema: {
        type: z
          .enum(memoryTypes)
          .describe(
            "fact: something true about the world. preference: how someone likes work done. rule: guidance to follow every time. procedure: the steps for a recurring task.",
          ),
        title: z.string().min(1).describe("A short name for the memory, in plain words."),
        content: z.string().min(1).describe("The memory itself, written to be read months later."),
      },
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
      inputSchema: {
        id: z.string().min(1).describe("The memory's item ID, from `search_context`."),
        content: z.string().min(1).describe("What the memory should say now, in full."),
      },
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
      principalId: session.actingPrincipalId,
      sessionId: session.id,
      actor: "session",
    });
    return session;
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

  const server = createDataPlaneServer(dependencies, resolved);
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
