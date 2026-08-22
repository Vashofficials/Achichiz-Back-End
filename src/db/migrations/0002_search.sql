-- =====================================================================
-- Achichiz — 0002_search.sql
--
-- Storefront product search. Forward-only; 0001_initial.sql is never edited.
--
-- 0001 already ships `pg_trgm` and two product indexes:
--   idx_products_search_trgm  gin ((title || ' ' || coalesce(subtitle,'')) gin_trgm_ops)
--   idx_products_fts          gin (to_tsvector('english', title || ' ' || coalesce(description,'')))
--
-- The trigram index is exactly what the storefront's fuzzy matching needs and is
-- reused as-is. The full-text one is too narrow: it indexes title + description
-- and misses `subtitle` and `tags`, both of which the client-side index in
-- `src/lib/search.ts` searched. This migration adds the wider expression index,
-- plus the vocabulary the "did you mean" prompt is built from.
--
-- NOTE ON FUZZINESS: matching uses the `%` operator, whose cut-off is
-- `pg_trgm.similarity_threshold` (PostgreSQL default 0.3). That is session
-- state on a shared pool, so the application deliberately never SETs it. To
-- change typo tolerance globally, change it in postgresql.conf — not per query.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. WIDE FULL-TEXT INDEX
--
-- Must stay expression-identical to `searchDocument` in
-- src/modules/search/search.repository.ts. If the two drift, every search
-- silently falls back to a sequential scan and nothing fails loudly.
-- ---------------------------------------------------------------------

-- The document expression lives in ONE function, used by the index below AND by
-- the search_vocabulary view further down.
--
-- Two reasons it is a function rather than an inline expression:
--
--  1. `array_to_string(anyarray, text)` is STABLE, not IMMUTABLE — in general an
--     array's text output depends on the element type's output function — and
--     PostgreSQL refuses a non-IMMUTABLE function in an index expression. Pinning
--     the argument to TEXT[] removes the generality that forced that marking, so
--     an IMMUTABLE wrapper is sound here, not a lie told to the planner.
--
--  2. It removes the drift this file was already worried about. The index and the
--     vocabulary view can no longer disagree, because there is only one definition
--     to disagree with. `searchDocument` in search.repository.ts must call this
--     function rather than re-spell the expression.
CREATE OR REPLACE FUNCTION product_search_document(
  p_title       TEXT,
  p_subtitle    TEXT,
  p_description TEXT,
  p_tags        TEXT[]
) RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT coalesce(p_title, '')       || ' ' ||
         coalesce(p_subtitle, '')    || ' ' ||
         coalesce(p_description, '') || ' ' ||
         coalesce(array_to_string(p_tags, ' '), '')
$fn$;

CREATE INDEX IF NOT EXISTS idx_products_fts_wide ON products USING gin (
  to_tsvector('english', product_search_document(title, subtitle, description, tags))
);

-- Autocomplete leads with a title-prefix test on lower(title); without this the
-- header dropdown seq-scans the catalogue on every keystroke.
CREATE INDEX IF NOT EXISTS idx_products_title_lower_pattern
  ON products (lower(title) text_pattern_ops)
  WHERE status = 'active' AND deleted_at IS NULL;

-- Collections are searched by title on the taxonomy pages.
CREATE INDEX IF NOT EXISTS idx_collections_title_trgm ON collections USING gin (
  (title || ' ' || coalesce(heading, '')) gin_trgm_ops
);

-- ---------------------------------------------------------------------
-- 2. SEARCH VOCABULARY  ("did you mean")
--
-- Every distinct lexeme in the live catalogue, with the number of products it
-- appears in. This is the server-side equivalent of the `vocabulary` array the
-- storefront built in memory at module load (`src/lib/search.ts`).
--
-- Materialised rather than computed per request: ts_stat() reads every product
-- row, which is fine nightly and absurd on the no-results path.
--
-- REFRESH: `REFRESH MATERIALIZED VIEW CONCURRENTLY search_vocabulary;`
-- Nightly is ample — it only affects spelling hints, never results. CONCURRENTLY
-- is available because of the unique index below, and is what keeps the view
-- readable while it rebuilds.
-- ---------------------------------------------------------------------

-- Everything inside the ts_stat() string is SCHEMA-QUALIFIED, and must stay that way.
--
-- Since PostgreSQL 15, maintenance operations — CREATE/REFRESH MATERIALIZED VIEW
-- among them — execute with `search_path` forced to `pg_catalog, pg_temp` as a
-- hardening against search_path capture. The string below is parsed at runtime by
-- ts_stat, under that restricted path, so an unqualified `products` raises
-- `relation "products" does not exist` even though the table is right there in
-- `public`. The giveaway is an error with no position: the parser never saw this text.
CREATE MATERIALIZED VIEW IF NOT EXISTS search_vocabulary AS
SELECT word, ndoc
FROM ts_stat($$
  SELECT pg_catalog.to_tsvector('simple',
    public.product_search_document(p.title, p.subtitle, p.description, p.tags))
  FROM public.products p
  WHERE p.status = 'active' AND p.deleted_at IS NULL
$$)
WHERE length(word) > 2;

-- Required for REFRESH ... CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS uq_search_vocabulary_word ON search_vocabulary (word);
-- Drives `WHERE v.word % $1 ORDER BY similarity(v.word, $1) DESC`.
CREATE INDEX IF NOT EXISTS idx_search_vocabulary_trgm
  ON search_vocabulary USING gin (word gin_trgm_ops);

COMMIT;
