import { loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";
import { ConnectorProviderNotFoundError } from "#/services/connectors/registrations.js";

const defaultCatalog = loadProviderCatalog();

export class ConnectorProviderSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorProviderSettingsError";
  }
}

export async function listConnectorProviderSettings(db: Database, orgId: string) {
  return db.connectorProviderSettings.findMany({
    where: { orgId },
    orderBy: [{ providerKey: "asc" }],
  });
}

export async function updateConnectorProviderSettings(
  db: Database,
  input: {
    orgId: string;
    providerKey: string;
    memberEnabled: boolean;
    catalog?: ProviderCatalog;
  },
) {
  const provider = (input.catalog ?? defaultCatalog).find(({ key }) => key === input.providerKey);
  if (!provider) {
    log.warn("Connector provider settings rejected", {
      provider: input.providerKey,
      reason: "unknown_provider",
    });
    throw new ConnectorProviderNotFoundError(input.providerKey);
  }
  if (input.memberEnabled && !provider.memberConnectable) {
    log.warn("Connector provider settings rejected", {
      provider: input.providerKey,
      reason: "member_connectable_disabled",
    });
    throw new ConnectorProviderSettingsError(
      `Provider '${provider.key}' does not allow member connections`,
    );
  }
  const settings = await db.connectorProviderSettings.upsert({
    where: {
      orgId_providerKey: { orgId: input.orgId, providerKey: input.providerKey },
    },
    create: {
      orgId: input.orgId,
      providerKey: input.providerKey,
      memberEnabled: input.memberEnabled,
    },
    update: { memberEnabled: input.memberEnabled },
  });
  log.info("Connector provider settings updated", {
    provider: input.providerKey,
    memberEnabled: input.memberEnabled,
  });
  return settings;
}
