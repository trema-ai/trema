import type { ProviderCatalog } from "@trema/connectors";
import {
  createBlockingElicitation,
  type ImageBlock,
  type TextBlock,
  type ToolCall,
  type ToolDef,
  type ToolExecutionOptions,
  type ToolExecutionResult,
  type ToolExecutor,
  type ToolPreparationResult,
} from "@trema/harness";

import type { Database } from "#server/lib/db/index.js";
import type { ApprovalClassifier } from "#server/services/approvals/classifier.js";
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
} from "#server/services/dataplane/index.js";
import { saveMemory, updateMemory } from "#server/services/dataplane/memory.js";
import {
  FETCH_TRANSCRIPT_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  fetchTranscriptInputSchema,
  GET_ITEM_TOOL_NAME,
  getItemInputSchema,
  resolveConnectorToolDefs,
  SAVE_MEMORY_TOOL_NAME,
  SEARCH_CONTEXT_TOOL_NAME,
  SEARCH_TOOLS_TOOL_NAME,
  SEARCH_WEB_TOOL_NAME,
  saveMemoryInputSchema,
  searchContextInputSchema,
  searchToolsInputSchema,
  UPDATE_MEMORY_TOOL_NAME,
  USE_CONNECTOR_TOOL_NAME,
  updateMemoryInputSchema,
  useConnectorInputSchema,
} from "#server/services/dataplane/tools.js";
import { fetchTranscript } from "#server/services/dataplane/transcript.js";
import type { Embedder } from "#server/services/embeddings/index.js";
import { ItemValidationError } from "#server/services/items/index.js";

const INVALID_INPUT = {
  code: "invalid_tool_input",
  message: "The tool input is malformed",
};
const GENERIC_FAILURE = "The context app could not complete the call";

export interface DataPlaneToolExecutorDependencies {
  db: Database;
  classifier?: ApprovalClassifier;
  masterKey?: string;
  catalog?: ProviderCatalog;
  platformApps?: PlatformAppDirectory;
  fetch?: ConnectorFetch;
  clientFactory?: McpClientFactory;
  embedder?: Embedder;
  providerFetch?: typeof fetch;
  now?: Date;
}

function result(
  callId: string,
  status: ToolExecutionResult["status"],
  summary: string,
  output: unknown,
): ToolExecutionResult {
  return {
    callId,
    status,
    summary,
    output: typeof output === "string" ? output : JSON.stringify(output),
  };
}

function normalizedConnectorResult(
  callId: string,
  title: string,
  providerResult: unknown,
): ToolExecutionResult {
  const record = recordInput(providerResult);
  if (record?.ok === true && "body" in record) {
    return result(callId, "ok", `${title} completed`, record.body);
  }

  const content = Array.isArray(record?.content) ? record.content : undefined;
  if (content !== undefined) {
    const blocks: Array<TextBlock | ImageBlock> = [];
    for (const entry of content) {
      const block = recordInput(entry);
      if (block?.type === "text" && typeof block.text === "string") {
        blocks.push({ type: "text", text: block.text });
      } else if (
        block?.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        blocks.push({ type: "image", data: block.data, mediaType: block.mimeType });
      } else {
        blocks.push({ type: "text", text: JSON.stringify(entry) });
      }
    }
    const failed = record?.isError === true;
    return {
      callId,
      status: failed ? "error" : "ok",
      summary: failed ? `${title} failed` : `${title} completed`,
      output:
        blocks.length > 0
          ? blocks
          : [{ type: "text", text: JSON.stringify(record?.structuredContent ?? null) }],
    };
  }
  return result(callId, "ok", `${title} completed`, providerResult);
}

