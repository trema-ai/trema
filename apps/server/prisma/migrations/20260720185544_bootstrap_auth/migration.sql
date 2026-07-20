-- CreateEnum
CREATE TYPE "PrincipalKind" AS ENUM ('human', 'agent');

-- CreateEnum
CREATE TYPE "ScopeKind" AS ENUM ('org', 'space', 'personal');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'member', 'viewer');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "activeOrgId" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Principal" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "PrincipalKind" NOT NULL,
    "displayName" TEXT NOT NULL,
    "authId" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Principal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scope" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "ScopeKind" NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grants" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "redeemedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCredential" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorPrincipalId" TEXT,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "Principal_authId_idx" ON "Principal"("authId");

-- CreateIndex
CREATE INDEX "Principal_orgId_email_idx" ON "Principal"("orgId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Principal_orgId_authId_key" ON "Principal"("orgId", "authId");

-- CreateIndex
CREATE UNIQUE INDEX "Principal_orgId_id_key" ON "Principal"("orgId", "id");

-- CreateIndex
CREATE INDEX "IdentityLink_orgId_principalId_idx" ON "IdentityLink"("orgId", "principalId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityLink_orgId_surface_externalUserId_key" ON "IdentityLink"("orgId", "surface", "externalUserId");

-- CreateIndex
CREATE INDEX "Scope_orgId_ownerId_idx" ON "Scope"("orgId", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Scope_orgId_id_key" ON "Scope"("orgId", "id");

-- CreateIndex
CREATE INDEX "grants_orgId_principalId_idx" ON "grants"("orgId", "principalId");

-- CreateIndex
CREATE INDEX "grants_orgId_scopeId_idx" ON "grants"("orgId", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "grants_orgId_principalId_scopeId_key" ON "grants"("orgId", "principalId", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_orgId_scopeId_idx" ON "Invite"("orgId", "scopeId");

-- CreateIndex
CREATE INDEX "Invite_orgId_redeemedById_idx" ON "Invite"("orgId", "redeemedById");

-- CreateIndex
CREATE INDEX "Invite_orgId_createdById_idx" ON "Invite"("orgId", "createdById");

-- CreateIndex
CREATE INDEX "Invite_orgId_expiresAt_idx" ON "Invite"("orgId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCredential_tokenHash_key" ON "ServiceCredential"("tokenHash");

-- CreateIndex
CREATE INDEX "ServiceCredential_orgId_principalId_idx" ON "ServiceCredential"("orgId", "principalId");

-- CreateIndex
CREATE INDEX "ServiceCredential_orgId_createdById_idx" ON "ServiceCredential"("orgId", "createdById");

-- CreateIndex
CREATE INDEX "AuditLog_orgId_actorPrincipalId_idx" ON "AuditLog"("orgId", "actorPrincipalId");

-- CreateIndex
CREATE INDEX "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Principal" ADD CONSTRAINT "Principal_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Principal" ADD CONSTRAINT "Principal_authId_fkey" FOREIGN KEY ("authId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_orgId_principalId_fkey" FOREIGN KEY ("orgId", "principalId") REFERENCES "Principal"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scope" ADD CONSTRAINT "Scope_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scope" ADD CONSTRAINT "Scope_orgId_ownerId_fkey" FOREIGN KEY ("orgId", "ownerId") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_orgId_principalId_fkey" FOREIGN KEY ("orgId", "principalId") REFERENCES "Principal"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_orgId_scopeId_fkey" FOREIGN KEY ("orgId", "scopeId") REFERENCES "Scope"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_orgId_redeemedById_fkey" FOREIGN KEY ("orgId", "redeemedById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_orgId_createdById_fkey" FOREIGN KEY ("orgId", "createdById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCredential" ADD CONSTRAINT "ServiceCredential_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCredential" ADD CONSTRAINT "ServiceCredential_orgId_principalId_fkey" FOREIGN KEY ("orgId", "principalId") REFERENCES "Principal"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCredential" ADD CONSTRAINT "ServiceCredential_orgId_createdById_fkey" FOREIGN KEY ("orgId", "createdById") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_actorPrincipalId_fkey" FOREIGN KEY ("orgId", "actorPrincipalId") REFERENCES "Principal"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce exactly one root scope row per organization. Prisma does not model
-- partial unique indexes, so this index is intentionally maintained in SQL.
CREATE UNIQUE INDEX "Scope_one_org_kind_per_org" ON "Scope"("orgId") WHERE "kind" = 'org';
