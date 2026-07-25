import type { ProviderDef, RestTransport, ToolDefinition } from "@trema/connectors";
import { interpolate, loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";

import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  type ConnectorInstallationBody,
  createConnectorInstallationBodySchema,
  resolveInstallationTools,
  type Sensitivity,
} from "#server/services/connectors/installations.js";
import {
  ConnectorReconnectRequiredError,
  type ResolvedConnectionCredential,
  resolveConnectionCredential,
} from "#server/services/connectors/refresh.js";
import type { PlatformAppDirectory } from "#server/services/connectors/registrations.js";
import {
  createStreamableHttpMcpClient,
  type McpClientFactory,
  type McpToolCallResult,
} from "#server/services/connectors/sync.js";

const defaultCatalog = loadProviderCatalog();
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const REDACTED = "[REDACTED]";

type JsonRecord = Record<string, unknown>;
type Clock = () => Date;

export class ConnectorToolNotAvailableError extends Error {
  readonly code = "connector_tool_not_available";

  constructor(
    readonly toolKey: string,
    readonly installationItemId?: string,
  ) {
    super(`Connector tool '${toolKey}' is not available`);
    this.name = "ConnectorToolNotAvailableError";
  }
}

export class ConnectorApprovalRequiredError extends Error {
  readonly code = "approval_required";

  constructor(
    readonly toolKey: string,
    readonly sensitivity: Sensitivity,
    readonly installationItemId: string,
  ) {
    super(`Connector tool '${toolKey}' requires approval`);
    this.name = "ConnectorApprovalRequiredError";
  }
}

export class ConnectorToolValidationError extends Error {
  readonly code = "connector_tool_validation_failed";

  constructor(message: string) {
    super(message);
    this.name = "ConnectorToolValidationError";
  }
}

export class ConnectorSsrfRejectedError extends Error {
  readonly code = "connector_ssrf_rejected";

  constructor() {
    super("Connector URL was rejected by the outbound host policy");
    this.name = "ConnectorSsrfRejectedError";
  }
}

export class ConnectorTransportError extends Error {
  readonly code = "connector_transport_failed";

  constructor(
    readonly status?: number,
    readonly providerCode?: string,
  ) {
    super(
      `Connector provider request failed${
        status === undefined ? "" : ` with status ${status}`
      }${providerCode === undefined ? "" : ` (code ${providerCode})`}`,
    );
    this.name = "ConnectorTransportError";
  }
}

export interface ExecuteConnectorToolInput {
  orgId: string;
  scopeIds: readonly string[];
  principalId: string;
  toolKey: string;
  args: unknown;
  masterKey?: string;
  catalog?: ProviderCatalog;
  platformApps?: PlatformAppDirectory;
  fetch?: typeof globalThis.fetch;
  clientFactory?: McpClientFactory;
  now?: Date | Clock;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Phase C's policy/approval resolver replaces this seam. Until then,
   * sensitive tools are denied unless a trusted internal caller explicitly
   * confirms that approval has already been satisfied.
   */
  allowSensitiveToolExecution?: boolean;
}

export interface RestConnectorToolResult {
  ok: true;
  status: number;
  body: unknown;
}

export type McpConnectorToolResult = McpToolCallResult;

interface SelectedInstallation {
  id: string;
  body: ConnectorInstallationBody;
  provider: ProviderDef;
  toolName: string;
  sensitivity: Sensitivity;
}

interface ParsedResponseBody {
  body: unknown;
  record?: JsonRecord;
}

class CredentialRedactor {
  readonly #values = new Set<string>();

