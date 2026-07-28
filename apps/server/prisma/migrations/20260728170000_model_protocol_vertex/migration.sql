-- The Google Vertex wire protocol, now that `@trema/models` resolves it, and
-- the credential mode that lands with it. A Vertex call carries a bearer token
-- minted from a service account, so there is no key header for the modes above
-- it to reuse and no signature for the one beside it either: the exchange
-- happens first, and only its result travels.
--
-- The mode covers both of its storage states on purpose. A row that stores a
-- service account mints from that; a row that stores none leaves the worker's
-- own application-default credential to answer, which is how a workload
-- identity signs without a key ever being pasted into the registry.
--
-- No new column: the settings this protocol needs — a project and a location,
-- which is where Vertex addresses models — go in the one added with `bedrock`,
-- because each protocol declares the shape it takes and the rest refuse a value.

-- AlterEnum
ALTER TYPE "ModelProtocol" ADD VALUE 'vertex';

-- AlterEnum
ALTER TYPE "ModelCredentialMode" ADD VALUE 'gcp_adc';
