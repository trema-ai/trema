import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  CredentialDecryptionError,
  CredentialEncryptionConfigError,
} from "#server/lib/crypto/index.js";
import {
  CapabilityProviderNotFoundError,
  CapabilityValidationError,
  capabilityDriverKeys,
  capabilityDriverSummaries,
  capabilityKeys,
  deleteCapabilityProvider,
  listCapabilityProviders,
  listCapabilityRoutes,
  putCapabilityProvider,
  putCapabilityRoute,
} from "#server/services/capabilities/index.js";
import { requireCapability } from "./builders.js";

const capabilityKeySchema = z.enum(capabilityKeys);
const driverKeySchema = z.enum(capabilityDriverKeys);

const settingsSchema = z.record(z.string(), z.unknown());

const driverSchema = z.object({
  key: driverKeySchema.describe("The adapter's stable key."),
  label: z.string().describe("The adapter name shown to administrators."),
  capabilities: z
    .array(capabilityKeySchema)
    .describe("The native capabilities this adapter provides."),
  credentialRequired: z.boolean().describe("Whether the adapter needs a stored credential."),
  defaultSettings: settingsSchema.describe("The settings a new provider starts with."),
});

const providerSchema = z.object({
  name: z.string().describe("The stable name capability routes reference."),
  label: z.string().describe("The provider name shown to administrators."),
  driverKey: driverKeySchema,
  capabilities: z.array(capabilityKeySchema),
  hasCredential: z
    .boolean()
    .describe("Whether a credential is stored. The credential itself is never returned."),
  settings: settingsSchema,
  updatedAt: z.string().describe("When the provider last changed. An ISO 8601 date-time."),
});

const routeSchema = z.object({
  capabilityKey: capabilityKeySchema,
  chain: z
    .array(z.string())
    .describe("Provider names in resolution order. Later entries are fallbacks."),
  updatedAt: z.string().describe("When the route last changed. An ISO 8601 date-time."),
});

function renderProvider(provider: Awaited<ReturnType<typeof putCapabilityProvider>>) {
  return { ...provider, updatedAt: provider.updatedAt.toISOString() };
}

function renderRoute(route: NonNullable<Awaited<ReturnType<typeof putCapabilityRoute>>>) {
  return { ...route, updatedAt: route.updatedAt.toISOString() };
}

function throwCapabilityError(error: unknown): never {
  if (error instanceof CapabilityProviderNotFoundError) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof CapabilityValidationError) {
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

const listDrivers = requireCapability("manage_capabilities")
  .route({
    method: "GET",
    path: "/capability-drivers",
    summary: "List capability drivers",
    description:
      "List the native capability adapters bundled with this deployment. The catalog contains no credentials.",
    tags: ["Capabilities"],
  })
  .output(z.array(driverSchema))
  .handler(() => capabilityDriverSummaries());

const listProviders = requireCapability("manage_capabilities")
  .route({
    method: "GET",
    path: "/capability-providers",
    summary: "List capability providers",
    description:
      "List the organization's configured native capability backends. Credentials are reported as status only.",
    tags: ["Capabilities"],
  })
  .output(z.array(providerSchema))
  .handler(async ({ context }) =>
    (await listCapabilityProviders(context.db, context.org.id)).map(renderProvider),
  );

const putProvider = requireCapability("manage_capabilities")
  .route({
    method: "PUT",
    path: "/capability-providers/{name}",
    summary: "Create or update a capability provider",
    description:
      "Create or replace one native capability backend. Omit the credential to keep its stored value; send null to clear it.",
    tags: ["Capabilities"],
  })
  .input(
    z.object({
      name: z.string().trim().min(1).describe("The provider's stable name."),
      label: z.string().trim().min(1).optional().describe("The provider's display name."),
      driverKey: driverKeySchema,
      settings: settingsSchema.optional(),
      credential: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .optional()
        .describe(
          "The provider credential. It is encrypted and never returned. Omit it to keep the stored value; send null to clear it.",
        ),
    }),
  )
  .output(providerSchema)
  .handler(async ({ context, input }) => {
    try {
      return renderProvider(
        await putCapabilityProvider(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          name: input.name,
          driverKey: input.driverKey,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.settings === undefined ? {} : { settings: input.settings }),
          ...(input.credential === undefined ? {} : { credential: input.credential }),
          ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
            ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
            : {}),
        }),
      );
    } catch (error) {
      throwCapabilityError(error);
    }
  });

const removeProvider = requireCapability("manage_capabilities")
  .route({
    method: "DELETE",
    path: "/capability-providers/{name}",
    summary: "Delete a capability provider",
    description:
      "Delete one native capability backend and remove it from every route that references it.",
    tags: ["Capabilities"],
  })
  .input(z.object({ name: z.string().trim().min(1) }))
  .output(z.object({ deleted: z.literal(true) }))
  .handler(async ({ context, input }) => {
    try {
      await deleteCapabilityProvider(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        name: input.name,
      });
      return { deleted: true as const };
    } catch (error) {
      throwCapabilityError(error);
    }
  });

const listRoutes = requireCapability("manage_capabilities")
  .route({
    method: "GET",
    path: "/capability-routes",
    summary: "List capability routes",
    description:
      "List the organization's enabled native capabilities and their ordered provider chains.",
    tags: ["Capabilities"],
  })
  .output(z.array(routeSchema))
  .handler(async ({ context }) =>
    (await listCapabilityRoutes(context.db, context.org.id)).map(renderRoute),
  );

const putRoute = requireCapability("manage_capabilities")
  .route({
    method: "PUT",
    path: "/capability-routes/{capabilityKey}",
    summary: "Set a capability route",
    description:
      "Set a native capability's ordered provider chain. An empty chain disables the capability.",
    tags: ["Capabilities"],
  })
  .input(
    z.object({
      capabilityKey: capabilityKeySchema,
      chain: z.array(z.string().trim().min(1)),
    }),
  )
  .output(routeSchema.nullable())
  .handler(async ({ context, input }) => {
    try {
      const route = await putCapabilityRoute(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        ...input,
      });
      return route === null ? null : renderRoute(route);
    } catch (error) {
      throwCapabilityError(error);
    }
  });

export const capabilitiesRouter = {
  drivers: { list: listDrivers },
  providers: { list: listProviders, put: putProvider, remove: removeProvider },
  routes: { list: listRoutes, put: putRoute },
};
