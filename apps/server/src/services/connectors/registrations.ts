import { loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";
import type { ClientRegistrationSource } from "#server/generated/prisma/client.js";
import { decryptEnvelope, encryptEnvelope } from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";

const defaultCatalog = loadProviderCatalog();
type ClientRegistrationDatabase = Pick<Database, "clientRegistration">;

export interface PlatformApp {
  clientId: string;
  clientSecret: string;
  signingSecret?: string;
}

export interface PlatformAppDirectory {
  get(sharedRef: string): PlatformApp | undefined | Promise<PlatformApp | undefined>;
}

export const emptyPlatformAppDirectory: PlatformAppDirectory = {
  get: () => undefined,
};

export class ConnectorProviderNotFoundError extends Error {
  constructor(providerKey: string) {
    super(`Unknown connector provider: ${providerKey}`);
    this.name = "ConnectorProviderNotFoundError";
  }
}

export class ClientRegistrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRegistrationValidationError";
  }
}

export class ClientRegistrationNotFoundError extends Error {
  constructor() {
    super("Client registration not found");
    this.name = "ClientRegistrationNotFoundError";
  }
}

export class ClientRegistrationConflictError extends Error {
  constructor() {
    super("A client registration for this provider and source already exists");
    this.name = "ClientRegistrationConflictError";
  }
}

export class NoClientRegistrationError extends Error {
  readonly code = "no_registration";
  readonly providerKey: string;

  constructor(providerKey: string) {
    super(`No client registration is available for provider '${providerKey}'`);
    this.name = "NoClientRegistrationError";
    this.providerKey = providerKey;
  }
}

function assertProvider(catalog: ProviderCatalog, providerKey: string) {
  const provider = catalog.find(({ key }) => key === providerKey);
  if (!provider) throw new ConnectorProviderNotFoundError(providerKey);
  return provider;
}

export interface RegistrationFields {
  source: ClientRegistrationSource;
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
  sharedRef?: string;
}

export function validateRegistrationFields(input: RegistrationFields): void {
  if (input.source === "platform") {
    if (!input.sharedRef) {
      throw new ClientRegistrationValidationError("Platform registration requires sharedRef");
    }
    if (input.clientId || input.clientSecret || input.signingSecret) {
      throw new ClientRegistrationValidationError(
        "Platform registration cannot store client credentials",
      );
    }
    return;
  }

  if (!input.clientId || !input.clientSecret) {
    throw new ClientRegistrationValidationError(
      `${input.source} registration requires clientId and clientSecret`,
    );
  }
  if (input.sharedRef) {
    throw new ClientRegistrationValidationError(
      `${input.source} registration cannot use sharedRef`,
    );
  }
}

export interface CreateClientRegistrationInput extends RegistrationFields {
  orgId: string;
  providerKey: string;
  adminConsentGranted?: boolean;
  notes?: string;
  masterKey?: string;
  catalog?: ProviderCatalog;
  replace?: boolean;
}

const registrationMetadataSelect = {
  id: true,
  orgId: true,
  providerKey: true,
  source: true,
  clientId: true,
  sharedRef: true,
  adminConsentGranted: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function createClientRegistration(db: Database, input: CreateClientRegistrationInput) {
  assertProvider(input.catalog ?? defaultCatalog, input.providerKey);
  validateRegistrationFields(input);
  if (input.providerKey === "slack" && input.source !== "platform" && !input.signingSecret) {
    throw new ClientRegistrationValidationError("Slack registration requires a signing secret");
  }
  if (input.providerKey !== "slack" && input.signingSecret) {
    throw new ClientRegistrationValidationError(
      "Signing secrets are supported only for Slack registrations",
    );
  }

  const values = {
    clientId: input.clientId ?? null,
    clientSecretCiphertext: input.clientSecret
      ? encryptEnvelope(input.clientSecret, input.masterKey)
      : null,
    signingSecretCiphertext: input.signingSecret
      ? encryptEnvelope(input.signingSecret, input.masterKey)
      : null,
    sharedRef: input.sharedRef ?? null,
    adminConsentGranted: input.adminConsentGranted ?? null,
    notes: input.notes ?? null,
  };

  if (input.replace) {
    const registration = await db.clientRegistration.upsert({
      where: {
        orgId_providerKey_source: {
          orgId: input.orgId,
          providerKey: input.providerKey,
          source: input.source,
        },
      },
      create: {
        orgId: input.orgId,
        providerKey: input.providerKey,
        source: input.source,
        ...values,
      },
      update: values,
      select: registrationMetadataSelect,
    });
    log.info("Client registration replaced", { provider: input.providerKey, kind: input.source });
    return registration;
  }

  try {
    const registration = await db.clientRegistration.create({
      data: {
        orgId: input.orgId,
        providerKey: input.providerKey,
        source: input.source,
        ...values,
      },
      select: registrationMetadataSelect,
    });
    log.info("Client registration stored", { provider: input.providerKey, kind: input.source });
    return registration;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      log.warn("Client registration conflict", { provider: input.providerKey, kind: input.source });
      throw new ClientRegistrationConflictError();
    }
    throw error;
  }
}

