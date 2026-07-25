import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { requireCapability } from "#/rpc/builders.js";
import {
  deleteEmbeddingSettings,
  EmbeddingSettingsNotFoundError,
  EmbeddingSettingsValidationError,
  getEmbeddingSettings,
  putEmbeddingSettings,
} from "#/services/embeddings/index.js";
import { backfillEmbeddings, rebuildSearchIndex } from "#/services/search/index.js";

const settingsSchema = z
  .object({
    configured: z
      .boolean()
      .describe(
        "Whether the organization has an embedding endpoint. When false, search is text-only.",
      ),
    endpoint: z
      .string()
      .nullable()
      .describe("The base URL of the embeddings API, including the version path."),
    model: z.string().nullable().describe("The model that produces the vectors."),
    hasApiKey: z
      .boolean()
      .describe(
        "Whether a stored API key accompanies the endpoint. The key itself is never returned.",
      ),
    updatedAt: z
      .string()
      .nullable()
      .describe("When the settings last changed. An ISO 8601 date-time."),
  })
  .describe("The organization's embedding settings. The API key is write-only.");

function throwEmbeddingError(error: unknown): never {
  if (error instanceof EmbeddingSettingsNotFoundError) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof EmbeddingSettingsValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

const get = requireCapability("manage_models")
  .route({
    method: "GET",
    path: "/embedding-settings",
    summary: "Get the embedding settings",
    description:
      "Read the organization's embedding endpoint and model. The stored API key is never returned; only whether one is set.",
    tags: ["Embeddings"],
  })
  .output(settingsSchema)
  .handler(async ({ context }) => {
    const settings = await getEmbeddingSettings(context.db, context.org.id);
    if (!settings) {
      return { configured: false, endpoint: null, model: null, hasApiKey: false, updatedAt: null };
    }
    return {
      configured: true,
      endpoint: settings.endpoint,
      model: settings.model,
      hasApiKey: settings.apiKeyCiphertext !== null,
      updatedAt: settings.updatedAt.toISOString(),
    };
  });

const put = requireCapability("manage_models")
  .route({
    method: "PUT",
    path: "/embedding-settings",
    summary: "Set the embedding settings",
    description:
      "Point the organization at an OpenAI-compatible embeddings endpoint. Existing items keep their vectors until a reindex re-embeds them under the new model.",
    tags: ["Embeddings"],
  })
  .input(
    z
      .object({
        endpoint: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The base URL of the embeddings API, including the version path, such as `https://api.openai.com/v1`.",
          ),
        model: z.string().trim().min(1).describe("The model that produces the vectors."),
        apiKey: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "The API key, stored encrypted and never returned. Omit to keep the stored key; send null for an endpoint that needs none.",
          ),
      })
      .describe("The embedding settings to store."),
  )
  .output(settingsSchema)
  .handler(async ({ context, input }) => {
    try {
      const settings = await putEmbeddingSettings(context.db, {
        orgId: context.org.id,
        endpoint: input.endpoint,
        model: input.model,
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
      });
      return {
        configured: true,
        endpoint: settings.endpoint,
        model: settings.model,
        hasApiKey: settings.apiKeyCiphertext !== null,
        updatedAt: settings.updatedAt.toISOString(),
      };
    } catch (error) {
      throwEmbeddingError(error);
    }
  });

const remove = requireCapability("manage_models")
  .route({
    method: "DELETE",
    path: "/embedding-settings",
    summary: "Delete the embedding settings",
    description:
      "Stop embedding this organization's items. Search falls back to text matching. Stored vectors are left in place and are ignored until an endpoint is configured again.",
    tags: ["Embeddings"],
  })
  .output(z.object({ deleted: z.literal(true) }).describe("The settings were removed."))
  .handler(async ({ context }) => {
    try {
      await deleteEmbeddingSettings(context.db, context.org.id);
      return { deleted: true as const };
    } catch (error) {
      throwEmbeddingError(error);
    }
  });

const reindex = requireCapability("manage_models")
  .route({
    method: "POST",
    path: "/items/reindex",
    summary: "Rebuild the item search index",
    description:
      "Rebuild every item's search text, then embed the items that have no vector or whose vector came from an earlier model. Run it after changing the embedding settings.",
    tags: ["Embeddings"],
  })
  .output(
    z
      .object({
        embedded: z.number().int().describe("How many items received a vector."),
        failed: z.number().int().describe("How many items the endpoint could not embed."),
      })
      .describe("What the reindex did."),
  )
  .handler(async ({ context }) => {
    await rebuildSearchIndex(context.db, context.org.id);
    return backfillEmbeddings(context.db, context.org.id, {
      ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
        ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
        : {}),
    });
  });

export const embeddingsRouter = {
  settings: { get, put, delete: remove },
  reindex,
};