  add(value: unknown): void {
    collectStrings(value, this.#values);
  }

  addString(value: string | undefined): void {
    if (value) this.#values.add(value);
  }

  text(value: string): string {
    let redacted = value;
    for (const secret of [...this.#values].sort((left, right) => right.length - left.length)) {
      if (secret.length > 0) redacted = redacted.split(secret).join(REDACTED);
    }
    return redacted;
  }

  contains(value: string): boolean {
    return [...this.#values].some((secret) => secret.length > 0 && value.includes(secret));
  }

  value(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (typeof value === "string") return this.text(value);
    if (typeof value !== "object" || value === null) return value;
    const prior = seen.get(value);
    if (prior !== undefined) return prior;
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      seen.set(value, output);
      output.push(...value.map((entry) => this.value(entry, seen)));
      return output;
    }
    const output: JsonRecord = {};
    seen.set(value, output);
    for (const [key, entry] of Object.entries(value)) {
      output[key] = this.value(entry, seen);
    }
    return output;
  }
}

function collectStrings(value: unknown, output: Set<string>, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (value.length > 0) output.add(value);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const entry of Object.values(value)) collectStrings(entry, output, seen);
}

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function currentDate(now: ExecuteConnectorToolInput["now"]): Date {
  if (typeof now === "function") return now();
  return now ?? new Date();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseToolKey(toolKey: string): { catalogKey: string; toolName: string } {
  const separator = toolKey.indexOf(":");
  if (separator <= 0 || separator === toolKey.length - 1) {
    throw new ConnectorToolValidationError(
      "Connector toolKey must use the 'catalogKey:toolName' format",
    );
  }
  return {
    catalogKey: toolKey.slice(0, separator),
    toolName: toolKey.slice(separator + 1),
  };
}

function rawCatalogKey(value: unknown): string | undefined {
  const body = recordValue(value);
  return typeof body?.catalogKey === "string" ? body.catalogKey : undefined;
}

function providerExposesTool(
  provider: ProviderDef,
  body: ConnectorInstallationBody,
  toolName: string,
): boolean {
  return provider.transport.type === "rest"
    ? provider.toolManifest.some((tool) => tool.name === toolName)
    : (body.syncedTools ?? []).some((tool) => tool.name === toolName);
}

async function resolveInstallation(
  db: Database,
  input: ExecuteConnectorToolInput,
  catalog: ProviderCatalog,
): Promise<SelectedInstallation> {
  if (input.scopeIds.length === 0) {
    throw new ConnectorToolValidationError("At least one connector scope is required");
  }
  const { catalogKey, toolName } = parseToolKey(input.toolKey);
  const provider = catalog.find((candidate) => candidate.key === catalogKey);
  if (!provider) throw new ConnectorToolNotAvailableError(input.toolKey);

  const installations = await db.item.findMany({
    where: {
      orgId: input.orgId,
      scopeId: { in: [...new Set(input.scopeIds)] },
      kind: "connector",
      status: "active",
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    select: { id: true, scopeId: true, body: true },
  });

  for (const scopeId of input.scopeIds) {
    for (const installation of installations) {
      if (installation.scopeId !== scopeId || rawCatalogKey(installation.body) !== catalogKey) {
        continue;
      }
      const parsed = createConnectorInstallationBodySchema(catalog).safeParse(installation.body);
      if (!parsed.success) {
        throw new ConnectorToolValidationError("Connector installation body is invalid");
      }
      if (!providerExposesTool(provider, parsed.data, toolName)) continue;

      const effective = resolveInstallationTools(provider, parsed.data).find(
        (tool) => tool.name === toolName,
      );
      if (!effective) {
        // Selection has already happened. A broader installation must never
        // become a credential fallback merely because this tool is disabled.
        throw new ConnectorToolNotAvailableError(input.toolKey, installation.id);
      }
      return {
        id: installation.id,
        body: parsed.data,
        provider,
        toolName,
        sensitivity: effective.sensitivity,
      };
    }
  }
  throw new ConnectorToolNotAvailableError(input.toolKey);
}

function pathParameterNames(path: string): string[] {
  return Array.from(path.matchAll(/\{([^{}]+)\}/g), (match) => match[1] ?? "");
}

function renderToolPath(path: string, args: JsonRecord): { path: string; remaining: JsonRecord } {
  const remaining = { ...args };
  let rendered = path;
  for (const name of pathParameterNames(path)) {
    const value = remaining[name];
    if (
      value === undefined ||
      value === null ||
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      throw new ConnectorToolValidationError(`Missing or invalid path parameter '${name}'`);
    }
    rendered = rendered.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    delete remaining[name];
  }
  return { path: rendered, remaining };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function interpolateAndValidateBaseUrl(
  template: string,
  config: Readonly<Record<string, string | number | boolean>>,
): URL {
  const placeholders: string[] = [];
  const safeTemplate = template.replace(/\$\{([^{}]+)\}/g, (_, reference: string) => {
    if (!/^config\.[A-Za-z0-9_]+$/.test(reference)) throw new ConnectorSsrfRejectedError();
    const marker = `trema-config-${placeholders.length}`;
    placeholders.push(marker);
    return marker;
  });

  let declared: URL;
  let effective: URL;
  try {
    declared = new URL(safeTemplate);
    effective = new URL(interpolate(template, { config }));
  } catch {
    throw new ConnectorSsrfRejectedError();
  }
  if (
    declared.protocol !== "https:" ||
    effective.protocol !== declared.protocol ||
    declared.username.length > 0 ||
    declared.password.length > 0 ||
    effective.username.length > 0 ||
    effective.password.length > 0 ||
    effective.port !== declared.port
  ) {
    throw new ConnectorSsrfRejectedError();
  }

  let hostnamePattern = escapeRegex(declared.hostname);
  for (const marker of placeholders) {
    hostnamePattern = hostnamePattern.replace(escapeRegex(marker), "[a-z0-9_-]+");
  }
  if (!new RegExp(`^${hostnamePattern}$`, "i").test(effective.hostname)) {
    throw new ConnectorSsrfRejectedError();
  }
  return effective;
}

function assertOperationHost(baseUrl: URL, operationUrl: URL): void {
  if (
    operationUrl.protocol !== baseUrl.protocol ||
    operationUrl.hostname !== baseUrl.hostname ||
    operationUrl.port !== baseUrl.port ||
    operationUrl.username.length > 0 ||
    operationUrl.password.length > 0
  ) {
    throw new ConnectorSsrfRejectedError();
  }
}

function primitiveCredentials(
  credential: Readonly<JsonRecord>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(credential).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

function bearerToken(credential: Readonly<JsonRecord>): string | undefined {
  const raw = recordValue(credential.raw);
  for (const value of [
    credential.accessToken,
    credential.access_token,
    credential.token,
    raw?.access_token,
  ]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function interpolateAuthValue(value: unknown, resolved: ResolvedConnectionCredential): string {
  if (typeof value !== "string") {
    throw new ConnectorToolValidationError("Connector auth injection values must be strings");
  }
  try {
    return interpolate(value, {
      config: resolved.config,
      credentials: primitiveCredentials(resolved.credential),
    });
  } catch {
    throw new ConnectorToolValidationError("Connector auth injection is incomplete");
  }
}

function explicitAuthInjection(
  injection: JsonRecord,
  resolved: ResolvedConnectionCredential,
  headers: Headers,
  url: URL,
  redactor: CredentialRedactor,
): void {
  const headerMap = recordValue(injection.headers);
  const queryMap = recordValue(injection.query);
  let applied = false;

  if (headerMap) {
    for (const [name, template] of Object.entries(headerMap)) {
      const value = interpolateAuthValue(template, resolved);
      headers.set(name, value);
      redactor.addString(value);
      applied = true;
    }
  }
  if (queryMap) {
    for (const [name, template] of Object.entries(queryMap)) {
      const value = interpolateAuthValue(template, resolved);
      url.searchParams.set(name, value);
      redactor.addString(value);
      applied = true;
    }
  }

  const location = injection.type ?? injection.in;
  if (location === "header" || location === "query") {
    const name =
      typeof injection.name === "string"
        ? injection.name
        : typeof injection.header === "string"
          ? injection.header
          : typeof injection.query === "string"
            ? injection.query
            : undefined;
    const template = injection.value ?? injection.template;
    if (!name) {
      throw new ConnectorToolValidationError("Connector auth injection name is missing");
    }
    const value = interpolateAuthValue(template, resolved);
    if (location === "header") headers.set(name, value);
    else url.searchParams.set(name, value);
    redactor.addString(value);
    applied = true;
  }

  if (!applied) {
    throw new ConnectorToolValidationError("Connector auth injection recipe is invalid");
  }
}

function basicAuthorization(credential: Readonly<JsonRecord>): string {
  const username = credential.username ?? credential.user;
  const password = credential.password ?? credential.pass;
  if (typeof username !== "string" || typeof password !== "string") {
    throw new ConnectorToolValidationError(
      "Basic connector credentials require username and password",
    );
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function applyAuth(
  provider: ProviderDef,
  tool: ToolDefinition,
  resolved: ResolvedConnectionCredential,
  headers: Headers,
  url: URL,
  redactor: CredentialRedactor,
): void {
  redactor.add(resolved.credential);
  if (tool.authInjection) {
    explicitAuthInjection(tool.authInjection, resolved, headers, url, redactor);
    return;
  }
  if (provider.transport.type !== "rest") {
    throw new ConnectorToolValidationError("REST auth requested for a non-REST connector");
  }
  if (provider.transport.authHeader) {
    const authorization = interpolateAuthValue(provider.transport.authHeader, resolved);
    headers.set("Authorization", authorization);
    redactor.addString(authorization);
    return;
  }
  if (provider.transport.authHeaders) {
    for (const [name, template] of Object.entries(provider.transport.authHeaders)) {
      const value = interpolateAuthValue(template, resolved);
      headers.set(name, value);
      redactor.addString(value);
    }
    return;
  }
  if (
    resolved.mode === "oauth2_code" ||
    resolved.mode === "oauth2_client_credentials" ||
    resolved.mode === "mcp_oauth"
  ) {
    const token = bearerToken(resolved.credential);
    if (!token) {
      throw new ConnectorReconnectRequiredError(resolved.connectionId, provider.key, "expired");
    }
    const authorization = `Bearer ${token}`;
    headers.set("Authorization", authorization);
    redactor.addString(authorization);
    return;
  }
  if (resolved.mode === "basic") {
    const authorization = basicAuthorization(resolved.credential);
    headers.set("Authorization", authorization);
    redactor.addString(authorization);
    return;
  }
  if (resolved.mode === "api_key") {
    throw new ConnectorToolValidationError(
      `API-key provider '${provider.key}' must declare authHeader, authHeaders, or tool authInjection`,
    );
  }
  throw new ConnectorToolValidationError(
    `Provider '${provider.key}' must declare auth injection for mode '${resolved.mode}'`,
  );
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) appendQueryValue(searchParams, key, entry);
    return;
  }
  if (typeof value === "object" && value !== null) {
    searchParams.append(key, JSON.stringify(value));
    return;
  }
  searchParams.append(key, String(value));
}

function restRequest(
  provider: ProviderDef,
  tool: ToolDefinition,
  args: JsonRecord,
  resolved: ResolvedConnectionCredential,
  redactor: CredentialRedactor,
): { url: URL; init: RequestInit } {
  if (provider.transport.type !== "rest") {
    throw new ConnectorToolValidationError("REST request requested for an MCP connector");
  }
  const baseTemplate = tool.baseUrl ?? provider.transport.baseUrl;
  const baseUrl = interpolateAndValidateBaseUrl(baseTemplate, resolved.config);
  const rendered = renderToolPath(tool.path, args);
  let url: URL;
  try {
    url = new URL(rendered.path, baseUrl);
  } catch {
    throw new ConnectorToolValidationError("Connector tool path is invalid");
  }
  assertOperationHost(baseUrl, url);

  const headers = new Headers({ Accept: "application/json" });
  const init: RequestInit = { method: tool.method, headers };
  if (tool.method === "GET" || tool.method === "DELETE") {
    for (const [key, value] of Object.entries(rendered.remaining)) {
      appendQueryValue(url.searchParams, key, value);
    }
  } else {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(rendered.remaining);
  }
  applyAuth(provider, tool, resolved, headers, url, redactor);
  assertOperationHost(baseUrl, url);
  return { url, init };
}

async function parseResponseBody(response: Response): Promise<ParsedResponseBody> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) {
    return { body: text };
  }
  if (text.length === 0) return { body: null };
  try {
    const body: unknown = JSON.parse(text);
    const record = recordValue(body);
    return { body, ...(record ? { record } : {}) };
  } catch {
    return { body: text };
  }
}

function safeProviderCode(value: unknown, redactor: CredentialRedactor): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value) &&
    !redactor.contains(value)
    ? value
    : undefined;
}

function providerErrorCode(
  body: JsonRecord | undefined,
  redactor: CredentialRedactor,
): string | undefined {
  const error = body?.error;
  return (
    safeProviderCode(error, redactor) ??
    safeProviderCode(recordValue(error)?.code, redactor) ??
    safeProviderCode(body?.code, redactor)
  );
}

function nestedValue(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, key) => recordValue(current)?.[key], value);
}

function afterDelayMs(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : undefined;
}

function atDelayMs(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    const timestamp = numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
    return Math.max(0, timestamp - now.getTime());
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : undefined;
}

function retryDelayMs(
  transport: RestTransport,
  response: Response,
  body: unknown,
  now: Date,
  fallback: number,
): number {
  const retry = transport.retry;
  if (!retry) return fallback;
  for (const header of retry.afterHeaders ?? []) {
    const delay = afterDelayMs(response.headers.get(header) ?? undefined, now);
    if (delay !== undefined) return delay;
  }
  for (const header of retry.atHeaders ?? []) {
    const delay = atDelayMs(response.headers.get(header) ?? undefined, now);
    if (delay !== undefined) return delay;
  }
  if (retry.bodyPath) {
    const value = nestedValue(body, retry.bodyPath);
    const delay = afterDelayMs(
      typeof value === "string" || typeof value === "number" ? String(value) : undefined,
      now,
    );
    if (delay !== undefined) return delay;
  }
  // A remaining-quota header tells us whether capacity is exhausted, but not
  // when it resets. It therefore confirms retryability while the safe
  // exponential fallback supplies the delay.
  if (retry.remainingHeader) response.headers.get(retry.remainingHeader);
  return fallback;
}

function retryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 429 || (status >= 500 && status <= 599);
}

