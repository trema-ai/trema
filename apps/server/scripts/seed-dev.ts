import { createAuth } from "../src/lib/auth/index.js";
import { createPrismaClient } from "../src/lib/db/index.js";
import { env } from "../src/lib/env/index.js";

// Seed a local development database with an organization and three
// sign-in-able accounts, one per role worth testing. Never run in production.
const PASSWORD = "trema-dev-password";
const ORG_NAME = "Trema Dev";
const accounts = [
  { name: "Ava Owner", email: "owner@example.com", role: "owner" },
  { name: "Ada Admin", email: "admin@example.com", role: "admin" },
  { name: "Max Member", email: "member@example.com", role: "member" },
] as const;

if (env.NODE_ENV === "production") {
  throw new Error("Refusing to seed a production database");
}

const db = createPrismaClient(env.DATABASE_URL);
const auth = createAuth({ db, env });

const existing = await db.user.findFirst({
  where: { email: { in: accounts.map((account) => account.email) } },
});
if (existing) {
  throw new Error(`Seed account ${existing.email} already exists — refusing to reseed`);
}

for (const account of accounts) {
  const response = await auth.api.signUpEmail({
    body: { name: account.name, email: account.email, password: PASSWORD },
    asResponse: true,
  });
  if (!response.ok) {
    throw new Error(`Sign-up failed for ${account.email}: ${await response.text()}`);
  }
}

const users = new Map(
  (
    await db.user.findMany({ where: { email: { in: accounts.map((account) => account.email) } } })
  ).map((user) => [user.email, user]),
);

const [owner, ...rest] = accounts;
const ownerUser = users.get(owner.email);
if (!ownerUser) throw new Error("Owner user missing after sign-up");

const { createOrgWithOwner } = await import("../src/services/org/index.js");
const { ensurePersonalScope } = await import("../src/services/scopes/index.js");
const { org } = await createOrgWithOwner(db, {
  name: ORG_NAME,
  owner: { authId: ownerUser.id, displayName: owner.name, email: owner.email },
});
const orgScope = await db.scope.findFirstOrThrow({ where: { orgId: org.id, kind: "org" } });

for (const account of rest) {
  const user = users.get(account.email);
  if (!user) throw new Error(`User missing after sign-up: ${account.email}`);
  const principal = await db.principal.create({
    data: {
      orgId: org.id,
      kind: "human",
      displayName: account.name,
      authId: user.id,
      email: account.email,
    },
  });
  await db.grant.create({
    data: { orgId: org.id, principalId: principal.id, scopeId: orgScope.id, role: account.role },
  });
  // Mirror the invite-redemption path: members get a personal scope at join.
  if (org.personalScopesEnabled) {
    await ensurePersonalScope(db, {
      orgId: org.id,
      principalId: principal.id,
      displayName: principal.displayName,
    });
  }
}

console.info(`Seeded "${ORG_NAME}" (${org.id})`);
for (const account of accounts) {
  console.info(`  ${account.role.padEnd(6)} ${account.email} / ${PASSWORD}`);
}

await db.$disconnect();
