import type {
  CapabilityProvider,
  CapabilityRoute,
  Prisma,
} from "#server/generated/prisma/client.js";
import { decryptEnvelope, encryptEnvelope } from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { z } from "zod";

export const capabilityKeys = ["web.search", "web.fetch"] as const;
export type CapabilityKey = (typeof capabilityKeys)[number];

export const capabilityDriverKeys = [
  "brave_search",
  "tavily_search",
  "builtin_web_fetch",
] as const;
export type CapabilityDriverKey = (typeof capabilityDriverKeys)[number];

const builtinFetchSettingsSchema = z
  .object({
    timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
    maxBytes: z.number().int().min(16_384).max(5_000_000).default(1_000_000),
    maxCharacters: z.number().int().min(1_000).max(200_000).default(50_000),
  })
  .strict();

const noSettingsSchema = z.object({}).strict();

export type BuiltinFetchSettings = z.infer<typeof builtinFetchSettingsSchema>;

interface CapabilityDriverDefinition {
  key: CapabilityDriverKey;
  label: string;
  capability: CapabilityKey;
  credentialRequired: boolean;
  settingsSchema: z.ZodType<Record<string, unknown>>;
  defaultSettings: Record<string, unknown>;
}

export const capabilityDriverCatalog: readonly CapabilityDriverDefinition[] = [
  {
    key: "brave_search",
    label: "Brave Search",
    capability: "web.search",
    credentialRequired: true,
    settingsSchema: noSettingsSchema,
    defaultSettings: {},
  },
  {
    key: "tavily_search",
    label: "Tavily",
    capability: "web.search",
    credentialRequired: true,
    settingsSchema: noSettingsSchema,
    defaultSettings: {},
  },
  {
    key: "builtin_web_fetch",
    label: "Built-in web fetch",
    capability: "web.fetch",
    credentialRequired: false,
    settingsSchema: builtinFetchSettingsSchema,
    defaultSettings: builtinFetchSettingsSchema.parse({}),
  },
] as const;

const routeChainSchema = z.array(z.string().trim().min(1));
const providerNamePattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function driverDefinition(driverKey: string): CapabilityDriverDefinition {
  const definition = capabilityDriverCatalog.find(({ key }) => key === driverKey);
  if (definition === undefined) {
    throw new CapabilityValidationError(`Unknown capability driver: ${driverKey}`);
  }
  return definition;
}

function parseSettings(
  definition: CapabilityDriverDefinition,
  value: unknown,
): Record<string, unknown> {
  const parsed = definition.settingsSchema.safeParse(value ?? definition.defaultSettings);
  if (!parsed.success) {
    throw new CapabilityValidationError(`Invalid settings for ${definition.label}`);
  }
  return parsed.data;
}

function parseRouteChain(row: Pick<CapabilityRoute, "chainJson">): string[] {
  const parsed = routeChainSchema.safeParse(row.chainJson);
  if (!parsed.success) throw new CapabilityValidationError("Stored capability route is malformed");
  return parsed.data;
}

export class CapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityValidationError";
  }
}

export class CapabilityProviderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityProviderNotFoundError";
  }
}

export interface CapabilityProviderSummary {
  name: string;
  label: string;
  driverKey: CapabilityDriverKey;
  capability: CapabilityKey;
  hasCredential: boolean;
  settings: Record<string, unknown>;
  updatedAt: Date;
}

export interface CapabilityRouteSummary {
  capabilityKey: CapabilityKey;
  chain: string[];
  updatedAt: Date;
}

export interface ResolvedCapabilityProvider extends CapabilityProviderSummary {
  credential?: string;
}

function toProviderSummary(provider: CapabilityProvider): CapabilityProviderSummary {
  const definition = driverDefinition(provider.driverKey);
  return {
    name: provider.name,
    label: provider.label,
    driverKey: definition.key,
    capability: definition.capability,
    hasCredential: provider.credentialCiphertext !== null,
    settings: parseSettings(definition, provider.settingsJson),
    updatedAt: provider.updatedAt,
  };
}

export function capabilityDriverSummaries() {
  return capabilityDriverCatalog.map((definition) => ({
    key: definition.key,
    label: definition.label,
    capability: definition.capability,
    credentialRequired: definition.credentialRequired,
    defaultSettings: definition.defaultSettings,
  }));
}

export async function listCapabilityProviders(
  db: Database,
  orgId: string,
): Promise<CapabilityProviderSummary[]> {
  const rows = await db.capabilityProvider.findMany({
    where: { orgId },
    orderBy: [{ label: "asc" }, { name: "asc" }],
  });
  return rows.map(toProviderSummary);
}

