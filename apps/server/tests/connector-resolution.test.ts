import { randomUUID } from "node:crypto";

import { loadProviderCatalog } from "@trema/connectors";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Prisma, Role, ScopeKind } from "#server/generated/prisma/client.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import {
  ConnectorAccessDeniedError,
  ConnectorReconnectRequiredError,
  ConnectorToolNotAvailableError,
  resolveConnectorInstallations,
  resolveConnectorTool,
} from "#server/services/connectors/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const catalog = loadProviderCatalog();

integration("connector resolution", () => {
  const db = createPrismaClient(databaseUrl);

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function fixture(requesterRole: Role = "member") {
    const org = await db.org.create({ data: { name: `Resolution ${randomUUID()}` } });
    const [agent, requester, otherHuman] = await Promise.all([
      db.principal.create({
        data: { orgId: org.id, kind: "agent", displayName: "Resolution agent" },
      }),
      db.principal.create({
        data: { orgId: org.id, kind: "human", displayName: "Requester" },
      }),
      db.principal.create({
        data: { orgId: org.id, kind: "human", displayName: "Other human" },
      }),
    ]);
    const orgScope = await db.scope.create({
      data: { orgId: org.id, kind: "org", name: "Organization" },
    });
    const [sharedScope, personalScope] = await Promise.all([
      db.scope.create({ data: { orgId: org.id, kind: "shared", name: "Shared" } }),
      db.scope.create({
        data: {
          orgId: org.id,
          kind: "personal",
          name: "Requester",
          ownerId: requester.id,
        },
      }),
    ]);
    await db.grant.create({
      data: {
        orgId: org.id,
        principalId: requester.id,
        scopeId: orgScope.id,
        role: requesterRole,
      },
    });
    return { org, agent, requester, otherHuman, orgScope, sharedScope, personalScope };
  }

  async function install(input: {
    orgId: string;
    scopeId: string;
    createdById: string;
    ownerPrincipalId: string;
    providerKey: string;
    access?: Prisma.InputJsonObject;
    enabledTools?: "all" | string[];
    revokedAt?: Date;
  }) {
    const provider = catalog.find(({ key }) => key === input.providerKey);
    if (provider === undefined || provider.transport.type !== "rest") {
      throw new Error(`Test provider ${input.providerKey} is not a REST provider`);
    }
    const connection = await db.connectorConnection.create({
      data: {
        orgId: input.orgId,
        providerKey: provider.key,
        ownerPrincipalId: input.ownerPrincipalId,
        authMode: provider.authMode,
        config: {},
        ciphertext: "unused-by-resolution",
        ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
      },
    });
    const installation = await db.item.create({
      data: {
        orgId: input.orgId,
        scopeId: input.scopeId,
        kind: "connector",
        title: provider.displayName,
        body: {
          catalogKey: provider.key,
          connectionId: connection.id,
          access: input.access ?? { kind: "scope" },
          enabledTools: input.enabledTools ?? "all",
        },
        status: "active",
        disclosure: "retrieved",
        createdById: input.createdById,
      },
    });
    const toolName = provider.toolManifest[0]?.name;
    if (toolName === undefined) throw new Error(`Test provider ${provider.key} has no tools`);
    return { connection, installation, toolKey: `${provider.key}:${toolName}` };
  }

  function context(input: {
    fixture: Awaited<ReturnType<typeof fixture>>;
    scopeKind: ScopeKind;
    requesterPrincipalId?: string | null;
  }) {
    const { fixture: owner } = input;
    const scopeChain =
      input.scopeKind === "org"
        ? [owner.orgScope.id]
        : input.scopeKind === "shared"
          ? [owner.orgScope.id, owner.sharedScope.id]
          : [owner.orgScope.id, owner.personalScope.id];
    return {
      orgId: owner.org.id,
      scopeChain,
      scopeKind: input.scopeKind,
      requesterPrincipalId:
        input.requesterPrincipalId === undefined ? owner.requester.id : input.requesterPrincipalId,
    };
  }

  it.each([
    {
      name: "human user OAuth in the owner's personal scope",
      scopeKind: "personal" as const,
      providerKey: "google_workspace",
      installationScope: "personal" as const,
      owner: "human" as const,
      allowed: true,
    },
    {
      name: "agent-owned user OAuth in a shared session",
      scopeKind: "shared" as const,
      providerKey: "google_workspace",
      installationScope: "shared" as const,
      owner: "agent" as const,
      allowed: true,
    },
    {
      name: "agent-owned user OAuth in a personal session",
      scopeKind: "personal" as const,
      providerKey: "google_workspace",
      installationScope: "org" as const,
      owner: "agent" as const,
      allowed: false,
    },
    {
      name: "agent-owned app OAuth inherited into a personal session",
      scopeKind: "personal" as const,
      providerKey: "slack",
      installationScope: "org" as const,
      owner: "agent" as const,
      allowed: true,
    },
    {
      name: "agent-owned static credential inherited into a personal session",
      scopeKind: "personal" as const,
      providerKey: "stripe",
      installationScope: "org" as const,
      owner: "agent" as const,
      allowed: true,
    },
    {
      name: "human-owned credential in a shared session",
      scopeKind: "shared" as const,
      providerKey: "google_workspace",
      installationScope: "shared" as const,
      owner: "human" as const,
      allowed: false,
    },
  ])("$name", async ({ scopeKind, providerKey, installationScope, owner, allowed }) => {
    const setup = await fixture();
    const scopeId =
      installationScope === "org"
        ? setup.orgScope.id
        : installationScope === "shared"
          ? setup.sharedScope.id
          : setup.personalScope.id;
    const installed = await install({
      orgId: setup.org.id,
      scopeId,
      createdById: setup.agent.id,
      ownerPrincipalId: owner === "agent" ? setup.agent.id : setup.requester.id,
      providerKey,
    });
    const resolution = resolveConnectorTool(db, {
      ...context({ fixture: setup, scopeKind }),
      toolKey: installed.toolKey,
    });
    if (allowed) {
      await expect(resolution).resolves.toMatchObject({
        installationItemId: installed.installation.id,
        connectionId: installed.connection.id,
      });
    } else {
      await expect(resolution).rejects.toBeInstanceOf(ConnectorAccessDeniedError);
    }
  });

  it("applies minimum roles at the installation scope, including from a personal chat", async () => {
    const member = await fixture("member");
    const installed = await install({
      orgId: member.org.id,
      scopeId: member.orgScope.id,
      createdById: member.agent.id,
      ownerPrincipalId: member.agent.id,
      providerKey: "stripe",
      access: { kind: "minimum_role", role: "admin" },
    });
    const personalContext = context({ fixture: member, scopeKind: "personal" });
    await expect(
      resolveConnectorTool(db, { ...personalContext, toolKey: installed.toolKey }),
    ).rejects.toMatchObject({ reason: "minimum_role_required" });
    await expect(
      resolveConnectorTool(db, {
        ...personalContext,
        requesterPrincipalId: null,
        toolKey: installed.toolKey,
      }),
    ).rejects.toMatchObject({ reason: "requester_unlinked" });

    await db.grant.update({
      where: {
        orgId_principalId_scopeId: {
          orgId: member.org.id,
          principalId: member.requester.id,
          scopeId: member.orgScope.id,
        },
      },
      data: { role: "admin" },
    });
    await expect(
      resolveConnectorTool(db, { ...personalContext, toolKey: installed.toolKey }),
    ).resolves.toMatchObject({ installationScopeId: member.orgScope.id });
  });

  it("keeps scope-wide access available to unrequested shared and automation sessions", async () => {
    const setup = await fixture();
    const installed = await install({
      orgId: setup.org.id,
      scopeId: setup.orgScope.id,
      createdById: setup.agent.id,
      ownerPrincipalId: setup.agent.id,
      providerKey: "stripe",
    });
    await expect(
      resolveConnectorTool(db, {
        ...context({ fixture: setup, scopeKind: "shared", requesterPrincipalId: null }),
        toolKey: installed.toolKey,
      }),
    ).resolves.toMatchObject({ installationItemId: installed.installation.id });
  });

  it("never falls back after a narrower installation is denied, disabled, or revoked", async () => {
    for (const narrow of ["denied", "disabled", "revoked"] as const) {
      await db.$executeRaw`TRUNCATE TABLE "Org" CASCADE`;
      const setup = await fixture();
      await install({
        orgId: setup.org.id,
        scopeId: setup.orgScope.id,
        createdById: setup.agent.id,
        ownerPrincipalId: setup.agent.id,
        providerKey: "stripe",
      });
      const narrowInstalled = await install({
        orgId: setup.org.id,
        scopeId: setup.sharedScope.id,
        createdById: setup.agent.id,
        ownerPrincipalId: narrow === "denied" ? setup.otherHuman.id : setup.agent.id,
        providerKey: "stripe",
        ...(narrow === "disabled" ? { enabledTools: [] } : {}),
        ...(narrow === "revoked" ? { revokedAt: new Date() } : {}),
      });
      const resolution = resolveConnectorTool(db, {
        ...context({ fixture: setup, scopeKind: "shared" }),
        toolKey: narrowInstalled.toolKey,
      });
      if (narrow === "denied") {
        await expect(resolution).rejects.toBeInstanceOf(ConnectorAccessDeniedError);
      } else if (narrow === "disabled") {
        await expect(resolution).rejects.toBeInstanceOf(ConnectorToolNotAvailableError);
      } else {
        await expect(resolution).rejects.toBeInstanceOf(ConnectorReconnectRequiredError);
      }
    }
  });

  it("returns the same pinned binding to discovery and execution resolution", async () => {
    const setup = await fixture();
    const installed = await install({
      orgId: setup.org.id,
      scopeId: setup.sharedScope.id,
      createdById: setup.agent.id,
      ownerPrincipalId: setup.agent.id,
      providerKey: "stripe",
    });
    const resolutionContext = context({ fixture: setup, scopeKind: "shared" });
    const [discovered, executable] = await Promise.all([
      resolveConnectorInstallations(db, resolutionContext),
      resolveConnectorTool(db, { ...resolutionContext, toolKey: installed.toolKey }),
    ]);
    expect(discovered).toEqual([
      expect.objectContaining({
        installationItemId: installed.installation.id,
        connectionId: installed.connection.id,
      }),
    ]);
    expect(executable).toMatchObject({
      installationItemId: discovered[0]?.installationItemId,
      connectionId: discovered[0]?.connectionId,
    });
  });
});
