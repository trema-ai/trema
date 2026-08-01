import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { Database } from "#server/lib/db/index.js";
import { authorize } from "#server/services/authorize/index.js";
import { BindingConflictError, BindingNotFoundError } from "#server/services/bindings/index.js";
import { ConnectorReconnectRequiredError } from "#server/services/connectors/index.js";
import {
  createSlackBinding,
  deleteSlackBinding,
  deleteSlackIdentityLink,
  listSlackBindings,
  listSlackIdentityLinks,
  listSlackInstallations,
  SLACK_EVENTS_PATH,
  SLACK_INTERACTIONS_PATH,
  SlackInstallationNotFoundError,
  SlackMessagingConflictError,
  SlackMessagingValidationError,
  SlackUninstallError,
  setSlackIdentityLink,
  slackAppManifest,
  startSlackInstallation,
  uninstallSlackInstallation,
} from "#server/services/messaging/index.js";
import { OrgAgentNotFoundError, requireOrgAgent } from "#server/services/org/index.js";
import { requireCapability } from "./builders.js";

function throwMessagingError(error: unknown): never {
  if (error instanceof SlackMessagingValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof SlackMessagingConflictError || error instanceof BindingConflictError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  if (
    error instanceof SlackInstallationNotFoundError ||
    error instanceof BindingNotFoundError ||
    error instanceof OrgAgentNotFoundError
  ) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof ConnectorReconnectRequiredError) {
    throw new ORPCError("PRECONDITION_FAILED", { message: error.message });
  }
  if (error instanceof SlackUninstallError) {
    throw new ORPCError("BAD_GATEWAY", { message: error.message });
  }
  throw error;
}

async function orgAgentPrincipalId(db: Database, orgId: string) {
  return (await requireOrgAgent(db, orgId)).id;
}

