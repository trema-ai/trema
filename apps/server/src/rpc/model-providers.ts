import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  CredentialDecryptionError,
  CredentialEncryptionConfigError,
} from "#server/lib/crypto/index.js";
import { requireCapability } from "#server/rpc/builders.js";
import {
  deleteDefault,
  deleteProvider,
  getProvider,
  listDefaults,
  listProviders,
  ModelProviderAlreadyExistsError,
  ModelProviderNotFoundError,
  ModelProviderValidationError,
  putDefaults,
  putProvider,
} from "#server/services/model-providers/index.js";
import {
  importProviderCatalog,
  refreshProviderCatalog,
} from "#server/services/model-providers/catalog.js";
import { listPresets } from "#server/services/model-providers/presets.js";
import { fetchRemoteModels, probeProvider } from "#server/services/model-providers/remote.js";

const protocolSchema = z
  .enum(["openai_compatible"])
  .describe(
    "The wire protocol the provider speaks. One value per protocol, not per vendor: a vendor is a preset over a protocol.",
  );

const credentialModeSchema = z
  .enum(["api_key", "none"])
  .describe(
    "How the provider authenticates. `none` is for endpoints that need no credential, such as a model server on the same host.",
  );

const roleSchema = z
  .enum(["turns", "utility", "embed"])
  .describe(
    "What the model is asked to do: `turns` runs the agent loop, `utility` serves satellite completions, `embed` produces vectors.",
  );

const catalogEntrySchema = z.object({
  id: z.string().trim().min(1).describe("The model id the provider expects."),
  label: z.string().trim().min(1).optional().describe("What the admin screen shows."),
  roles: z
    .array(roleSchema)
    .optional()
    .describe("The roles this model may serve. Omitted means unrestricted."),
  contextWindow: z.number().int().positive().optional().describe("Context window, in tokens."),
});

const listQuerySchema = z
  .record(z.string(), z.string())
  .describe(
    "Query parameters sent with the call that reads this provider's model list, and with nothing else. A provider whose listing filters its own catalog needs one — OpenRouter answers with no embedding models until the call asks for every output modality — and a preset seeds it so an admin never types it. It is read back in full, so a token belongs in the credential or a header instead.",
  );

const providerSchema = z
  .object({
    name: z.string().describe("The key role defaults reference. Unique within the organization."),
    label: z.string().describe("The provider's display name."),
    protocol: protocolSchema,
    baseUrl: z.string().describe("The base endpoint address, including the version path."),
    headerNames: z
      .array(z.string())
      .describe(
        "Which extra headers are sent with every request to this provider. The values are never returned: a header can hold a token, so it gets the credential's write-only treatment.",
      ),
    credentialMode: credentialModeSchema,
    hasCredential: z
      .boolean()
      .describe(
        "Whether a credential is stored for this provider. The credential itself is never returned.",
      ),
    catalog: z
      .array(catalogEntrySchema)
      .describe(
        "The models this provider offers, as of the last time it was asked. It is written by a refresh rather than curated model by model: the provider's own listing is the menu, and the stored entry carries what the admin said about a model on top of it.",
      ),
    listQuery: listQuerySchema,
    updatedAt: z.string().describe("When the provider last changed. An ISO 8601 date-time."),
  })
  .describe("One provider in the registry. The credential is write-only.");

const chainEntrySchema = z.object({
  providerName: z.string().trim().min(1).describe("The provider that serves this model."),
  modelId: z.string().trim().min(1).describe("The model id to ask that provider for."),
});

const roleDefaultSchema = z
  .object({
    role: roleSchema,
    chain: z
      .array(chainEntrySchema)
      .describe("The ordered fallback chain. The first entry whose provider still exists is used."),
  })
  .describe("The model one role resolves to.");

function throwModelProviderError(error: unknown): never {
  if (error instanceof ModelProviderNotFoundError) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof ModelProviderValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof ModelProviderAlreadyExistsError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof CredentialEncryptionConfigError) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "The server has no credential master key, so it cannot store a provider credential",
    });
  }
  if (error instanceof CredentialDecryptionError) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message:
        "The stored credential cannot be decrypted; check the server's credential master key",
    });
  }
  throw error;
}

function renderProvider(provider: Awaited<ReturnType<typeof getProvider>>) {
  return { ...provider, updatedAt: provider.updatedAt.toISOString() };
}

