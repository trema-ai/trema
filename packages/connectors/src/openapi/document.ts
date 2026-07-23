import { parse as parseYaml } from "yaml";

export class OpenApiConversionError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`OpenAPI conversion failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "OpenApiConversionError";
    this.issues = issues;
  }
}

export type JsonObject = Record<string, unknown>;

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: unknown[];
  requestBody?: unknown;
}

export interface OpenApiPathItem {
  parameters?: unknown[];
  operations: Map<string, OpenApiOperation>;
}

export interface OpenApiDocument {
  version: string;
  raw: JsonObject;
  paths: Map<string, OpenApiPathItem>;
}

const operationMethods = ["get", "post", "put", "patch", "delete"] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an OpenAPI 3.x document from JSON or YAML text. */
export function parseOpenApiDocument(text: string): OpenApiDocument {
  let raw: unknown;
  try {
    raw = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new OpenApiConversionError([
      `Document is neither valid JSON nor valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  if (!isObject(raw)) throw new OpenApiConversionError(["Document root is not an object"]);

  const version = raw.openapi;
  if (typeof version !== "string" || !version.startsWith("3.")) {
    throw new OpenApiConversionError([
      typeof raw.swagger === "string"
        ? `Swagger ${raw.swagger} documents are not supported; convert to OpenAPI 3.x first`
        : "Document has no 'openapi: 3.x' version field",
    ]);
  }

  if (!isObject(raw.paths)) throw new OpenApiConversionError(["Document has no 'paths' object"]);

  const paths = new Map<string, OpenApiPathItem>();
  for (const [path, item] of Object.entries(raw.paths)) {
    if (!isObject(item)) continue;
    const operations = new Map<string, OpenApiOperation>();
    for (const method of operationMethods) {
      const operation = item[method];
      if (isObject(operation)) operations.set(method.toUpperCase(), operation as OpenApiOperation);
    }
    const pathItem: OpenApiPathItem = { operations };
    if (Array.isArray(item.parameters)) pathItem.parameters = item.parameters;
    paths.set(path, pathItem);
  }

  return { version, raw, paths };
}

const maxRefDepth = 32;

/**
 * Resolve a value that may be (or contain) local `#/...` JSON pointers.
 * Remote refs are unsupported: curated manifests come from a single document.
 */
export function resolveRef(document: OpenApiDocument, reference: string): unknown {
  if (!reference.startsWith("#/")) {
    throw new OpenApiConversionError([
      `Unsupported non-local $ref '${reference}' — bundle the spec into one document first`,
    ]);
  }
  let value: unknown = document.raw;
  for (const segment of reference.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(value) || !(key in value)) {
      throw new OpenApiConversionError([`Unresolvable $ref '${reference}'`]);
    }
    value = value[key];
  }
  return value;
}

/**
 * Deep-copy a schema value, inlining every local $ref. Cyclic schemas fail
 * with a clear error instead of recursing forever — a curated tool parameter
 * schema should never need recursion.
 */
export function inlineRefs(document: OpenApiDocument, value: unknown, depth = 0): unknown {
  if (depth > maxRefDepth) {
    throw new OpenApiConversionError([
      "Schema nesting exceeds the supported depth (cyclic $ref?) — simplify the schema in the curation config",
    ]);
  }
  if (Array.isArray(value)) return value.map((entry) => inlineRefs(document, entry, depth + 1));
  if (!isObject(value)) return value;

  if (typeof value.$ref === "string") {
    return inlineRefs(document, resolveRef(document, value.$ref), depth + 1);
  }

  const copy: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    // Vendor extensions add noise, never semantics the model needs.
    if (key.startsWith("x-")) continue;
    copy[key] = inlineRefs(document, entry, depth + 1);
  }
  return copy;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isObject(value);
}
