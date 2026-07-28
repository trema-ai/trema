-- Connector installation bodies dropped their sensitivity fields when approval
-- modes replaced sensitivity classes (wiki specs/context/07-permissions.md).
-- The body schema is strict, so rows written before that change fail to parse
-- and break list, sync, resolve and update. Scrub the dead keys in place.
-- Only live Item bodies are rewritten: ItemVersion rows are history and are
-- never re-validated.

-- Per-tool overrides keyed by sensitivity class have no successor concept.
UPDATE "Item"
SET "body" = "body" - 'sensitivityOverrides'
WHERE "kind" = 'connector'
  AND jsonb_exists("body", 'sensitivityOverrides');

-- Synced tools kept the provider's declared class and its resolved value
-- alongside the annotations. Annotations survive as classifier signal, the
-- two sensitivity keys do not. Element order is preserved.
UPDATE "Item"
SET "body" = jsonb_set(
  "body",
  '{syncedTools}',
  (
    SELECT coalesce(
      jsonb_agg("tool" - 'sensitivity' - 'declaredSensitivity' ORDER BY "position"),
      '[]'::jsonb
    )
    FROM jsonb_array_elements("Item"."body" -> 'syncedTools')
      WITH ORDINALITY AS "entry"("tool", "position")
  )
)
WHERE "kind" = 'connector'
  AND jsonb_typeof("body" -> 'syncedTools') = 'array';