const list = requireCapability("manage_models")
  .route({
    method: "GET",
    path: "/model-providers",
    summary: "List the model providers",
    description:
      "Read the organization's model provider registry. Stored credentials are reported as status only; their values are never returned.",
    tags: ["Model providers"],
  })
  .output(z.array(providerSchema).describe("Every provider, by name."))
  .handler(async ({ context }) => {
    const providers = await listProviders(context.db, context.org.id);
    return providers.map(renderProvider);
  });

const get = requireCapability("manage_models")
  .route({
    method: "GET",
    path: "/model-providers/{name}",
    summary: "Get one model provider",
    description: "Read a single provider's descriptor, credential status, and model catalog.",
    tags: ["Model providers"],
  })
  .input(z.object({ name: z.string().trim().min(1).describe("The provider's name.") }))
  .output(providerSchema)
  .handler(async ({ context, input }) => {
    try {
      return renderProvider(await getProvider(context.db, context.org.id, input.name));
    } catch (error) {
      throwModelProviderError(error);
    }
  });

const providerWriteSchema = z
  .object({
    name: z.string().trim().min(1).describe("The provider's name."),
    label: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("The provider's display name. Defaults to its name."),
    protocol: protocolSchema,
    baseUrl: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The base endpoint address, including the version path, such as `https://api.openai.com/v1`. Request paths are appended to it, so it carries no query string or fragment, and a trailing slash is dropped.",
      ),
    headers: z
      .record(z.string(), z.string())
      .nullable()
      .optional()
      .describe(
        "Extra headers sent with every request, stored and never returned. Omit to keep the stored headers; send null to clear them.",
      ),
    credentialMode: credentialModeSchema.optional(),
    credential: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "The credential, stored encrypted and never returned. Omit to keep the stored value; send null to clear it.",
      ),
    catalog: z
      .array(catalogEntrySchema)
      .nullable()
      .optional()
      .describe(
        "The models this provider offers. Omit to keep the stored catalog; send null to clear it.",
      ),
    listQuery: z
      .record(z.string(), z.string())
      .nullable()
      .optional()
      .describe(
        "Query parameters for the model-listing call, as the provider's preset supplies them. Omit to keep the stored query; send null to clear it.",
      ),
  })
  .describe("The provider to store.");

/** The service call both writes make. They differ only in what an existing name means. */
type ProviderWrite = z.infer<typeof providerWriteSchema>;

function writeInput(
  context: { org: { id: string }; env: { TREMA_CREDENTIAL_MASTER_KEY?: string | undefined } },
  input: ProviderWrite,
) {
  return {
    orgId: context.org.id,
    name: input.name,
    ...(input.label === undefined ? {} : { label: input.label }),
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.credentialMode === undefined ? {} : { credentialMode: input.credentialMode }),
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
    ...(input.listQuery === undefined ? {} : { listQuery: input.listQuery }),
    ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
      ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
      : {}),
  };
}

const create = requireCapability("manage_models")
  .route({
    method: "POST",
    path: "/model-providers",
    summary: "Create a model provider",
    description:
      "Store a provider under a name no other provider holds. A name already in the registry is refused rather than replaced, so two admins adding the same provider at once cannot overwrite each other's credential. The provider is asked for its model list on the way out, so the catalog comes back populated; a listing that fails leaves it empty rather than failing the create.",
    tags: ["Model providers"],
  })
  .input(providerWriteSchema)
  .output(providerSchema)
  .handler(async ({ context, input }) => {
    try {
      await putProvider(context.db, { ...writeInput(context, input), onExisting: "reject" });
      await importProviderCatalog(context.db, context.org.id, input.name, {
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
      });
      return renderProvider(await getProvider(context.db, context.org.id, input.name));
    } catch (error) {
      throwModelProviderError(error);
    }
  });

const put = requireCapability("manage_models")
  .route({
    method: "PUT",
    path: "/model-providers/{name}",
    summary: "Create or replace a model provider",
    description:
      "Store a provider descriptor and its credential, replacing one stored under the same name. The credential is write-only: omit it to keep the stored value, send null to clear it.",
    tags: ["Model providers"],
  })
  .input(providerWriteSchema)
  .output(providerSchema)
  .handler(async ({ context, input }) => {
    try {
      await putProvider(context.db, writeInput(context, input));
      return renderProvider(await getProvider(context.db, context.org.id, input.name));
    } catch (error) {
      throwModelProviderError(error);
    }
  });

