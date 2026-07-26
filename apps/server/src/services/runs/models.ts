import type { ModelPort, ModelRef } from "@trema/harness";
import { createSdkModelPort } from "@trema/models";

import type { Database } from "#server/lib/db/index.js";
import { resolveEndpoints, resolveRoleModel } from "#server/services/model-providers/index.js";

/** A deployment with no configured model endpoint cannot run the loop. */
export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

/** The model port and the reference every run turn uses, both from the registry. */
export interface ConfiguredModel {
  modelPort: ModelPort;
  model: ModelRef;
}

/** How the run path reaches stored credentials. */
export interface ResolveConfiguredModelOptions {
  masterKey?: string;
}

/**
 * Builds the model port from the organization's provider registry and its
 * `turns` role default.
 *
 * Model configuration is control-plane data, not deployment configuration: it
 * is resolved per organization, when a run opens, and held only for that run.
 * @throws {ModelConfigurationError} When no provider or no `turns` default resolves.
 */
export async function resolveConfiguredModel(
  db: Database,
  orgId: string,
  options: ResolveConfiguredModelOptions = {},
): Promise<ConfiguredModel> {
  const endpoints = await resolveEndpoints(db, orgId, options);
  if (Object.keys(endpoints).length === 0) {
    throw new ModelConfigurationError(
      "No model provider is configured for this organization; add one before executing runs",
    );
  }

  const turns = await resolveRoleModel(db, orgId, "turns");
  if (turns === undefined) {
    throw new ModelConfigurationError(
      "No model is assigned to the turns role for this organization",
    );
  }
  if (endpoints[turns.providerName] === undefined) {
    throw new ModelConfigurationError(
      `The turns role names no configured provider: ${turns.providerName}`,
    );
  }

  return {
    modelPort: createSdkModelPort({ endpoints }),
    model: { id: turns.modelId, provider: turns.providerName },
  };
}