function recordInput(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface ConnectorInvocation {
  toolKey: string;
  args: Record<string, unknown>;
  reason: string;
  legacyEnvelope: boolean;
  approvalId?: string;
}

function connectorInvocation(call: ToolCall, definition: ToolDef): ConnectorInvocation | undefined {
  if (call.name === USE_CONNECTOR_TOOL_NAME) {
    const parsed = useConnectorInputSchema.safeParse(call.input);
    if (!parsed.success) return undefined;
    const { approvalId, ...input } = parsed.data;
    return {
      ...input,
      legacyEnvelope: true,
      ...(approvalId === undefined ? {} : { approvalId }),
    };
  }
  if (definition.kind !== "connector" || definition.key?.startsWith("context:")) {
    return undefined;
  }
  const args = recordInput(call.input);
  if (args === undefined || definition.key === undefined) return undefined;
  return {
    toolKey: definition.key,
    args,
    reason: `Use ${definition.title} for the current request.`,
    legacyEnvelope: false,
  };
}

function connectorOptions(
  dependencies: DataPlaneToolExecutorDependencies,
  invocation: ConnectorInvocation,
  approvalId: string | undefined,
) {
  return {
    toolKey: invocation.toolKey,
    args: invocation.args,
    reason: invocation.reason,
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(dependencies.classifier ? { classifier: dependencies.classifier } : {}),
    ...(dependencies.masterKey ? { masterKey: dependencies.masterKey } : {}),
    ...(dependencies.catalog ? { catalog: dependencies.catalog } : {}),
    ...(dependencies.platformApps ? { platformApps: dependencies.platformApps } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.clientFactory ? { clientFactory: dependencies.clientFactory } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
}

function describedFailure(error: unknown): { code: string; message: string } {
  const connector = describeConnectorFailure(error);
  if (connector !== undefined) return connector;
  if (error instanceof DataPlaneToolError) return { code: error.code, message: error.message };
  if (error instanceof WebCapabilityError) return { code: error.code, message: error.message };
  if (error instanceof ItemValidationError) {
    return { code: "item_validation_failed", message: error.message };
  }
  return { code: "tool_execution_failed", message: GENERIC_FAILURE };
}

async function prepareConnector(
  dependencies: DataPlaneToolExecutorDependencies,
  session: DataPlaneSession,
  call: ToolCall,
  definition: ToolDef,
  options?: ToolExecutionOptions,
): Promise<ToolPreparationResult> {
  const invocation = connectorInvocation(call, definition);
  if (invocation === undefined) {
    return { action: "block", summary: INVALID_INPUT.message, output: INVALID_INPUT };
  }
  const approvalId = invocation.approvalId ?? options?.approvalId;
  try {
    const outcome = await useConnector(dependencies.db, session, {
      ...connectorOptions(dependencies, invocation, approvalId),
      authorizeOnly: true,
    });
    if (outcome.status !== "approval_required") return { action: "execute" };
    return {
      action: "elicit",
      event: createBlockingElicitation(outcome.approvalId, {
        type: "approval_required",
        callId: call.callId,
        approvalId: outcome.approvalId,
        reason: outcome.escalationReason ?? invocation.reason,
      }),
    };
  } catch (error) {
    const failure = describedFailure(error);
    return { action: "block", summary: failure.message, output: failure };
  }
}

async function executeConnector(
  dependencies: DataPlaneToolExecutorDependencies,
  session: DataPlaneSession,
  call: ToolCall,
  definition: ToolDef,
  options?: ToolExecutionOptions,
): Promise<ToolExecutionResult> {
  const invocation = connectorInvocation(call, definition);
  if (invocation === undefined) {
    return result(call.callId, "error", INVALID_INPUT.message, INVALID_INPUT);
  }
  const approvalId = invocation.approvalId ?? options?.approvalId;
  try {
    const outcome = await useConnector(
      dependencies.db,
      session,
      connectorOptions(dependencies, invocation, approvalId),
    );
    if (outcome.status === "approval_required") {
      const failure = {
        code: "approval_state_changed",
        message: "The call now requires a new approval",
      };
      return result(call.callId, "error", failure.message, failure);
    }
    if (outcome.status === "authorized") {
      return result(call.callId, "error", GENERIC_FAILURE, GENERIC_FAILURE);
    }
    return invocation.legacyEnvelope
      ? result(call.callId, "ok", `${definition.title} completed`, outcome)
      : normalizedConnectorResult(call.callId, definition.title, outcome.result);
  } catch (error) {
    const failure = describedFailure(error);
    return result(call.callId, "error", failure.message, failure);
  }
}

async function executeBuiltIn(
  dependencies: DataPlaneToolExecutorDependencies,
  session: DataPlaneSession,
  call: ToolCall,
): Promise<ToolExecutionResult> {
  const embedding = dependencies.masterKey ? { masterKey: dependencies.masterKey } : {};
  try {
    switch (call.name) {
      case SEARCH_CONTEXT_TOOL_NAME: {
        const parsed = searchContextInputSchema.safeParse(call.input);
        if (!parsed.success) break;
        const { query, kinds, limit } = parsed.data;
        const results = await searchContext(dependencies.db, session, {
          query,
          ...(kinds ? { kinds } : {}),
          ...(limit === undefined ? {} : { limit }),
          ...embedding,
        });
        return result(call.callId, "ok", `Found ${results.length} context items`, { results });
      }
      case SEARCH_WEB_TOOL_NAME: {
        const parsed = searchWebInputSchema.safeParse(call.input);
        if (!parsed.success) break;
        const searched = await searchWeb(dependencies.db, session, parsed.data, {
          ...(dependencies.masterKey ? { masterKey: dependencies.masterKey } : {}),
          ...(dependencies.providerFetch ? { providerFetch: dependencies.providerFetch } : {}),
        });
        return result(call.callId, "ok", `Found ${searched.results.length} web results`, searched);
      }
      case FETCH_URL_TOOL_NAME: {
        const parsed = fetchUrlInputSchema.safeParse(call.input);
        if (!parsed.success) break;
        const fetched = await fetchUrl(dependencies.db, session, parsed.data, {
          ...(dependencies.masterKey ? { masterKey: dependencies.masterKey } : {}),
          ...(dependencies.providerFetch ? { providerFetch: dependencies.providerFetch } : {}),
        });
        return result(call.callId, "ok", `Fetched ${fetched.title ?? fetched.url}`, fetched);
      }
      case GET_ITEM_TOOL_NAME: {
        const parsed = getItemInputSchema.safeParse(call.input);
        if (!parsed.success) break;
        const item = await getContextItem(dependencies.db, session, parsed.data.id);
        return result(call.callId, "ok", `Read ${item.title}`, {
          id: item.id,
          kind: item.kind,
          title: item.title,
          body: item.body,
          scopeId: item.scopeId,
          disclosure: item.disclosure,
          version: item.version,
          updatedAt: item.updatedAt.toISOString(),
        });
      }
      case SAVE_MEMORY_TOOL_NAME: {
        const parsed = saveMemoryInputSchema.safeParse(call.input);
        if (!parsed.success) break;
        const { item, supersededId } = await saveMemory(dependencies.db, session, {
          ...parsed.data,
          ...embedding,
        });
        return result(call.callId, "ok", `Saved ${item.title}`, {
          id: item.id,
          type: parsed.data.type,
          title: item.title,
          scopeId: item.scopeId,
          status: item.status,
          version: item.version,
          superseded: supersededId ?? null,
        });
      }
      case UPDATE_MEMORY_TOOL_NAME: {
        const parsed = updateMemoryInputSchema.safeParse(call.input);
        if (!parsed.success) break;
        const item = await updateMemory(dependencies.db, session, {
          itemId: parsed.data.id,
          content: parsed.data.content,
          ...embedding,
        });
        return result(call.callId, "ok", `Updated ${item.title}`, {
          id: item.id,
          type: (item.body as { type: string }).type,
          title: item.title,
          scopeId: item.scopeId,
          status: item.status,
          version: item.version,
        });
      }
      case FETCH_TRANSCRIPT_TOOL_NAME: {
        const parsed = fetchTranscriptInputSchema.safeParse(call.input);
        if (!parsed.success) break;
        const transcript = await fetchTranscript(dependencies.db, session, {
          conversationId: parsed.data.conversationId,
          ...(parsed.data.aroundSeq === undefined ? {} : { aroundSeq: parsed.data.aroundSeq }),
          ...(parsed.data.window === undefined ? {} : { window: parsed.data.window }),
        });
        return result(call.callId, "ok", `Read ${transcript.messages.length} messages`, {
          ...transcript,
          messages: transcript.messages.map((message) => ({
            ...message,
            sentAt: message.sentAt.toISOString(),
          })),
        });
      }
      case SEARCH_TOOLS_TOOL_NAME: {
        const parsed = searchToolsInputSchema.safeParse(call.input);
        if (!parsed.success) break;
        const tools = await searchConnectorTools(
          dependencies.db,
          session,
          parsed.data,
          dependencies,
        );
        return {
          ...result(call.callId, "ok", `Enabled ${tools.length} connector tools`, {
            tools: tools.map(({ key, name, title, description, schema }) => ({
              key,
              name,
              title,
              description,
              inputSchema: schema,
              availableNextTurn: true,
            })),
          }),
          activatedToolKeys: tools.flatMap(({ key }) => (key === undefined ? [] : [key])),
        };
      }
      default:
        return result(
          call.callId,
          "error",
          `Tool '${call.name}' is not available in this deployment`,
          `Tool '${call.name}' is not available in this deployment`,
        );
    }
    return result(call.callId, "error", INVALID_INPUT.message, INVALID_INPUT);
  } catch (error) {
    const failure = describedFailure(error);
    return result(call.callId, "error", failure.message, failure);
  }
}

/**
 * Execute the canonical session tool surface in process.
 *
 * Connector policy runs in `prepare`, before any call in a batch executes.
 * Approval therefore parks the exact call and resumes it with hidden authority;
 * the model never handles approval IDs or repeats a call.
 */
export function createDataPlaneToolExecutor(
  dependencies: DataPlaneToolExecutorDependencies,
  session: DataPlaneSession,
): ToolExecutor {
  return {
    async resolveTools(keys) {
      const definitions = await resolveConnectorToolDefs(
        dependencies.db,
        session,
        dependencies.catalog,
      );
      const byKey = new Map(
        definitions.flatMap((definition) =>
          definition.key === undefined ? [] : [[definition.key, definition] as const],
        ),
      );
      return keys.flatMap((key) => byKey.get(key) ?? []);
    },
    prepare(call, definition, options) {
      return definition.kind === "connector"
        ? prepareConnector(dependencies, session, call, definition, options)
        : { action: "execute" };
    },
    execute(call, definition, options) {
      return definition.kind === "connector"
        ? executeConnector(dependencies, session, call, definition, options)
        : executeBuiltIn(dependencies, session, call);
    },
  };
}