export async function listCapabilityRoutes(
  db: Database,
  orgId: string,
): Promise<CapabilityRouteSummary[]> {
  const rows = await db.capabilityRoute.findMany({
    where: { orgId },
    orderBy: { capabilityKey: "asc" },
  });
  return rows.map((row) => {
    if (!capabilityKeys.includes(row.capabilityKey as CapabilityKey)) {
      throw new CapabilityValidationError("Stored capability route has an unknown key");
    }
    return {
      capabilityKey: row.capabilityKey as CapabilityKey,
      chain: parseRouteChain(row),
      updatedAt: row.updatedAt,
    };
  });
}

export interface PutCapabilityProviderInput {
  orgId: string;
  actorPrincipalId: string;
  name: string;
  label?: string;
  driverKey: CapabilityDriverKey;
  settings?: Record<string, unknown>;
  /** Omit to keep the stored credential; null clears it. */
  credential?: string | null;
  masterKey?: string;
}

export async function putCapabilityProvider(
  db: Database,
  input: PutCapabilityProviderInput,
): Promise<CapabilityProviderSummary> {
  const name = input.name.trim();
  if (!providerNamePattern.test(name)) {
    throw new CapabilityValidationError(
      "Provider names use lowercase letters, numbers, hyphens, and underscores",
    );
  }
  const label = (input.label ?? name).trim();
  if (label === "") throw new CapabilityValidationError("Provider label cannot be empty");

  const definition = driverDefinition(input.driverKey);
  const existing = await db.capabilityProvider.findUnique({
    where: { orgId_name: { orgId: input.orgId, name } },
  });
  if (
    existing !== null &&
    existing.driverKey !== input.driverKey &&
    input.credential === undefined &&
    existing.credentialCiphertext !== null
  ) {
    throw new CapabilityValidationError(
      "Changing a provider driver means entering its credential again",
    );
  }
  if (!definition.credentialRequired && typeof input.credential === "string") {
    throw new CapabilityValidationError(`${definition.label} does not take a credential`);
  }
  const keepsCredential =
    input.credential === undefined &&
    existing?.driverKey === input.driverKey &&
    existing.credentialCiphertext !== null;
  if (
    definition.credentialRequired &&
    typeof input.credential !== "string" &&
    !keepsCredential
  ) {
    throw new CapabilityValidationError(`${definition.label} needs an API key`);
  }

  const settings = parseSettings(
    definition,
    input.settings ?? (existing?.driverKey === input.driverKey ? existing.settingsJson : undefined),
  );
  const credentialCiphertext = !definition.credentialRequired
    ? null
    : input.credential === undefined
      ? undefined
      : input.credential === null
        ? null
        : encryptEnvelope(input.credential.trim(), input.masterKey);

  const provider = await db.$transaction(async (transaction) => {
    const saved = await transaction.capabilityProvider.upsert({
      where: { orgId_name: { orgId: input.orgId, name } },
      create: {
        orgId: input.orgId,
        name,
        label,
        driverKey: input.driverKey,
        settingsJson: settings as Prisma.InputJsonValue,
        ...(credentialCiphertext === undefined ? {} : { credentialCiphertext }),
      },
      update: {
        label,
        driverKey: input.driverKey,
        settingsJson: settings as Prisma.InputJsonValue,
        ...(credentialCiphertext === undefined ? {} : { credentialCiphertext }),
      },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: existing === null ? "capability.provider.create" : "capability.provider.update",
        subject: saved.id,
        payload: { providerName: name, driverKey: input.driverKey },
      },
    });
    return saved;
  });
  log.info("Capability provider saved", {
    providerName: provider.name,
    driverKey: provider.driverKey,
  });
  return toProviderSummary(provider);
}

export async function deleteCapabilityProvider(
  db: Database,
  input: { orgId: string; actorPrincipalId: string; name: string },
): Promise<void> {
  const provider = await db.capabilityProvider.findUnique({
    where: { orgId_name: { orgId: input.orgId, name: input.name } },
  });
  if (provider === null) {
    throw new CapabilityProviderNotFoundError(`Capability provider not found: ${input.name}`);
  }

  await db.$transaction(async (transaction) => {
    const routes = await transaction.capabilityRoute.findMany({ where: { orgId: input.orgId } });
    for (const route of routes) {
      const chain = parseRouteChain(route).filter((name) => name !== input.name);
      if (chain.length === 0) {
        await transaction.capabilityRoute.delete({ where: { id: route.id } });
      } else if (chain.length !== parseRouteChain(route).length) {
        await transaction.capabilityRoute.update({
          where: { id: route.id },
          data: { chainJson: chain },
        });
      }
    }
    await transaction.capabilityProvider.delete({ where: { id: provider.id } });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "capability.provider.delete",
        subject: provider.id,
        payload: { providerName: provider.name, driverKey: provider.driverKey },
      },
    });
  });
  log.info("Capability provider deleted", {
    providerName: provider.name,
    driverKey: provider.driverKey,
  });
}

