import { z } from "zod";

import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { log } from "#server/lib/logger/index.js";
import { putDefaults, putProvider } from "#server/services/model-providers/index.js";

/**
 * The environment's endpoint map, as it was defined before the registry
 * existed. It is read once, to seed an empty registry, and never again — so
 * this schema is frozen at the shape deployments already write.
 */
const envEndpointSchema = z.object({
  protocol: z.literal("openai-compatible"),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

const envEndpointsSchema = z.record(z.string().trim().min(1), envEndpointSchema);

type EnvEndpoints = z.infer<typeof envEndpointsSchema>;

function parseEnvEndpoints(raw: string): EnvEndpoints | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.error("Model endpoint environment ignored", { reason: "not_json" });
    return undefined;
  }
  const result = envEndpointsSchema.safeParse(parsed);
  if (!result.success) {
    log.error("Model endpoint environment ignored", {
      reason: "invalid",
      detail: z.prettifyError(result.error),
    });
    return undefined;
  }
  return result.data;
}

/** Which endpoint the `turns` default should name, or undefined if unresolvable. */
function seedProviderName(endpoints: EnvEndpoints, env: Environment): string | undefined {
  const names = Object.keys(endpoints);
  if (env.TREMA_MODEL_PROVIDER !== undefined) {
    if (endpoints[env.TREMA_MODEL_PROVIDER] === undefined) {
      log.error("Model role default not seeded", {
        reason: "unknown_provider",
        providerName: env.TREMA_MODEL_PROVIDER,
      });
      return undefined;
    }
    return env.TREMA_MODEL_PROVIDER;
  }
  if (names.length !== 1) {
    log.error("Model role default not seeded", { reason: "provider_required" });
    return undefined;
  }
  return names[0];
}

async function seedOrg(db: Database, env: Environment, orgId: string): Promise<void> {
  const existing = await db.modelProvider.count({ where: { orgId } });
  if (existing > 0) {
    // The registry owns the configuration from its first row onwards. Saying so
    // out loud is the whole reason an operator can trust one source.
    log.info("Model endpoint environment ignored", { orgId, reason: "registry_configured" });
    return;
  }

  const endpoints = parseEnvEndpoints(env.TREMA_MODEL_ENDPOINTS ?? "");
  if (endpoints === undefined) return;

  const masterKey = env.TREMA_CREDENTIAL_MASTER_KEY;
  for (const [name, endpoint] of Object.entries(endpoints)) {
    await putProvider(db, {
      orgId,
      name,
      label: name,
      protocol: "openai_compatible",
      baseUrl: endpoint.baseUrl,
      credentialMode: "api_key",
      credential: endpoint.apiKey,
      ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }),
      ...(masterKey === undefined ? {} : { masterKey }),
    });
  }

  if (env.TREMA_MODEL_ID === undefined) {
    log.warn("Model role default not seeded", { orgId, reason: "model_id_missing" });
    return;
  }
  const providerName = seedProviderName(endpoints, env);
  if (providerName === undefined) return;

  await putDefaults(db, {
    orgId,
    role: "turns",
    chain: [{ providerName, modelId: env.TREMA_MODEL_ID }],
  });
  log.info("Model provider registry seeded from the environment", {
    orgId,
    providerCount: Object.keys(endpoints).length,
  });
}

/**
 * Seeds the model provider registry from the environment, for one organization
 * or for every organization whose registry is empty.
 *
 * The environment is bootstrap, not the interface: an air-gapped first boot has
 * no admin UI yet, so it can hand the deployment an endpoint. Once a row
 * exists, the registry is the only source, and a failure here is logged rather
 * than thrown — a deployment that only serves context still starts.
 */
export async function seedModelProvidersFromEnv(
  db: Database,
  env: Environment,
  orgId?: string,
): Promise<void> {
  if (!env.TREMA_MODEL_ENDPOINTS) return;

  const orgIds =
    orgId === undefined
      ? (await db.org.findMany({ select: { id: true } })).map((org) => org.id)
      : [orgId];

  for (const id of orgIds) {
    try {
      await seedOrg(db, env, id);
    } catch (error) {
      log.error("Model provider seeding failed", { orgId: id, error });
    }
  }
}