const remove = requireCapability("manage_models")
  .route({
    method: "DELETE",
    path: "/model-providers/{name}",
    summary: "Delete a model provider",
    description:
      "Remove a provider and its stored credential. Role defaults that name it keep their remaining fallback entries.",
    tags: ["Model providers"],
  })
  .input(z.object({ name: z.string().trim().min(1).describe("The provider's name.") }))
  .output(z.object({ deleted: z.literal(true) }).describe("The provider was removed."))
  .handler(async ({ context, input }) => {
    try {
      await deleteProvider(context.db, context.org.id, input.name);
      return { deleted: true as const };
    } catch (error) {
      throwModelProviderError(error);
    }
  });

const listRoleDefaults = requireCapability("manage_models")
  .route({
    method: "GET",
    path: "/model-defaults",
    summary: "List the role defaults",
    description: "Read which provider and model each role resolves to, with its fallback chain.",
    tags: ["Model providers"],
  })
  .output(z.array(roleDefaultSchema).describe("Every configured role default."))
  .handler(async ({ context }) => listDefaults(context.db, context.org.id));

const putRoleDefault = requireCapability("manage_models")
  .route({
    method: "PUT",
    path: "/model-defaults/{role}",
    summary: "Set a role default",
    description:
      "Assign one role its ordered fallback chain. Every named provider must already exist.",
    tags: ["Model providers"],
  })
  .input(
    z
      .object({
        role: roleSchema,
        chain: z
          .array(chainEntrySchema)
          .min(1)
          .describe("The ordered fallback chain, most preferred first."),
      })
      .describe("The role default to store."),
  )
  .output(roleDefaultSchema)
  .handler(async ({ context, input }) => {
    try {
      await putDefaults(context.db, {
        orgId: context.org.id,
        role: input.role,
        chain: input.chain,
      });
      return { role: input.role, chain: input.chain };
    } catch (error) {
      throwModelProviderError(error);
    }
  });

const removeRoleDefault = requireCapability("manage_models")
  .route({
    method: "DELETE",
    path: "/model-defaults/{role}",
    summary: "Delete a role default",
    description:
      "Leave a role unconfigured. Each consumer degrades on its own terms: turns cannot run, embeddings fall back to lexical search.",
    tags: ["Model providers"],
  })
  .input(z.object({ role: roleSchema }))
  .output(z.object({ deleted: z.literal(true) }).describe("The role default was removed."))
  .handler(async ({ context, input }) => {
    try {
      await deleteDefault(context.db, context.org.id, input.role);
      return { deleted: true as const };
    } catch (error) {
      throwModelProviderError(error);
    }
  });

const presetSchema = z
  .object({
    name: z
      .string()
      .describe("The provider name this preset suggests. An admin may store it under another."),
    label: z.string().describe("The vendor's display name."),
    protocol: protocolSchema,
    baseUrl: z.string().describe("The vendor's base endpoint address."),
    credentialMode: credentialModeSchema,
    icon: z
      .string()
      .optional()
      .describe("Which bundled brand mark the screen draws for this vendor."),
    listQuery: listQuerySchema.optional(),
  })
  .describe(
    "A bundled provider, ready to store as a registry row. A vendor is a preset over a protocol, never code. It carries no model list: a provider is asked what it serves.",
  );

const listProviderPresets = requireCapability("manage_models")
  .route({
    method: "GET",
    path: "/model-provider-presets",
    summary: "List the bundled provider presets",
    description:
      "Read the presets a provider can be created from. A preset carries a base URL and a credential mode, both editable once the provider exists; the models come from the provider itself.",
    tags: ["Model providers"],
  })
  .output(z.array(presetSchema).describe("Every bundled preset."))
  .handler(() => listPresets());

const probeSchema = z
  .discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      latencyMs: z
        .number()
        .int()
        .nonnegative()
        .describe("How long the provider took to answer, in milliseconds."),
      modelCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("How many models the provider listed, when it listed any."),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.string().describe("What went wrong, in a sentence an admin can act on."),
    }),
  ])
  .describe("What the probe found. A failed probe is a result, not an error.");

