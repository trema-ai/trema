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
  ModelProviderNotFoundError,
  ModelProviderValidationError,
  putDefaults,
  putProvider,
} from "#server/services/model-providers/index.js";

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
    catalog: z.array(catalogEntrySchema).describe("The models this provider offers."),
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

const put = requireCapability("manage_models")
  .route({
    method: "PUT",
    path: "/model-providers/{name}",
    summary: "Create or replace a model provider",
    description:
      "Store a provider descriptor and its credential. The credential is write-only: omit it to keep the stored value, send null to clear it.",
    tags: ["Model providers"],
  })
  .input(
    z
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
            "The base endpoint address, including the version path, such as `https://api.openai.com/v1`.",
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
      })
      .describe("The provider to store."),
  )
  .output(providerSchema)
  .handler(async ({ context, input }) => {
    try {
      await putProvider(context.db, {
        orgId: context.org.id,
        name: input.name,
        ...(input.label === undefined ? {} : { label: input.label }),
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.credentialMode === undefined ? {} : { credentialMode: input.credentialMode }),
        ...(input.credential === undefined ? {} : { credential: input.credential }),
        ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
      });
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

export const modelProvidersRouter = {
  providers: { list, get, put, delete: remove },
  defaults: { list: listRoleDefaults, put: putRoleDefault, delete: removeRoleDefault },
};