function statusFromError(error: unknown): number | undefined {
  const record = recordValue(error);
  const response = recordValue(record?.response);
  for (const value of [record?.status, record?.statusCode, response?.status]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

function codeFromError(error: unknown, redactor: CredentialRedactor): string | undefined {
  const record = recordValue(error);
  return safeProviderCode(record?.code, redactor);
}

function argsRecord(args: unknown): JsonRecord {
  const record = recordValue(args);
  if (!record) {
    throw new ConnectorToolValidationError("Connector tool args must be an object");
  }
  return record;
}

async function resolveCredential(
  db: Database,
  input: ExecuteConnectorToolInput,
  installation: SelectedInstallation,
  catalog: ProviderCatalog,
): Promise<ResolvedConnectionCredential> {
  const resolved = await resolveConnectionCredential(db, {
    orgId: input.orgId,
    connectionId: installation.body.connectionId,
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    catalog,
    ...(input.platformApps ? { platformApps: input.platformApps } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    now: currentDate(input.now),
  });
  if (resolved.providerKey !== installation.provider.key) {
    throw new ConnectorToolValidationError(
      "Connector installation and connection providers do not match",
    );
  }
  return resolved;
}

async function executeRest(
  db: Database,
  input: ExecuteConnectorToolInput,
  installation: SelectedInstallation,
  catalog: ProviderCatalog,
  redactor: CredentialRedactor,
): Promise<RestConnectorToolResult> {
  const provider = installation.provider;
  if (provider.transport.type !== "rest") {
    throw new ConnectorToolValidationError("REST execution requested for an MCP connector");
  }
  const tool = provider.toolManifest.find(({ name }) => name === installation.toolName);
  if (!tool) throw new ConnectorToolNotAvailableError(input.toolKey, installation.id);
  const fetch = input.fetch ?? globalThis.fetch;
  const sleep = input.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const resolved = await resolveCredential(db, input, installation, catalog);
    redactor.add(resolved.credential);
    const request = restRequest(provider, tool, argsRecord(input.args), resolved, redactor);
    let response: Response;
    try {
      response = await fetch(request.url, request.init);
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        throw new ConnectorTransportError(undefined, codeFromError(error, redactor));
      }
      await sleep(DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }

    let parsed: ParsedResponseBody;
    try {
      parsed = await parseResponseBody(response);
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        throw new ConnectorTransportError(undefined, codeFromError(error, redactor));
      }
      await sleep(DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        body: redactor.value(parsed.body),
      };
    }
    const code = providerErrorCode(parsed.record, redactor);
    if (!retryableStatus(response.status) || attempt === MAX_ATTEMPTS) {
      throw new ConnectorTransportError(response.status, code);
    }
    await sleep(
      retryDelayMs(
        provider.transport,
        response,
        parsed.body,
        currentDate(input.now),
        DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1),
      ),
    );
  }
  throw new ConnectorTransportError();
}

