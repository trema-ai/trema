import type { ModelPort, ModelRef } from "@trema/harness";
import { createSdkModelPort } from "@trema/models";

import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  type ModelChainEntry,
  providerCatalog,
  resolveEndpoints,
  resolveRoleChain,
} from "#server/services/model-providers/index.js";

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
  /** A model pinned when the run was dispatched. */
  model?: ModelChainEntry;
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

  if (options.model !== undefined) {
    const provider = await db.modelProvider.findUnique({
      where: { orgId_name: { orgId, name: options.model.providerName } },
    });
    let modelExists = false;
    if (provider !== null) {
      try {
        modelExists = providerCatalog(provider).some(
          (entry) => entry.id === options.model?.modelId,
        );
      } catch {
        modelExists = false;
      }
    }
    const usable =
      endpoints[options.model.providerName] !== undefined && provider !== null && modelExists;
    if (usable) {
      return {
        modelPort: createSdkModelPort({ endpoints }),
        model: { id: options.model.modelId, provider: options.model.providerName },
      };
    }
    log.warn("Stored run model is unavailable; using the turns default", {
      providerName: options.model.providerName,
      modelId: options.model.modelId,
    });
  }

  const chain = await resolveRoleChain(db, orgId, "turns");
  if (chain.length === 0) {
    throw new ModelConfigurationError(
      "No model is assigned to the turns role for this organization",
    );
  }
  // Walked against the resolved endpoints rather than against the rows, so a
  // provider that exists but cannot be read falls through to the next entry
  // instead of stopping the chain at itself.
  const turns = chain.find((entry) => endpoints[entry.providerName] !== undefined);
  if (turns === undefined) {
    throw new ModelConfigurationError(
      `The turns role names no usable provider: ${chain.map((entry) => entry.providerName).join(", ")}`,
    );
  }

  return {
    modelPort: createSdkModelPort({ endpoints }),
    model: { id: turns.modelId, provider: turns.providerName },
  };
}
