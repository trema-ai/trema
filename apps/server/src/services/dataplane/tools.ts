import { createHash } from "node:crypto";

import { loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";
import type { ToolDef, ToolKind } from "@trema/harness";
import { z } from "zod";

import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import type { CapabilityKey } from "#server/services/capabilities/index.js";
import { fetchUrlInputSchema, searchWebInputSchema } from "#server/services/capabilities/web.js";
import type { ResolvedInstallationTool } from "#server/services/connectors/installations.js";
import { resolveConnectorInstallations } from "#server/services/connectors/resolution.js";
import {
  type DataPlaneSession,
  SEARCH_CONTEXT_DEFAULT_LIMIT,
  SEARCH_CONTEXT_MAX_LIMIT,
} from "#server/services/dataplane/index.js";
import {
  FETCH_TRANSCRIPT_DEFAULT_WINDOW,
  FETCH_TRANSCRIPT_MAX_WINDOW,
} from "#server/services/dataplane/transcript.js";
import { memoryTypes } from "#server/services/items/index.js";

export const SEARCH_CONTEXT_TOOL_NAME = "search_context";
export const GET_ITEM_TOOL_NAME = "get_item";
export const SAVE_MEMORY_TOOL_NAME = "save_memory";
export const UPDATE_MEMORY_TOOL_NAME = "update_memory";
export const FETCH_TRANSCRIPT_TOOL_NAME = "fetch_transcript";
export const SEARCH_TOOLS_TOOL_NAME = "search_tools";
export const USE_CONNECTOR_TOOL_NAME = "use_connector";
export const SEARCH_WEB_TOOL_NAME = "search_web";
export const FETCH_URL_TOOL_NAME = "fetch_url";

export const USE_CONNECTOR_TITLE = "Use connector";
export const USE_CONNECTOR_DESCRIPTION =
  "Do something in a connected system when a first-class connector tool is not available. The call runs here with the organization's credential; you never see the credential and never call the system directly.";

export const itemKindSchema = z
  .enum(["memory", "skill", "instruction", "connector", "conversation"])
  .describe("The item kind.");

export const searchContextInputSchema = z.object({
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
});

export const getItemInputSchema = z.object({
  id: z.string().min(1).describe("The item ID, as returned by `search_context`."),
});

export const saveMemoryInputSchema = z.object({
  type: z
    .enum(memoryTypes)
    .describe(
      "fact: something true about the world. preference: how someone likes work done. rule: guidance to follow every time. procedure: the steps for a recurring task.",
    ),
  title: z.string().min(1).describe("A short name for the memory, in plain words."),
  content: z.string().min(1).describe("The memory itself, written to be read months later."),
});

export const updateMemoryInputSchema = z.object({
  id: z.string().min(1).describe("The memory's item ID, from `search_context`."),
  content: z.string().min(1).describe("What the memory should say now, in full."),
});

export const fetchTranscriptInputSchema = z.object({
  conversationId: z.string().min(1).describe("The conversation's ID."),
  aroundSeq: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Centre the window on this message number, with about half the window before it. Omit it to read the end of the thread.",
    ),
  window: z
    .number()
    .int()
    .min(1)
    .max(FETCH_TRANSCRIPT_MAX_WINDOW)
    .optional()
    .describe(`How many messages to return. Defaults to ${FETCH_TRANSCRIPT_DEFAULT_WINDOW}.`),
});

export const searchToolsInputSchema = z.object({
  query: z.string().min(1).describe("What connected-system capability to look for."),
  limit: z.number().int().min(1).max(5).optional().describe("Maximum matches. Defaults to 5."),
});

export const useConnectorInputShape = {
  toolKey: z
    .string()
    .min(3)
    .describe("The tool to run, written `connector:tool` — for example `github:create_issue`."),
  args: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("The tool's arguments, exactly as that tool defines them."),
  reason: z.string().min(1).describe("One line saying what this call does and why."),
  // Kept only for external MCP compatibility. In-process runs carry approval
  // authority in the harness envelope, outside the model-facing schema.
  approvalId: z.string().min(1).optional().describe("An approval granted for this exact call."),
};

