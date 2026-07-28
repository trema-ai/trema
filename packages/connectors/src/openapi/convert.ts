import { z } from "zod";

import {
  inlineRefs,
  isJsonObject,
  type JsonObject,
  OpenApiConversionError,
  type OpenApiDocument,
  type OpenApiOperation,
} from "#connectors/openapi/document.js";
import { type ToolDefinition, toolDefinitionSchema } from "#connectors/schema.js";

/**
 * A curation config names the operations that become tools. Curated beats
 * auto-ingesting whole OpenAPI docs: a 300-operation API should become a
 * handful of good tools with retrieval-friendly descriptions, not 300 bad
 * ones — so selection is always explicit.
 */
export const manifestCurationSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            operationId: z.string().trim().min(1).optional(),
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
            path: z.string().trim().min(1).optional(),
            name: z
              .string()
              .trim()
              .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
              .optional(),
            description: z.string().trim().min(1).optional(),
          })
          .strict()
          .refine(
            (tool) =>
              tool.operationId !== undefined ||
              (tool.method !== undefined && tool.path !== undefined),
            { message: "select an operation by operationId or by method + path" },
          ),
      )
      .min(1),
  })
  .strict();

export type ManifestCuration = z.infer<typeof manifestCurationSchema>;
export type ManifestCurationInput = z.input<typeof manifestCurationSchema>;
type CuratedTool = ManifestCuration["tools"][number];

export interface ManifestConversion {
  tools: ToolDefinition[];
  warnings: string[];
}

export interface ListedOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  deprecated: boolean;
}

/** Every operation in the document — the curator's raw material. */
export function listOperations(document: OpenApiDocument): ListedOperation[] {
  const operations: ListedOperation[] = [];
  for (const [path, item] of document.paths) {
    for (const [method, operation] of item.operations) {
      const listed: ListedOperation = { method, path, deprecated: operation.deprecated === true };
      if (typeof operation.operationId === "string") listed.operationId = operation.operationId;
      const summary = operation.summary ?? operation.description;
      if (typeof summary === "string" && summary.trim() !== "") {
        listed.summary = summary.trim().split("\n")[0] ?? "";
      }
      operations.push(listed);
    }
  }
  return operations;
}

interface FoundOperation {
  method: string;
  path: string;
  operation: OpenApiOperation;
  pathParameters: unknown[];
}

