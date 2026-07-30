-- The built-in fetch driver no longer exists. Its only valid route was
-- web.fetch, which administrators can re-enable with a provider that supports
-- extraction.
DELETE FROM "CapabilityRoute"
WHERE "capabilityKey" = 'web.fetch';

DELETE FROM "CapabilityProvider"
WHERE "driverKey" = 'builtin_web_fetch';
