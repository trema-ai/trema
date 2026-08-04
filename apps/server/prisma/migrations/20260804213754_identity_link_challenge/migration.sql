-- CreateTable
CREATE TABLE "IdentityLinkChallenge" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityLinkChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdentityLinkChallenge_tokenHash_key" ON "IdentityLinkChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "IdentityLinkChallenge_orgId_surface_externalUserId_idx" ON "IdentityLinkChallenge"("orgId", "surface", "externalUserId");

-- CreateIndex
CREATE INDEX "IdentityLinkChallenge_expiresAt_idx" ON "IdentityLinkChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "IdentityLinkChallenge" ADD CONSTRAINT "IdentityLinkChallenge_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
