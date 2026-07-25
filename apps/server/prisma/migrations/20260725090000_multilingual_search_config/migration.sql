-- The index was built and queried with the 'english' configuration, which
-- stems and drops stopwords for one language. Trema holds content in any
-- language, so the index moves to a configuration that treats every language
-- the same: 'simple' folds case and tokenizes without stemming, and the
-- unaccent dictionary folds diacritics, so "café" and "cafe" agree.
--
-- Losing the stemmer is deliberate. The lexical half of hybrid search now does
-- literal matching, which is what it is good at and what embeddings are bad at
-- (identifiers, error codes, names); morphology is the vector half's job.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION "trema_multilingual" (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION "trema_multilingual"
    ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;

-- A generated column freezes the configuration into its stored expression, so
-- changing it means replacing the column. "title" and "content" are untouched,
-- so the new column recomputes from them as it is created: no reindex pass and
-- no re-embed. The GIN index drops with the old column and is recreated below.
ALTER TABLE "ItemSearchDoc" DROP COLUMN "tsv";
ALTER TABLE "ItemSearchDoc" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('trema_multilingual', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('trema_multilingual', coalesce("content", '')), 'B')
) STORED;

-- CreateIndex
CREATE INDEX "ItemSearchDoc_tsv_idx" ON "ItemSearchDoc" USING GIN ("tsv");