const probe = requireCapability("manage_models")
  .route({
    method: "POST",
    path: "/model-providers/{name}/probe",
    summary: "Probe a model provider",
    description:
      "Ask the provider whether it is reachable and whether its credential still works, with one cheap authenticated call. It runs on demand only: providers rate-limit, so nothing polls this in the background.",
    tags: ["Model providers"],
  })
  .input(z.object({ name: z.string().trim().min(1).describe("The provider's name.") }))
  .output(probeSchema)
  .handler(async ({ context, input }) => {
    try {
      return await probeProvider(context.db, context.org.id, input.name, {
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
      });
    } catch (error) {
      throwModelProviderError(error);
    }
  });

const remoteModelsSchema = z
  .discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      latencyMs: z
        .number()
        .int()
        .nonnegative()
        .describe("How long the provider took to answer, in milliseconds."),
      models: z
        .array(
          z.object({
            id: z.string().describe("The model id the provider expects."),
            embedding: z
              .boolean()
              .optional()
              .describe(
                "Whether the provider's own listing said this model answers with vectors. It is absent when the listing said nothing, which is the common case: the OpenAI-compatible listing shape carries no capability field, so a client that needs the answer there has to guess from the model's name.",
              ),
          }),
        )
        .describe("Every model the provider listed, by id."),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.string().describe("What went wrong, in a sentence an admin can act on."),
    }),
  ])
  .describe(
    "What the provider offers right now. A provider that cannot be reached is a result, not an error: the stored catalog is still editable by hand.",
  );

const remoteModels = requireCapability("manage_models")
  .route({
    method: "GET",
    path: "/model-providers/{name}/remote-models",
    summary: "List the models a provider offers",
    description:
      "Ask the provider itself which models it serves, using the stored credential. The answer carries the capability each listing states about its own models where it states one. It stores nothing: writing the answer into the provider's catalog is what a catalog refresh does.",
    tags: ["Model providers"],
  })
  .input(z.object({ name: z.string().trim().min(1).describe("The provider's name.") }))
  .output(remoteModelsSchema)
  .handler(async ({ context, input }) => {
    try {
      return await fetchRemoteModels(context.db, context.org.id, input.name, {
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
      });
    } catch (error) {
      throwModelProviderError(error);
    }
  });

const catalogRefreshSchema = z
  .discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      latencyMs: z
        .number()
        .int()
        .nonnegative()
        .describe("How long the provider took to answer, in milliseconds."),
      added: z
        .number()
        .int()
        .nonnegative()
        .describe("How many models the listing brought that the catalog did not already hold."),
      removed: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "How many entries were dropped. Only entries nothing was said about go: one carrying a role, a label, a context window, or a role default that names it stays even after the provider stops listing it.",
        ),
      provider: providerSchema,
    }),
    z.object({
      ok: z.literal(false),
      reason: z.string().describe("What went wrong, in a sentence an admin can act on."),
    }),
  ])
  .describe(
    "What the refresh wrote. A provider that cannot be reached is a result, not an error: the stored catalog is left exactly as it was.",
  );

const refreshCatalog = requireCapability("manage_models")
  .route({
    method: "POST",
    path: "/model-providers/{name}/refresh-catalog",
    summary: "Refresh a provider's model catalog",
    description:
      "Ask the provider what it serves and store the answer as its catalog. The listing is the menu and the catalog is the annotations over it: an entry the admin gave a role, a label, or a context window keeps every one of them, and so does an entry a role default names, while an entry that only ever came from an earlier listing goes when the provider stops listing it. Roles on a newly imported model follow whatever the listing said about it, and its name where the listing said nothing.",
    tags: ["Model providers"],
  })
  .input(z.object({ name: z.string().trim().min(1).describe("The provider's name.") }))
  .output(catalogRefreshSchema)
  .handler(async ({ context, input }) => {
    try {
      const result = await refreshProviderCatalog(context.db, context.org.id, input.name, {
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
      });
      if (!result.ok) return result;
      return {
        ...result,
        provider: renderProvider(await getProvider(context.db, context.org.id, input.name)),
      };
    } catch (error) {
      throwModelProviderError(error);
    }
  });

export const modelProvidersRouter = {
  providers: { list, get, create, put, delete: remove, probe, remoteModels, refreshCatalog },
  defaults: { list: listRoleDefaults, put: putRoleDefault, delete: removeRoleDefault },
  presets: { list: listProviderPresets },
};
