-- The claim's fingerprint: the intent kind and target an id was claimed for.
-- A duplicate whose kind or target differs is a mismatched reuse of the id to
-- refuse, never a replay to answer. Nullable: claims recorded before this
-- migration carry no fingerprint and stay answerable as plain duplicates.
ALTER TABLE "RunIntent" ADD COLUMN "kind" TEXT;
ALTER TABLE "RunIntent" ADD COLUMN "targetId" TEXT;