export async function putCapabilityRoute(
  db: Database,
  input: {
    orgId: string;
    actorPrincipalId: string;
    capabilityKey: CapabilityKey;
    chain: string[];
  },
): Promise<CapabilityRouteSummary | null> {
  const chain = [...new Set(input.chain.map((name) => name.trim()).filter(Boolean))];
  if (chain.length === 0) {
    const removed = await db.$transaction(async (transaction) => {
      const route = await transaction.capabilityRoute.findUnique({
        where: {
          orgId_capabilityKey: {
            orgId: input.orgId,
            capabilityKey: input.capabilityKey,
          },
        },
      });
      if (route === null) return false;
      await transaction.capabilityRoute.delete({ where: { id: route.id } });
      await transaction.auditLog.create({
        data: {
          orgId: input.orgId,
          actorPrincipalId: input.actorPrincipalId,
          action: "capability.route.disable",
          subject: route.id,
          payload: { capabilityKey: input.capabilityKey },
        },
      });
      return true;
    });
    if (removed) log.info("Capability route disabled", { capabilityKey: input.capabilityKey });
    return null;
  }

  const providers = await db.capabilityProvider.findMany({
    where: { orgId: input.orgId, name: { in: chain } },
  });
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  for (const name of chain) {
    const provider = byName.get(name);
    if (provider === undefined) {
      throw new CapabilityValidationError(`Capability provider not found: ${name}`);
    }
    const definition = driverDefinition(provider.driverKey);
    if (definition.capability !== input.capabilityKey) {
      throw new CapabilityValidationError(
        `${provider.label} does not provide ${input.capabilityKey}`,
      );
    }
    if (definition.credentialRequired && provider.credentialCiphertext === null) {
      throw new CapabilityValidationError(`${provider.label} has no credential`);
    }
  }

  const route = await db.$transaction(async (transaction) => {
    const saved = await transaction.capabilityRoute.upsert({
      where: {
        orgId_capabilityKey: {
          orgId: input.orgId,
          capabilityKey: input.capabilityKey,
        },
      },
      create: {
        orgId: input.orgId,
        capabilityKey: input.capabilityKey,
        chainJson: chain,
      },
      update: { chainJson: chain },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "capability.route.update",
        subject: saved.id,
        payload: { capabilityKey: input.capabilityKey, chain },
      },
    });
    return saved;
  });
  log.info("Capability route saved", {
    capabilityKey: input.capabilityKey,
    providerCount: chain.length,
  });
  return { capabilityKey: input.capabilityKey, chain, updatedAt: route.updatedAt };
}

export async function enabledCapabilityKeys(
  db: Database,
  orgId: string,
): Promise<CapabilityKey[]> {
  const rows = await db.capabilityRoute.findMany({
    where: { orgId, capabilityKey: { in: [...capabilityKeys] } },
    select: { capabilityKey: true, chainJson: true },
  });
  return rows.flatMap((row) =>
    parseRouteChain(row).length > 0 ? [row.capabilityKey as CapabilityKey] : [],
  );
}

export async function resolveCapabilityProviders(
  db: Database,
  input: { orgId: string; capabilityKey: CapabilityKey; masterKey?: string },
): Promise<ResolvedCapabilityProvider[]> {
  const route = await db.capabilityRoute.findUnique({
    where: {
      orgId_capabilityKey: {
        orgId: input.orgId,
        capabilityKey: input.capabilityKey,
      },
    },
  });
  if (route === null) return [];
  const chain = parseRouteChain(route);
  const rows = await db.capabilityProvider.findMany({
    where: { orgId: input.orgId, name: { in: chain } },
  });
  const byName = new Map(rows.map((row) => [row.name, row]));
  const resolved: ResolvedCapabilityProvider[] = [];
  for (const name of chain) {
    const row = byName.get(name);
    if (row === undefined) continue;
    const definition = driverDefinition(row.driverKey);
    if (definition.capability !== input.capabilityKey) continue;
    let credential: string | undefined;
    if (definition.credentialRequired) {
      if (row.credentialCiphertext === null) continue;
      try {
        credential = decryptEnvelope<string>(row.credentialCiphertext, input.masterKey);
      } catch (error) {
        log.warn("Capability provider skipped", {
          providerName: row.name,
          driverKey: row.driverKey,
          reason: "credential_unreadable",
          errorName: error instanceof Error ? error.name : typeof error,
        });
        continue;
      }
    }
    resolved.push({
      ...toProviderSummary(row),
      ...(credential === undefined ? {} : { credential }),
    });
  }
  return resolved;
}