export function listClientRegistrations(db: Database, orgId: string) {
  return db.clientRegistration.findMany({
    where: { orgId },
    select: registrationMetadataSelect,
    orderBy: [{ providerKey: "asc" }, { source: "asc" }],
  });
}

export async function deleteClientRegistration(db: Database, orgId: string, id: string) {
  const result = await db.clientRegistration.deleteMany({ where: { id, orgId } });
  if (result.count === 0) {
    log.warn("Client registration not found", { registrationId: id });
    throw new ClientRegistrationNotFoundError();
  }
  log.info("Client registration deleted", { registrationId: id });
  return { id };
}

export interface ResolvedClientRegistration {
  registrationId: string;
  source: ClientRegistrationSource;
  clientId: string;
  clientSecret: string;
  signingSecret?: string;
}

export async function resolveClientRegistration(
  db: ClientRegistrationDatabase,
  orgId: string,
  providerKey: string,
  platformApps: PlatformAppDirectory = emptyPlatformAppDirectory,
  masterKey?: string,
): Promise<ResolvedClientRegistration> {
  const registrations = await db.clientRegistration.findMany({
    where: { orgId, providerKey },
  });

  for (const source of ["customer", "dynamic"] as const) {
    const registration = registrations.find((candidate) => candidate.source === source);
    if (registration?.clientId && registration.clientSecretCiphertext) {
      return {
        registrationId: registration.id,
        source: registration.source,
        clientId: registration.clientId,
        clientSecret: decryptEnvelope<string>(registration.clientSecretCiphertext, masterKey),
        ...(registration.signingSecretCiphertext
          ? {
              signingSecret: decryptEnvelope<string>(
                registration.signingSecretCiphertext,
                masterKey,
              ),
            }
          : {}),
      };
    }
  }

  const platform = registrations.find((candidate) => candidate.source === "platform");
  if (platform?.sharedRef) {
    const app = await platformApps.get(platform.sharedRef);
    if (app) {
      return {
        registrationId: platform.id,
        source: platform.source,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        ...(app.signingSecret ? { signingSecret: app.signingSecret } : {}),
      };
    }
  }

  throw new NoClientRegistrationError(providerKey);
}

export async function resolveStoredClientRegistration(
  db: ClientRegistrationDatabase,
  orgId: string,
  registrationId: string,
  platformApps: PlatformAppDirectory = emptyPlatformAppDirectory,
  masterKey?: string,
): Promise<ResolvedClientRegistration> {
  const registration = await db.clientRegistration.findFirst({
    where: { id: registrationId, orgId },
  });
  if (!registration) throw new ClientRegistrationNotFoundError();

  if (registration.source === "platform") {
    const app = registration.sharedRef ? await platformApps.get(registration.sharedRef) : undefined;
    if (!app) throw new NoClientRegistrationError(registration.providerKey);
    return {
      registrationId: registration.id,
      source: registration.source,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      ...(app.signingSecret ? { signingSecret: app.signingSecret } : {}),
    };
  }

  if (!registration.clientId || !registration.clientSecretCiphertext) {
    throw new NoClientRegistrationError(registration.providerKey);
  }
  return {
    registrationId: registration.id,
    source: registration.source,
    clientId: registration.clientId,
    clientSecret: decryptEnvelope<string>(registration.clientSecretCiphertext, masterKey),
    ...(registration.signingSecretCiphertext
      ? {
          signingSecret: decryptEnvelope<string>(registration.signingSecretCiphertext, masterKey),
        }
      : {}),
  };
}
