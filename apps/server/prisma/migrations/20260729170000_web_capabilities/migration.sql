CREATE TABLE "CapabilityProvider" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "driverKey" TEXT NOT NULL,
    "settingsJson" JSONB,
    "credentialCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapabilityProvider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CapabilityRoute" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "capabilityKey" TEXT NOT NULL,
    "chainJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapabilityRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CapabilityProvider_orgId_name_key" ON "CapabilityProvider"("orgId", "name");
CREATE INDEX "CapabilityProvider_orgId_driverKey_idx" ON "CapabilityProvider"("orgId", "driverKey");
CREATE UNIQUE INDEX "CapabilityRoute_orgId_capabilityKey_key" ON "CapabilityRoute"("orgId", "capabilityKey");
CREATE INDEX "CapabilityRoute_orgId_idx" ON "CapabilityRoute"("orgId");

ALTER TABLE "CapabilityProvider"
ADD CONSTRAINT "CapabilityProvider_orgId_fkey"
FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CapabilityRoute"
ADD CONSTRAINT "CapabilityRoute_orgId_fkey"
FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
