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

/**
 * Whether a stored entry says something the provider's listing cannot. Being
 * offered in the picker, a label, and a context window are all the admin's to
 * set; a role default naming the model is the deployment depending on it.
 * Anything else in the catalog got there by import alone, and a refresh may
 * drop it.
 */
function carriesAdminIntent(entry: ModelCatalogEntry, pinned: ReadonlySet<string>): boolean {
  return (
    entry.offered === true ||
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
 *    refresh never clobbers a label, a context window, or the picker choice the
 *    admin made — re-import is not an edit.
 * 2. A listed model that is not stored is imported bare. The provider names it;
 *    nothing else about it has been decided yet.
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
    merged.push({ id: model.id });
  }
  for (const entry of input.stored) {
    if (listed.has(entry.id)) continue;
    if (carriesAdminIntent(entry, input.pinned)) merged.push(entry);
  }
  return merged.sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** How many times a refresh re-merges before it gives up and says so. */
const mergeAttempts = 3;

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

  // The merge reads the stored catalog and writes it back, so an admin editing
  // the same row in between would lose their edit. The write is conditional on
  // the row not having moved since the read, and a row that moved is merged
  // again against what is there now. The listing is already in hand, so a retry
  // costs a query rather than another call to the provider.
  for (let attempt = 0; attempt < mergeAttempts; attempt += 1) {
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
    const written = await db.modelProvider.updateMany({
      where: { orgId, name, updatedAt: provider.updatedAt },
      data: { catalogJson: normalizeCatalog(merged) },
    });
    if (written.count === 0) continue;

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

  log.warn("Model provider catalog refresh contended", { providerName: name });
  return {
    ok: false,
    reason: "The provider was being edited at the same time. Try the refresh again.",
  };
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
