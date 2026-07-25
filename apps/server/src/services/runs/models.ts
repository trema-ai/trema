import type { ModelPort, ModelRef } from "@trema/harness";
import { createSdkModelPort, type ModelEndpoints } from "@trema/models";
import { z } from "zod";

import type { Environment } from "#server/lib/env/schema.js";

const endpointSchema = z.object({
  protocol: z.literal("openai-compatible"),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

const endpointsSchema = z.record(z.string().trim().min(1), endpointSchema);

/** A deployment with no configured model endpoint cannot run the loop. */
export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

/**
 * Parses the named endpoint map.
 * Model endpoints are customer configuration; there is no default endpoint and
 * no provider name in the code.
 * @throws {ModelConfigurationError} When the value is not a valid endpoint map.
 */
export function parseModelEndpoints(raw: string): ModelEndpoints {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelConfigurationError("TREMA_MODEL_ENDPOINTS must be a JSON object");
  }
  const result = endpointsSchema.safeParse(parsed);
  if (!result.success) {
    throw new ModelConfigurationError(
      `Invalid TREMA_MODEL_ENDPOINTS:\n${z.prettifyError(result.error)}`,
    );
  }
  return Object.fromEntries(
    Object.entries(result.data).map(([name, endpoint]) => [
      name,
      {
        protocol: endpoint.protocol,
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }),
      },
    ]),
  );
}

/** The model port and the reference every run turn uses, both from configuration. */
export interface ConfiguredModel {
  modelPort: ModelPort;
  model: ModelRef;
}

/**
 * Builds the model port from the deployment's configuration.
 * @throws {ModelConfigurationError} When the endpoints, model, or provider are missing.
 */
export function resolveConfiguredModel(env: Environment): ConfiguredModel {
  if (!env.TREMA_MODEL_ENDPOINTS) {
    throw new ModelConfigurationError("TREMA_MODEL_ENDPOINTS is required to execute runs");
  }
  if (!env.TREMA_MODEL_ID) {
    throw new ModelConfigurationError("TREMA_MODEL_ID is required to execute runs");
  }
  const endpoints = parseModelEndpoints(env.TREMA_MODEL_ENDPOINTS);
  const provider = env.TREMA_MODEL_PROVIDER;
  if (provider !== undefined && endpoints[provider] === undefined) {
    throw new ModelConfigurationError(`TREMA_MODEL_PROVIDER names no endpoint: ${provider}`);
  }
  const names = Object.keys(endpoints);
  if (provider === undefined && names.length !== 1) {
    throw new ModelConfigurationError(
      "TREMA_MODEL_PROVIDER is required when more than one endpoint is configured",
    );
  }

  return {
    modelPort: createSdkModelPort({ endpoints }),
    model: { id: env.TREMA_MODEL_ID, provider: provider ?? names[0]! },
  };
}
