-- Slack verifies inbound webhooks with a secret distinct from its OAuth
-- client secret. Keep both write-only and encrypted at rest.
ALTER TABLE "ClientRegistration"
ADD COLUMN "signingSecretCiphertext" TEXT;
