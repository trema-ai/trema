import { z } from "zod";

import { type ProviderHookRegistry, providerHookRegistry } from "#/services/connectors/hooks.js";
import { providerDefinitions } from "#/services/connectors/providers/index.js";
import {
  type ProviderDef,
  type ProviderDefInput,
  providerDefSchema,
} from "#/services/connectors/schema.js";
import { extractPlaceholders } from "#/services/connectors/templates.js";

export type ProviderCatalog = readonly Readonly<ProviderDef>[];

export class ProviderCatalogValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid provider catalog:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ProviderCatalogValidationError";
    this.issues = issues;
  }
}

interface NamedTemplate {
  field: string;
  value: string;
}

function providerTemplates(provider: ProviderDef): NamedTemplate[] {
  const templates: NamedTemplate[] = [];
  for (const field of ["authorizationUrl", "tokenUrl", "refreshUrl"] as const) {
    const value = provider.auth[field];
    if (value) templates.push({ field: `auth.${field}`, value });
  }
  if (provider.transport.type === "rest") {
    templates.push({ field: "transport.baseUrl", value: provider.transport.baseUrl });
    if (provider.transport.authHeader) {
      templates.push({ field: "transport.authHeader", value: provider.transport.authHeader });
    }
    for (const [index, endpoint] of (provider.transport.verification?.endpoints ?? []).entries()) {
      templates.push({ field: `transport.verification.endpoints[${index}]`, value: endpoint });
    }
  } else {
    templates.push({ field: "transport.serverUrl", value: provider.transport.serverUrl });
  }

  for (const [index, tool] of provider.toolManifest.entries()) {
    templates.push({ field: `toolManifest[${index}].path`, value: tool.path });
  }
  return templates;
}

function templateIssues(provider: ProviderDef): string[] {
  const issues: string[] = [];
  for (const template of providerTemplates(provider)) {
    const placeholders = extractPlaceholders(template.value);
    for (const placeholder of placeholders) {
      if (placeholder === "clientId") continue;

      const match = /^(config|credentials)\.([A-Za-z0-9_]+)$/.exec(placeholder);
      const root = match?.[1];
      const key = match?.[2];
      const declared =
        root === "config"
          ? key !== undefined && Object.hasOwn(provider.configFields, key)
          : root === "credentials"
            ? key !== undefined && Object.hasOwn(provider.credentialFields, key)
            : false;
      if (!declared) {
        issues.push(
          `Provider '${provider.key}' ${template.field} has invalid placeholder '${placeholder}'`,
        );
      }
    }

    const withoutPlaceholders = template.value.replace(/\$\{[^{}]+\}/g, "");
    if (withoutPlaceholders.includes("${")) {
      issues.push(`Provider '${provider.key}' ${template.field} has a malformed placeholder`);
    }
  }
  return issues;
}

function hookIssues(provider: ProviderDef, hooks: ProviderHookRegistry): string[] {
  if (!provider.hooks) return [];
  return Object.entries(provider.hooks).flatMap(([field, hookName]) => {
    if (hookName === undefined || Object.hasOwn(hooks, hookName)) return [];
    return [`Provider '${provider.key}' hooks.${field} references unknown hook '${hookName}'`];
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function loadProviderCatalog(
  entries: readonly (ProviderDefInput | unknown)[] = providerDefinitions,
  hooks: ProviderHookRegistry = providerHookRegistry,
): ProviderCatalog {
  const issues: string[] = [];
  const providers: ProviderDef[] = [];

  for (const [index, entry] of entries.entries()) {
    const parsed = providerDefSchema.safeParse(entry);
    if (!parsed.success) {
      const key =
        typeof entry === "object" &&
        entry !== null &&
        "key" in entry &&
        typeof entry.key === "string"
          ? entry.key
          : `entry ${index}`;
      issues.push(`Provider '${key}' failed schema validation: ${z.prettifyError(parsed.error)}`);
      continue;
    }
    providers.push(parsed.data);
    issues.push(...templateIssues(parsed.data), ...hookIssues(parsed.data, hooks));
  }

  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.key)) issues.push(`Duplicate provider key '${provider.key}'`);
    seen.add(provider.key);
  }

  if (issues.length > 0) throw new ProviderCatalogValidationError(issues);
  return deepFreeze(providers);
}
