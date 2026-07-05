-- ---------------------------------------------------------------------------
-- 0001 — initial pgvector schema.
--
-- Scope, deliberately narrow: this database holds ONLY the pre-embedded default
-- knowledge base. Nothing a visitor uploads is ever written here, no evaluation
-- run is stored, and no result is cached. Uploads live in process memory for the
-- lifetime of one experiment and are then dropped.
--
-- The point of this table is purely cost: embedding the 76-document demo corpus
-- for four strategies on every recruiter visit would be wasteful and slow, so it
-- is embedded once by scripts/seed-default-kb.ts and read back at run time.
--
-- Every statement is idempotent. This migration is the schema that earlier
-- builds applied directly from schema.sql, so it has to be a no-op against a
-- database that already has those objects.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per (strategy, chunk). Different strategies chunk the corpus
-- differently, so their vectors are genuinely different sets rather than a
-- shared pool.
CREATE TABLE IF NOT EXISTS default_kb_chunks (
    id              BIGSERIAL PRIMARY KEY,
    strategy        TEXT         NOT NULL,
    chunk_id        TEXT         NOT NULL,
    doc_id          TEXT         NOT NULL,
    doc_title       TEXT         NOT NULL,
    category        TEXT         NOT NULL,
    ordinal         INTEGER      NOT NULL,
    heading_path    TEXT[]       NOT NULL DEFAULT '{}',
    text            TEXT         NOT NULL,
    embed_text      TEXT         NOT NULL,
    -- LLM-written contextual header (advanced-pro only), NULL elsewhere.
    context_header  TEXT,
    char_start      INTEGER      NOT NULL,
    char_end        INTEGER      NOT NULL,
    token_estimate  INTEGER      NOT NULL,
    embedding       vector(1536) NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT default_kb_chunks_unique UNIQUE (strategy, chunk_id)
);

CREATE INDEX IF NOT EXISTS default_kb_chunks_strategy_idx
    ON default_kb_chunks (strategy);

-- Vector index for similarity search. Cosine distance matches the L2-normalised
-- vectors the embedding service produces. Lists tuned for a few thousand rows.
CREATE INDEX IF NOT EXISTS default_kb_chunks_embedding_idx
    ON default_kb_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 50);

-- The serialised knowledge graph for the GraphRAG strategy: entities,
-- relationships and summarised communities. One row.
CREATE TABLE IF NOT EXISTS default_kb_graph (
    strategy     TEXT PRIMARY KEY,
    payload      JSONB       NOT NULL,
    entities     INTEGER     NOT NULL,
    relationships INTEGER    NOT NULL,
    communities  INTEGER     NOT NULL,
    levels       INTEGER     NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bookkeeping so the API can report what was seeded and warn when the corpus on
-- disk has changed since the seed ran.
CREATE TABLE IF NOT EXISTS default_kb_manifest (
    id                 INTEGER PRIMARY KEY DEFAULT 1,
    document_count     INTEGER     NOT NULL,
    total_chars        INTEGER     NOT NULL,
    corpus_fingerprint TEXT        NOT NULL,
    embedding_model    TEXT        NOT NULL,
    seeded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT default_kb_manifest_singleton CHECK (id = 1)
);