export const useConnectorInputSchema = z.object(useConnectorInputShape).strict();
export const useConnectorModelInputSchema = useConnectorInputSchema.omit({ approvalId: true });

interface BuiltInToolSpec<Input extends z.ZodType = z.ZodType> {
  key: `context:${string}` | `capability:${string}`;
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  inputSchema: Input;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    openWorldHint: boolean;
  };
}

export const builtInToolSpecs = [
  {
    key: "context:search_context",
    name: SEARCH_CONTEXT_TOOL_NAME,
    title: "Search context",
    description:
      "Search the organization's active context for items relevant to a question. Returns titles and short excerpts, never full bodies — call `get_item` with an id to read one.",
    kind: "search",
    inputSchema: searchContextInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    key: "context:get_item",
    name: GET_ITEM_TOOL_NAME,
    title: "Get item",
    description:
      "Read one context item in full, by id. The id comes from `search_context`. Reading an item records that this run used it.",
    kind: "read",
    inputSchema: getItemInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    key: "context:save_memory",
    name: SAVE_MEMORY_TOOL_NAME,
    title: "Save memory",
    description:
      "Remember something for later runs. Facts and preferences take effect immediately; rules and procedures are proposed for human confirmation.",
    kind: "edit",
    inputSchema: saveMemoryInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    key: "context:update_memory",
    name: UPDATE_MEMORY_TOOL_NAME,
    title: "Update memory",
    description:
      "Rewrite a fact or preference saved at this session's own scope. The earlier wording remains in item history.",
    kind: "edit",
    inputSchema: updateMemoryInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    key: "context:fetch_transcript",
    name: FETCH_TRANSCRIPT_TOOL_NAME,
    title: "Fetch transcript",
    description:
      "Read a bounded, exact window from a captured conversation when summaries are not enough.",
    kind: "fetch",
    inputSchema: fetchTranscriptInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    key: "context:search_tools",
    name: SEARCH_TOOLS_TOOL_NAME,
    title: "Search connector tools",
    description:
      "Find connected-system operations and enable the best matches as typed tools for the next turn.",
    kind: "search",
    inputSchema: searchToolsInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    key: "context:use_connector",
    name: USE_CONNECTOR_TOOL_NAME,
    title: USE_CONNECTOR_TITLE,
    description: USE_CONNECTOR_DESCRIPTION,
    kind: "connector",
    inputSchema: useConnectorModelInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
] as const satisfies readonly BuiltInToolSpec[];

const capabilityToolSpecs = [
  {
    key: "capability:web.search",
    name: SEARCH_WEB_TOOL_NAME,
    title: "Search the web",
    description:
      "Search the public web for current information. Returns ranked page titles, URLs, and bounded snippets. Use `fetch_url` when available to read a promising page.",
    kind: "search",
    inputSchema: searchWebInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    key: "capability:web.fetch",
    name: FETCH_URL_TOOL_NAME,
    title: "Fetch URL",
    description:
      "Extract one public HTTP or HTTPS page as bounded text through the configured provider.",
    kind: "fetch",
    inputSchema: fetchUrlInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const satisfies readonly BuiltInToolSpec[];

function toToolDef(spec: BuiltInToolSpec): ToolDef {
  return {
    key: spec.key,
    name: spec.name,
    title: spec.title,
    description: spec.description,
    schema: z.toJSONSchema(spec.inputSchema, { io: "input" }),
    kind: spec.kind,
  };
}

/** The canonical built-in definitions used by sessions and the MCP adapter. */
export function sessionToolDefs(): ToolDef[] {
  return builtInToolSpecs.map(toToolDef);
}

/** Native tools whose organization routes are currently enabled. */
export function capabilityToolDefs(keys: readonly CapabilityKey[]): ToolDef[] {
  const enabled = new Set(keys);
  return capabilityToolSpecs
    .filter((spec) => enabled.has(spec.key.slice("capability:".length) as CapabilityKey))
    .map(toToolDef);
}

const MODEL_TOOL_NAME_LIMIT = 64;

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

/**
 * Produce a conservative provider-facing function name while retaining the
 * connector key in `ToolDef.key` as the stable execution identity.
 */
export function connectorModelToolName(toolKey: string): string {
  const normalized = toolKey.replace(/[^A-Za-z0-9_]/g, "__").replace(/_+/g, "_");
  const prefixed = /^[A-Za-z_]/.test(normalized) ? normalized : `tool_${normalized}`;
  if (prefixed === toolKey && prefixed.length <= MODEL_TOOL_NAME_LIMIT) return prefixed;
  const suffix = `_${shortHash(toolKey)}`;
  return `${prefixed.slice(0, MODEL_TOOL_NAME_LIMIT - suffix.length)}${suffix}`;
}

function connectorSchema(
  provider: ProviderCatalog[number],
  tool: ResolvedInstallationTool,
): Record<string, unknown> {
  if (provider.transport.type === "rest") {
    return (
      provider.toolManifest.find(({ name }) => name === tool.name)?.paramsSchema ?? {
        type: "object",
        additionalProperties: true,
      }
    );
  }
  return tool.inputSchema ?? { type: "object", additionalProperties: true };
}

/** Convert one currently enabled installation operation into its model definition. */
export function connectorToolDef(
  provider: ProviderCatalog[number],
  tool: ResolvedInstallationTool,
): ToolDef {
  const key = `${provider.key}:${tool.name}`;
  return {
    key,
    name: connectorModelToolName(key),
    title: tool.title ?? `${provider.displayName}: ${tool.name.replaceAll("_", " ")}`,
    description:
      tool.description ??
      `Use ${provider.displayName}'s ${tool.name} operation through the connected account.`,
    schema: connectorSchema(provider, tool),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    kind: "connector",
    connector: {
      key: provider.key,
      displayName: provider.displayName,
      ...(provider.logoUrl === undefined ? {} : { logoUrl: provider.logoUrl }),
    },
    ...(tool.annotations?.destructiveHint ? { execution: "sequential" } : {}),
  };
}

/**
 * Resolve first-class connector definitions from the session's current scope.
 *
 * The central resolver applies the same pinned installation, credential, role,
 * and enabled-tool checks execution uses.
 */
export async function resolveConnectorToolDefs(
  db: Database,
  session: DataPlaneSession,
  catalog: ProviderCatalog = loadProviderCatalog(),
  limit = Number.MAX_SAFE_INTEGER,
): Promise<ToolDef[]> {
  const installations = await resolveConnectorInstallations(
    db,
    {
      orgId: session.orgId,
      scopeChain: session.scopeChain,
      scopeKind: session.scopeKind,
      requesterPrincipalId: session.requesterPrincipalId,
    },
    catalog,
  );
  const definitions = new Map<string, ToolDef>();
  for (const installation of installations) {
    for (const tool of installation.tools) {
      const key = `${installation.provider.key}:${tool.name}`;
      definitions.set(key, connectorToolDef(installation.provider, tool));
    }
  }

  const ordered = [...definitions.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (ordered.length > limit) {
    log.warn("Live connector tool resolution cut by the requested limit", {
      sessionId: session.id,
      resolvedCount: ordered.length,
      includedCount: limit,
    });
  }
  return ordered.slice(0, limit);
}

/** Small built-in surface available on the first model turn. */
export function modelSessionToolDefs(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter(
    (tool) =>
      (tool.key?.startsWith("context:") || tool.key?.startsWith("capability:")) &&
      tool.name !== USE_CONNECTOR_TOOL_NAME,
  );
}
