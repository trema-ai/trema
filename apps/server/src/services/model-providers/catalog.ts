import type { ModelRole } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  listDefaults,
  type ModelCatalogEntry,
  ModelProviderNotFoundError,
  normalizeCatalog,
  providerCatalog,
} from "#server/services/model-providers/index.js";
import {
  fetchRemoteModels,
  type RemoteCallOptions,
  type RemoteModel,
} from "#server/services/model-providers/remote.js";

/** The families whose names say "embedding" without the word in them. */
const embeddingFamilies = /(^|[/\-_.])(bge|gte|e5|voyage)([-_.]|$)/;

/**
 * Whether a model id reads like an embedding model. The OpenAI-compatible
 * listing shape carries no capability field, so where a provider states
 * nothing this is all there is to go on.
 */
function looksLikeEmbeddingModel(id: string): boolean {
  const value = id.toLowerCase();
  return value.includes("embed") || embeddingFamilies.test(value);
}

/**
 * The roles a newly imported model starts with. What the listing said about its
 * own model is believed; the name heuristic answers only where it said nothing,
 * and never overrules it. An entry with no roles is unrestricted, which is what
 * a model that is not an embedder gets.
 */
function importedRoles(model: RemoteModel): ModelRole[] {
  return (model.embedding ?? looksLikeEmbeddingModel(model.id)) ? ["embed"] : [];
}

/**
 * Whether a stored entry says something the provider's listing cannot. Roles, a
 * label, and a context window are all the admin's to set; a role default naming
 * the model is the deployment depending on it. Anything else in the catalog got
 * there by import alone, and a refresh may drop it.
 */
function carriesAdminIntent(entry: ModelCatalogEntry, pinned: ReadonlySet<string>): boolean {
  return (
    (entry.roles?.length ?? 0) > 0 ||
    entry.label !== undefined ||
    entry.contextWindow !== undefined ||
    pinned.has(entry.id)
  );
}

export interface CatalogMergeInput {
  /** The catalog as stored before the refresh. */
  stored: ModelCatalogEntry[];
  /** What the provider says it serves right now. */
  listed: RemoteModel[];
  /** Model ids on this provider that a role default names. */
  pinned: ReadonlySet<string>;
}

/**
 * The catalog a refresh writes: everything the provider listed, merged with
 * every stored entry that carries admin intent.
 *
 * The rule, in the order it resolves:
 *
 * 1. A listed model that is already stored keeps its stored entry whole. A
 *    refresh never clobbers a label, a context window, or a role the admin set
 *    — re-import is not an edit.
 * 2. A listed model that is not stored is imported, with roles defaulted from
 *    the listing's own capability statement where it made one and from the
 *    model's name where it did not.
 * 3. A stored entry the listing no longer names survives only if it carries
 *    admin intent. Auto-imported entries for models a provider has retired go,
 *    which is what keeps the list the provider's own menu.
 */
export function mergeCatalog(input: CatalogMergeInput): ModelCatalogEntry[] {
  const stored = new Map(input.stored.map((entry) => [entry.id, entry]));
  const listed = new Set(input.listed.map((model) => model.id));
  const merged: ModelCatalogEntry[] = [];

  for (const model of input.listed) {
    const entry = stored.get(model.id);
    if (entry !== undefined) {
      merged.push(entry);
      continue;
    }
    const roles = importedRoles(model);
    merged.push({ id: model.id, ...(roles.length === 0 ? {} : { roles }) });
  }
  for (const entry of input.stored) {
    if (listed.has(entry.id)) continue;
    if (carriesAdminIntent(entry, input.pinned)) merged.push(entry);
  }
  return merged.sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** What a refresh did, or the sentence explaining why it did nothing. */
export type CatalogRefreshResult =
  | { ok: true; latencyMs: number; added: number; removed: number }
  | { ok: false; reason: string };

/**
 * Rewrites one provider's catalog from its own model listing. The listing is
 * the menu: the stored catalog is annotations over it, refreshed on demand
 * rather than curated one model at a time.
 *
 * A provider that cannot be reached is a result, not an error — the stored
 * catalog is left exactly as it was.
 */
export async function refreshProviderCatalog(
  db: Database,
  orgId: string,
  name: string,
  options: RemoteCallOptions = {},
): Promise<CatalogRefreshResult> {
  const listing = await fetchRemoteModels(db, orgId, name, options);
  if (!listing.ok) return listing;

  const provider = await db.modelProvider.findUnique({ where: { orgId_name: { orgId, name } } });
  if (!provider) throw new ModelProviderNotFoundError(`Model provider not found: ${name}`);
  const stored = providerCatalog(provider);
  const defaults = await listDefaults(db, orgId);
  const pinned = new Set(
    defaults.flatMap((entry) =>
      entry.chain.filter((link) => link.providerName === name).map((link) => link.modelId),
    ),
  );

  const merged = mergeCatalog({ stored, listed: listing.models, pinned });
  await db.modelProvider.update({
    where: { orgId_name: { orgId, name } },
    data: { catalogJson: normalizeCatalog(merged) },
  });

  const storedIds = new Set(stored.map((entry) => entry.id));
  const mergedIds = new Set(merged.map((entry) => entry.id));
  const added = merged.filter((entry) => !storedIds.has(entry.id)).length;
  const removed = stored.filter((entry) => !mergedIds.has(entry.id)).length;
  log.info("Model provider catalog refreshed", {
    providerName: name,
    modelCount: merged.length,
    added,
    removed,
  });
  return { ok: true, latencyMs: listing.latencyMs, added, removed };
}

/**
 * Populates a new provider's catalog from its own listing, inline with the
 * create. Best-effort by design: a bad credential, an unreachable host, or a
 * malformed answer leaves the provider with an empty catalog and an admin who
 * can refresh it later, rather than failing a create whose row is valid.
 */
export async function importProviderCatalog(
  db: Database,
  orgId: string,
  name: string,
  options: RemoteCallOptions = {},
): Promise<void> {
  try {
    const result = await refreshProviderCatalog(db, orgId, name, options);
    if (!result.ok) {
      log.info("Model provider catalog not imported", {
        providerName: name,
        reason: result.reason,
      });
    }
  } catch (error) {
    log.warn("Model provider catalog import failed", { providerName: name, error });
  }
}