const installationSchema = z.object({
  id: z.uuid(),
  providerKey: z.literal("slack"),
  ownerPrincipalId: z.uuid(),
  label: z.string().nullable(),
  providerScopes: z.array(z.string()),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  enterpriseId: z.string().nullable(),
  enterpriseName: z.string().nullable(),
  botUserId: z.string().nullable(),
  appId: z.string().nullable(),
  installerUserId: z.string().nullable(),
  isEnterpriseInstall: z.boolean(),
  isRevoked: z.boolean(),
  isExpired: z.boolean(),
  isCredentialUnavailable: z.boolean(),
  isValid: z.boolean(),
  refreshExhausted: z.boolean(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  installations: z.array(z.object({ id: z.uuid(), scopeId: z.uuid() })),
});

const listInstallations = requireCapability("manage_connectors")
  .route({
    method: "GET",
    path: "/messaging/slack/installations",
    summary: "List Slack installations",
    description:
      "Inspect safe workspace and credential-health metadata for Slack installations without returning token material.",
    tags: ["Messaging"],
  })
  .output(z.array(installationSchema))
  .handler(async ({ context }) => {
    const rows = await listSlackInstallations(context.db, {
      orgId: context.org.id,
      ownerPrincipalId: await orgAgentPrincipalId(context.db, context.org.id),
      ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
        ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
        : {}),
    });
    return rows.map((row) => ({
      ...row,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  });

const startInstallation = requireCapability("manage_connectors", {
  scopeId: (input) => (input as { defaultScopeId?: string }).defaultScopeId,
})
  .route({
    method: "POST",
    path: "/messaging/slack/installations/oauth",
    summary: "Install or reauthorize Slack",
    description:
      "Start a single-use Slack OAuth flow owned by the organization agent. Pass an installation ID to reauthorize it.",
    tags: ["Messaging"],
  })
  .input(
    z.object({
      defaultScopeId: z.uuid(),
      installationId: z.uuid().optional(),
      returnTo: z.url().optional(),
    }),
  )
  .output(z.object({ authorizationUrl: z.url() }))
  .handler(async ({ context, input }) => {
    try {
      return await startSlackInstallation(context.db, {
        orgId: context.org.id,
        scopeId: input.defaultScopeId,
        ownerPrincipalId: await orgAgentPrincipalId(context.db, context.org.id),
        initiatedByPrincipalId: context.principal.id,
        authBaseUrl: context.env.TREMA_AUTH_BASE_URL,
        ...(input.installationId ? { reconnectConnectionId: input.installationId } : {}),
        ...(input.returnTo ? { returnTo: input.returnTo } : {}),
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(context.platformApps ? { platformApps: context.platformApps } : {}),
        ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
      });
    } catch (error) {
      throwMessagingError(error);
    }
  });

const uninstallInstallation = requireCapability("manage_connectors")
  .route({
    method: "POST",
    path: "/messaging/slack/installations/{installationId}/uninstall",
    summary: "Uninstall Slack",
    description:
      "Revoke the Slack authorization remotely, then mark the Trema installation revoked locally.",
    tags: ["Messaging"],
  })
  .input(z.object({ installationId: z.uuid() }))
  .output(z.object({ id: z.uuid(), revokedAt: z.string() }))
  .handler(async ({ context, input }) => {
    try {
      const result = await uninstallSlackInstallation(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        ownerPrincipalId: await orgAgentPrincipalId(context.db, context.org.id),
        connectionId: input.installationId,
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(context.platformApps ? { platformApps: context.platformApps } : {}),
        ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
      });
      return { id: result.id, revokedAt: result.revokedAt.toISOString() };
    } catch (error) {
      throwMessagingError(error);
    }
  });

const manifest = requireCapability("manage_connectors")
  .route({
    method: "GET",
    path: "/messaging/slack/manifest",
    summary: "Get the Slack app manifest",
    description:
      "Get a Slack app manifest with this deployment's OAuth, Events API, and interactivity URLs.",
    tags: ["Messaging"],
  })
  .output(
    z.object({
      manifest: z.json(),
      callbackUrl: z.url(),
      eventsUrl: z.url(),
      interactionsUrl: z.url(),
    }),
  )
  .handler(({ context }) => ({
    manifest: slackAppManifest(context.env.TREMA_AUTH_BASE_URL),
    callbackUrl: new URL("/connect/callback", context.env.TREMA_AUTH_BASE_URL).toString(),
    eventsUrl: new URL(SLACK_EVENTS_PATH, context.env.TREMA_AUTH_BASE_URL).toString(),
    interactionsUrl: new URL(SLACK_INTERACTIONS_PATH, context.env.TREMA_AUTH_BASE_URL).toString(),
  }));

const bindingSchema = z.object({
  id: z.uuid(),
  workspaceId: z.string(),
  channelId: z.string(),
  scopeId: z.uuid(),
  scopeName: z.string(),
  scopeKind: z.enum(["org", "shared"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listBindings = requireCapability("manage_scopes")
  .route({
    method: "GET",
    path: "/messaging/slack/bindings",
    summary: "List Slack conversation bindings",
    description: "List allowed Slack conversations and the Trema scopes they resolve to.",
    tags: ["Messaging"],
  })
  .output(z.array(bindingSchema))
  .handler(async ({ context }) =>
    (await listSlackBindings(context.db, context.org.id)).map((binding) => ({
      id: binding.id,
      workspaceId: binding.workspaceId,
      channelId: binding.channelId,
      scopeId: binding.scopeId,
      scopeName: binding.scope.name,
      scopeKind: binding.scope.kind as "org" | "shared",
      createdAt: binding.createdAt.toISOString(),
      updatedAt: binding.updatedAt.toISOString(),
    })),
  );

const createBinding = requireCapability("manage_connectors", {
  scopeId: (input) => (input as { scopeId?: string }).scopeId,
})
  .route({
    method: "POST",
    path: "/messaging/slack/bindings",
    summary: "Allow a Slack conversation",
    description:
      "Bind one Slack channel or direct-message conversation to an organization or shared scope.",
    tags: ["Messaging"],
  })
  .input(
    z.object({
      installationId: z.uuid(),
      workspaceId: z.string().trim().min(1),
      channelId: z.string().trim().min(1),
      scopeId: z.uuid(),
    }),
  )
  .output(bindingSchema)
  .handler(async ({ context, input }) => {
    if (!(await authorize(context.principal, "manage_scopes", input.scopeId, context.db))) {
      throw new ORPCError("FORBIDDEN", { message: "Capability required: manage_scopes" });
    }
    try {
      const binding = await createSlackBinding(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        connectionId: input.installationId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        scopeId: input.scopeId,
      });
      const scope = await context.db.scope.findUniqueOrThrow({
        where: { orgId_id: { orgId: context.org.id, id: binding.scopeId } },
        select: { name: true, kind: true },
      });
      return {
        id: binding.id,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        scopeId: binding.scopeId,
        scopeName: scope.name,
        scopeKind: scope.kind as "org" | "shared",
        createdAt: binding.createdAt.toISOString(),
        updatedAt: binding.updatedAt.toISOString(),
      };
    } catch (error) {
      throwMessagingError(error);
    }
  });

const removeBinding = requireCapability("manage_scopes")
  .route({
    method: "DELETE",
    path: "/messaging/slack/bindings/{bindingId}",
    summary: "Remove a Slack conversation binding",
    description: "Stop one Slack conversation from resolving to a Trema scope.",
    tags: ["Messaging"],
  })
  .input(z.object({ bindingId: z.uuid() }))
  .output(z.object({ id: z.uuid() }))
  .handler(async ({ context, input }) => {
    try {
      const binding = await deleteSlackBinding(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        bindingId: input.bindingId,
      });
      return { id: binding.id };
    } catch (error) {
      throwMessagingError(error);
    }
  });

const identitySchema = z.object({
  id: z.uuid(),
  workspaceId: z.string(),
  userId: z.string(),
  principalId: z.uuid(),
  principalName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listIdentities = requireCapability("manage_members")
  .route({
    method: "GET",
    path: "/messaging/slack/identities",
    summary: "List Slack identity links",
    description: "List Slack users linked to active Trema members.",
    tags: ["Messaging"],
  })
  .output(z.array(identitySchema))
  .handler(async ({ context }) =>
    (await listSlackIdentityLinks(context.db, context.org.id)).map((link) => ({
      id: link.id,
      workspaceId: link.workspaceId,
      userId: link.userId,
      principalId: link.principalId,
      principalName: link.principal.displayName,
      createdAt: link.createdAt.toISOString(),
      updatedAt: link.updatedAt.toISOString(),
    })),
  );

const setIdentity = requireCapability("manage_members")
  .route({
    method: "PUT",
    path: "/messaging/slack/identities",
    summary: "Link a Slack user",
    description: "Link a workspace-scoped Slack user ID to an active Trema member.",
    tags: ["Messaging"],
  })
  .input(
    z.object({
      workspaceId: z.string().trim().min(1),
      userId: z.string().trim().min(1),
      principalId: z.uuid(),
    }),
  )
  .output(z.object({ id: z.uuid() }))
  .handler(async ({ context, input }) => {
    try {
      const link = await setSlackIdentityLink(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        ...input,
      });
      return { id: link.id };
    } catch (error) {
      throwMessagingError(error);
    }
  });

const removeIdentity = requireCapability("manage_members")
  .route({
    method: "DELETE",
    path: "/messaging/slack/identities/{identityLinkId}",
    summary: "Unlink a Slack user",
    description: "Remove one Slack-to-Trema requester identity link.",
    tags: ["Messaging"],
  })
  .input(z.object({ identityLinkId: z.uuid() }))
  .output(z.object({ id: z.uuid() }))
  .handler(async ({ context, input }) => {
    try {
      const link = await deleteSlackIdentityLink(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        identityLinkId: input.identityLinkId,
      });
      return { id: link.id };
    } catch (error) {
      throwMessagingError(error);
    }
  });

export const messagingRouter = {
  slack: {
    manifest,
    installations: {
      list: listInstallations,
      start: startInstallation,
      uninstall: uninstallInstallation,
    },
    bindings: { list: listBindings, create: createBinding, remove: removeBinding },
    identities: { list: listIdentities, set: setIdentity, remove: removeIdentity },
  },
};
