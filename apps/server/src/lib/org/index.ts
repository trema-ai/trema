import type { Prisma } from "../../generated/prisma/client.js";
import type { Database } from "../db/index.js";

export interface OrgOwner {
  authId: string;
  displayName: string;
  email: string;
}

export interface CreateOrgWithOwnerInput {
  name: string;
  owner: OrgOwner;
}

export interface CreateOrgWithOwnerHooks {
  beforeCreate?: (transaction: Prisma.TransactionClient) => Promise<void>;
  afterCreate?: (
    transaction: Prisma.TransactionClient,
    result: CreateOrgWithOwnerResult,
  ) => Promise<void>;
}

export interface CreateOrgWithOwnerResult {
  org: Awaited<ReturnType<Prisma.TransactionClient["org"]["create"]>>;
  ownerPrincipal: Awaited<
    ReturnType<Prisma.TransactionClient["principal"]["create"]>
  >;
}

export async function createOrgWithOwner(
  db: Database,
  input: CreateOrgWithOwnerInput,
  hooks: CreateOrgWithOwnerHooks = {},
): Promise<CreateOrgWithOwnerResult> {
  return db.$transaction(async (transaction) => {
    await hooks.beforeCreate?.(transaction);

    const org = await transaction.org.create({
      data: { name: input.name },
    });
    const orgScope = await transaction.scope.create({
      data: {
        orgId: org.id,
        kind: "org",
        name: input.name,
      },
    });
    const ownerPrincipal = await transaction.principal.create({
      data: {
        orgId: org.id,
        kind: "human",
        displayName: input.owner.displayName,
        authId: input.owner.authId,
        email: input.owner.email,
      },
    });
    await transaction.grant.create({
      data: {
        orgId: org.id,
        principalId: ownerPrincipal.id,
        role: "owner",
        scopeId: orgScope.id,
      },
    });
    await transaction.principal.create({
      data: {
        orgId: org.id,
        kind: "agent",
        displayName: "Trema Agent",
      },
    });

    const result = { org, ownerPrincipal };
    await hooks.afterCreate?.(transaction, result);
    return result;
  });
}