function findOperation(document: OpenApiDocument, curated: CuratedTool): FoundOperation {
  const matches: FoundOperation[] = [];
  for (const [path, item] of document.paths) {
    for (const [method, operation] of item.operations) {
      const selected =
        curated.operationId !== undefined
          ? operation.operationId === curated.operationId
          : method === curated.method && path === curated.path;
      if (selected) {
        matches.push({ method, path, operation, pathParameters: item.parameters ?? [] });
      }
    }
  }

  const label =
    curated.operationId !== undefined
      ? `operationId '${curated.operationId}'`
      : `${curated.method} ${curated.path}`;
  if (matches.length === 0) throw new OpenApiConversionError([`No operation matches ${label}`]);
  const [match] = matches;
  if (matches.length > 1 || match === undefined) {
    throw new OpenApiConversionError([`Multiple operations match ${label}`]);
  }
  return match;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function defaultName(found: FoundOperation): string {
  if (found.operation.operationId) {
    const name = toSnakeCase(found.operation.operationId);
    if (name !== "") return name;
  }
  const slug = toSnakeCase(found.path.replaceAll(/\{([^{}]+)\}/g, "by_$1"));
  return toSnakeCase(`${found.method}_${slug}`);
}

const maxDescriptionLength = 400;

function defaultDescription(found: FoundOperation, warnings: string[], name: string): string {
  const summary = found.operation.summary?.trim();
  const description = found.operation.description?.trim();
  const text = summary || description?.split("\n")[0]?.trim() || "";
  if (text === "") {
    warnings.push(`Tool '${name}': operation has no summary or description — write one by hand`);
    return `${found.method} ${found.path}`;
  }
  if (text.length > maxDescriptionLength) {
    warnings.push(`Tool '${name}': description truncated to ${maxDescriptionLength} characters`);
    return `${text.slice(0, maxDescriptionLength - 1).trimEnd()}…`;
  }
  return text;
}

interface ResolvedParameter {
  name: string;
  location: string;
  required: boolean;
  schema: unknown;
}

function resolveParameters(
  document: OpenApiDocument,
  found: FoundOperation,
  warnings: string[],
  toolName: string,
): ResolvedParameter[] {
  const byKey = new Map<string, ResolvedParameter>();
  // Operation-level parameters override path-level ones with the same name+in.
  for (const raw of [...found.pathParameters, ...(found.operation.parameters ?? [])]) {
    const parameter = inlineRefs(document, raw);
    if (!isJsonObject(parameter)) continue;
    const name = parameter.name;
    const location = parameter.in;
    if (typeof name !== "string" || typeof location !== "string") continue;

    if (location === "header" || location === "cookie") {
      warnings.push(
        `Tool '${toolName}': skipped ${location} parameter '${name}' — auth and headers are transport concerns`,
      );
      continue;
    }

    const resolved: ResolvedParameter = {
      name,
      location,
      required: location === "path" ? true : parameter.required === true,
      schema: describeParameter(parameter),
    };
    byKey.set(`${location}:${name}`, resolved);
  }
  return [...byKey.values()];
}

function describeParameter(parameter: JsonObject): unknown {
  const schema: JsonObject = isJsonObject(parameter.schema)
    ? { ...parameter.schema }
    : { type: "string" };
  if (schema.description === undefined && typeof parameter.description === "string") {
    const description = parameter.description.trim();
    if (description !== "") schema.description = description;
  }
  return schema;
}

interface BodyProperties {
  properties: JsonObject;
  required: string[];
}

function resolveBody(
  document: OpenApiDocument,
  found: FoundOperation,
  warnings: string[],
  toolName: string,
): BodyProperties {
  const empty: BodyProperties = { properties: {}, required: [] };
  if (found.operation.requestBody === undefined) return empty;

  const requestBody = inlineRefs(document, found.operation.requestBody);
  if (!isJsonObject(requestBody)) return empty;

  const content = isJsonObject(requestBody.content) ? requestBody.content : {};
  const jsonContent = Object.entries(content).find(([mediaType]) =>
    mediaType.startsWith("application/json"),
  )?.[1];
  if (!isJsonObject(jsonContent) || !isJsonObject(jsonContent.schema)) {
    if (Object.keys(content).length > 0) {
      warnings.push(
        `Tool '${toolName}': request body has no application/json schema — add body parameters by hand`,
      );
    }
    return empty;
  }

  const schema = jsonContent.schema;
  if (schema.type === "object" && isJsonObject(schema.properties)) {
    return {
      properties: schema.properties,
      required:
        requestBody.required === true && Array.isArray(schema.required)
          ? schema.required.filter((entry): entry is string => typeof entry === "string")
          : [],
    };
  }

  // Non-object bodies (arrays, primitives) ride under a single `body` key.
  warnings.push(`Tool '${toolName}': non-object request body exposed as a 'body' parameter`);
  return {
    properties: { body: schema },
    required: requestBody.required === true ? ["body"] : [],
  };
}

function buildParamsSchema(
  document: OpenApiDocument,
  found: FoundOperation,
  warnings: string[],
  toolName: string,
): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];

  for (const parameter of resolveParameters(document, found, warnings, toolName)) {
    properties[parameter.name] = parameter.schema;
    if (parameter.required) required.push(parameter.name);
  }

  const body = resolveBody(document, found, warnings, toolName);
  for (const [name, schema] of Object.entries(body.properties)) {
    if (name in properties) {
      warnings.push(
        `Tool '${toolName}': body property '${name}' collides with a parameter — kept the parameter`,
      );
      continue;
    }
    properties[name] = schema;
  }
  for (const name of body.required) {
    if (typeof properties[name] !== "undefined" && !required.includes(name)) required.push(name);
  }

  const schema: JsonObject = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function pathPlaceholderIssues(found: FoundOperation, properties: JsonObject): string[] {
  const placeholders = [...found.path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? "");
  return placeholders
    .filter((placeholder) => !(placeholder in properties))
    .map(
      (placeholder) =>
        `Operation ${found.method} ${found.path} has no parameter for path placeholder '${placeholder}'`,
    );
}

/**
 * Convert a curated subset of an OpenAPI 3.x document into tool-manifest
 * entries ready to paste into a ProviderDef.
 */
export function openApiSpecToToolManifest(
  document: OpenApiDocument,
  curation: ManifestCurationInput,
): ManifestConversion {
  const parsed = manifestCurationSchema.parse(curation);
  const warnings: string[] = [];
  const issues: string[] = [];
  const tools: ToolDefinition[] = [];

  for (const curated of parsed.tools) {
    const found = findOperation(document, curated);
    if (found.operation.deprecated === true) {
      warnings.push(`Operation ${found.method} ${found.path} is deprecated`);
    }

    const name = curated.name ?? defaultName(found);
    const paramsSchema = buildParamsSchema(document, found, warnings, name);
    issues.push(
      ...pathPlaceholderIssues(
        found,
        isJsonObject(paramsSchema.properties) ? paramsSchema.properties : {},
      ),
    );

    const tool = toolDefinitionSchema.parse({
      name,
      description: curated.description ?? defaultDescription(found, warnings, name),
      method: found.method,
      path: found.path,
      paramsSchema,
    });
    tools.push(tool);
  }

  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      issues.push(`Duplicate tool name '${tool.name}' — set distinct names in the curation config`);
    }
    seen.add(tool.name);
  }

  if (issues.length > 0) throw new OpenApiConversionError(issues);
  return { tools, warnings };
}