async function executeMcp(
  db: Database,
  input: ExecuteConnectorToolInput,
  installation: SelectedInstallation,
  catalog: ProviderCatalog,
  redactor: CredentialRedactor,
): Promise<McpConnectorToolResult> {
  const provider = installation.provider;
  if (provider.transport.type !== "mcp") {
    throw new ConnectorToolValidationError("MCP execution requested for a REST connector");
  }
  const sleep = input.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const resolved = await resolveCredential(db, input, installation, catalog);
    redactor.add(resolved.credential);
    const serverUrl = interpolateAndValidateBaseUrl(
      provider.transport.serverUrl,
      resolved.config,
    ).toString();
    const token = bearerToken(resolved.credential);
    if (resolved.mode === "mcp_oauth" && !token) {
      throw new ConnectorReconnectRequiredError(resolved.connectionId, provider.key, "expired");
    }
    const authorization = token ? `Bearer ${token}` : undefined;
    redactor.addString(authorization);
    let client: Awaited<ReturnType<McpClientFactory>> | undefined;
    try {
      client = await (input.clientFactory ?? createStreamableHttpMcpClient)({
        serverUrl,
        ...(authorization ? { authorization } : {}),
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
      if (!client.callTool) {
        throw new ConnectorToolValidationError(
          "The configured MCP client does not support tools/call",
        );
      }
      const result = await client.callTool({
        name: installation.toolName,
        arguments: argsRecord(input.args),
      });
      return redactor.value(result) as McpConnectorToolResult;
    } catch (error) {
      if (
        error instanceof ConnectorToolValidationError ||
        error instanceof ConnectorReconnectRequiredError
      ) {
        throw error;
      }
      const status = statusFromError(error);
      const code = codeFromError(error, redactor);
      if (!retryableStatus(status) || attempt === MAX_ATTEMPTS) {
        throw new ConnectorTransportError(status, code);
      }
      await sleep(DEFAULT_RETRY_DELAY_MS * 2 ** (attempt - 1));
    } finally {
      try {
        await client?.close();
      } catch {
        // Close failures are never allowed to replace a sanitized call result
        // or failure, and are intentionally not logged with credential context.
      }
    }
  }
  throw new ConnectorTransportError();
}

export async function executeConnectorTool(
  db: Database,
  input: ExecuteConnectorToolInput,
): Promise<RestConnectorToolResult | McpConnectorToolResult> {
  const catalog = input.catalog ?? defaultCatalog;
  let installation: SelectedInstallation;
  try {
    installation = await resolveInstallation(db, input, catalog);
  } catch (error) {
    if (
      error instanceof ConnectorToolValidationError ||
      error instanceof ConnectorToolNotAvailableError
    ) {
      log.warn("Connector tool call rejected", { toolKey: input.toolKey, reason: error.name });
    }
    throw error;
  }
  const connector = installation.provider.key;
  const tool = installation.toolName;

  if (installation.sensitivity !== "read" && !input.allowSensitiveToolExecution) {
    log.warn("Connector tool call rejected", { connector, tool, reason: "approval_required" });
    throw new ConnectorApprovalRequiredError(
      input.toolKey,
      installation.sensitivity,
      installation.id,
    );
  }

  const redactor = new CredentialRedactor();
  const startedAt = Date.now();
  log.debug("Connector tool call started", { connector, tool });
  try {
    const result =
      installation.provider.transport.type === "rest"
        ? await executeRest(db, input, installation, catalog, redactor)
        : await executeMcp(db, input, installation, catalog, redactor);
    const status = (result as { status?: number }).status;
    // A proxied call on the customer's behalf left the deployment: an operator
    // wants this at the same level as the request that caused it.
    log.info("Connector tool call completed", {
      connector,
      tool,
      durationMs: Date.now() - startedAt,
      ...(status !== undefined ? { status } : {}),
    });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error instanceof ConnectorTransportError) {
      const details = {
        connector,
        tool,
        durationMs,
        ...(error.status !== undefined ? { status: error.status } : {}),
        error,
      };
      if (error.status !== undefined && error.status >= 400 && error.status < 500) {
        log.warn("Connector tool call failed", details);
      } else {
        log.error("Connector tool call failed", details);
      }
    } else if (
      error instanceof ConnectorToolValidationError ||
      error instanceof ConnectorToolNotAvailableError ||
      error instanceof ConnectorReconnectRequiredError ||
      error instanceof ConnectorSsrfRejectedError
    ) {
      log.warn("Connector tool call rejected", { connector, tool, reason: error.name });
    } else {
      log.error("Connector tool call failed", { connector, tool, durationMs, error });
    }
    throw error;
  }
}
