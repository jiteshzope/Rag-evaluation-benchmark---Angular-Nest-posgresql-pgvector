# Backend — RAG Evaluation Benchmark API

NestJS API that runs the evaluations: ingestion, the four RAG strategies, the
answering and judge models, metric computation, and the SSE stream the dashboard
follows. See the [root README](../README.md) for what the strategies do and how
the metrics are defined; this file covers running and operating the service.

---

## Requirements

- Node 20+
- An OpenAI API key
- PostgreSQL 15+ with the `vector` extension (Neon, or the bundled docker compose)

---

## Configuration

Copy `.env.example` to `.env` and fill it in. Nothing else reads configuration —
there is no config file and no baked-in defaults for secrets.

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | yes | Embeddings, answering, judging, graph extraction |
| `DATABASE_URL` | yes | Where the pre-embedded corpus lives. Serving traffic |
| `MIGRATION_DATABASE_URL` | no | Used by migrations instead of `DATABASE_URL` |
| `PG_CONNECT_TIMEOUT_MS` | no | Connection wait, default `20000` |
| `PORT` | no | Default `3001`. Railway injects this — do not hardcode it |
| `CORS_ORIGIN` | no | Comma-separated browser origins, `*` allowed as a wildcard |
| `EMBEDDING_MODEL` | no | Default `text-embedding-3-small` (1536 dims) |
| `ANSWER_MODEL` / `JUDGE_MODEL` / `UTILITY_MODEL` | no | Default `gpt-5-nano` |
| `DEFAULT_KB_DIR` / `DEFAULT_QA_SET` | no | Demo corpus paths, relative to `backend/` |

Changing `EMBEDDING_MODEL` changes the vector width. The `embedding` column is
`vector(1536)`; a model with a different dimensionality needs a migration.

---

## Running

```bash
npm run migrate      # bring the schema up to date
npm run seed         # embed the demo corpus into pgvector (runs migrations first)
npm run start:dev    # watch mode on :3001
```

| Script | What it does |
|---|---|
| `start:dev` | Nest in watch mode |
| `start:prod` | `node dist/main` — run `build` first |
| `build` | Compiles to `dist/`, copying the migration SQL as an asset |
| `migrate` | Applies pending migrations |
| `migrate:status` | Lists each migration as applied / pending / modified / missing |
| `seed` | Embeds the demo corpus; skips strategies already seeded |
| `seed:reset` | Wipes and re-embeds everything |
| `test` | Jest unit tests, no services required |
| `typecheck` | `tsc --noEmit` |

`seed` takes `--only=graphrag` (or a comma-separated list) to rebuild one
strategy.

---

## The database

Postgres holds **only** the pre-embedded demo corpus, in four tables:

| Table | Contents |
|---|---|
| `default_kb_chunks` | one row per (strategy, chunk): text, metadata, `vector(1536)` |
| `default_kb_graph` | the serialised GraphRAG knowledge graph, one row |
| `default_kb_manifest` | what was seeded, and the corpus fingerprint it came from |
| `schema_migrations` | which migrations have run, with checksums |

Nothing a visitor uploads is ever written here. Uploaded corpora, evaluation runs
and results live in process memory for the lifetime of one experiment and are
dropped with it.

Retrieval does **not** use SQL vector search. `loadChunks()` reads every row for a
strategy and `VectorIndex` scores them with an exact linear scan in memory — the
corpora are a few thousand chunks, and an approximate index would introduce
recall loss indistinguishable from a retrieval-strategy difference, which is the
one thing this benchmark exists to measure. Postgres is a cache for embeddings,
not a search engine.

### Migrations

Forward-only SQL in [`src/vector-store/migrations/`](src/vector-store/migrations/),
named `NNNN_lower_snake_case.sql`. The runner
([`migrator.ts`](src/vector-store/migrator.ts)):

- applies each file once, in version order, **each in its own transaction** — a
  failure leaves the database at a known version rather than rolling back work
  that was already correct;
- records a SHA-256 checksum, and **refuses to run** if an already-applied file
  has been edited. The database cannot be changed by rewriting the record of what
  it ran, so the fix is always a new migration;
- holds a **session advisory lock** for the whole run, so two concurrent deploys
  serialise instead of applying the same file twice.

There are no down-migrations. This schema is a cache: recovery from a bad
migration is to fix it forward and re-seed, which costs one seed run.

To add one, create the next numbered file and run `npm run migrate`. Line endings
are normalised before checksumming, so a CRLF checkout does not invalidate
migrations applied from an LF one.

---

## Deploying the database to Neon

Neon runs pgvector, so the only differences from local Postgres are the
connection string and the fact that an idle database suspends.

**1. Take both connection strings** from the Neon dashboard — the pooled one
(host contains `-pooler`) and the direct one.

**2. Set them in `.env`:**

```bash
# Serves traffic: the pooled endpoint.
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/DB?sslmode=require

# Migrations only: the direct endpoint.
MIGRATION_DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx.REGION.aws.neon.tech/DB?sslmode=require
```

Migrations need the **direct** endpoint because the runner holds a session
advisory lock, and the pooler runs PgBouncer in transaction mode, which does not
keep session state between statements. Serving traffic through the pooler is
correct and unaffected.

**3. Apply the schema and load the corpus:**

```bash
npm run migrate   # creates the vector extension and the tables
npm run seed      # embeds the corpus — about 6 minutes, roughly $0.09
```

**4. Verify:**

```bash
npm run migrate:status                    # every migration "applied"
curl localhost:3001/api/meta | jq .pgvector
```

`pgvector.available` should be `true` and `coverage` should list all four
strategies.

### Two things that matter on a suspended database

Neon suspends compute after a period of inactivity, and the first connection
afterwards waits for it to resume. Two behaviours exist specifically for that:

- `PG_CONNECT_TIMEOUT_MS` defaults to **20s**, well above what a local socket
  needs, so a cold start waits instead of failing.
- A failed *connection* is **never** cached as "corpus unavailable". It would
  otherwise be catastrophic: one cold start would make every later run re-embed
  the entire corpus at real cost until the process restarted. Only a successful
  query — or a genuinely missing table — settles that flag. Transient connection
  errors are retried once.

`sslmode=require` in the connection string is enough for TLS; node-postgres
currently treats it as full verification, which Neon's certificate satisfies.

---

## Deploying the API to Railway (UI on Vercel)

The UI and the API end up on different origins, which is the only thing that
makes this deployment different from running both locally.

### Railway environment

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | your key |
| `DATABASE_URL` | Neon **pooled** endpoint |
| `MIGRATION_DATABASE_URL` | Neon **direct** endpoint |
| `CORS_ORIGIN` | `https://your-app.vercel.app,https://*.vercel.app` |
| `PG_CONNECT_TIMEOUT_MS` | `20000` |

Leave `PORT` alone — Railway sets it, and the server already binds `0.0.0.0` on
`process.env.PORT`.

The second `CORS_ORIGIN` entry is what makes Vercel previews work. Every preview
deployment gets a fresh hostname (`app-git-branch-team.vercel.app`), so without a
wildcard only production would be able to call the API. `*` matches any run of
characters except `/`, the pattern is anchored, and everything else is escaped —
so `https://your-app.vercel.app.attacker.com` does **not** match. Drop the
wildcard entry if you do not want previews reaching the live API and its quota.

Build and start commands are the defaults for a Node service:

```bash
npm install && npm run build --workspace backend   # build
node backend/dist/main                             # start
```

Migrations are **not** run automatically on boot. Run them from the Railway shell
(or locally against the same database) when a deploy includes a new one:

```bash
npm run migrate --workspace backend
```

### Vercel environment

| Variable | Value |
|---|---|
| `NG_APP_API_BASE_URL` | `https://your-api.up.railway.app` — origin only, no `/api`, no trailing slash |

The Angular build **inlines** this at build time — `frontend/scripts/generate-environment.mjs`
writes it into `src/environments/environment.ts` before `ng build` — so it must be
set before the build and a change to it needs a redeploy. Set it to an empty
value only when the UI and the API share an origin, which makes every request
relative.

[`vercel.json`](../vercel.json) at the repo root already sets the workspace-aware
build (`npm run build --workspace frontend`, output `frontend/dist`), so point
Vercel's Root Directory at the repository root rather than `frontend/`.

### Two things that cross-origin changes

**`PATCH` must be in the allowed methods.** Changing the strategy selection uses
`PATCH /api/experiments/:id/strategies`, which browsers preflight. It is in the
list; if you ever trim `methods` in `main.ts`, that endpoint breaks in production
while continuing to work locally through the dev proxy.

**Server-Sent Events need to survive a proxy.** The run stream can be silent for
minutes — indexing an uploaded corpus for GraphRAG emits nothing between
"Extracting entities" and "Graph has N entities" — and a proxy will drop an idle
connection long before that, leaving the browser showing a run that looks stalled
but is progressing. The SSE endpoint therefore sends a `ping` event every 15
seconds and sets `X-Accel-Buffering: no` and `Cache-Control: no-transform` so
nothing between the server and the browser buffers or rewrites the stream. The
client ignores unknown event types, so the ping is invisible to the UI.

### Verifying a deployment

```bash
curl https://your-api.up.railway.app/health
curl https://your-api.up.railway.app/api/meta | jq '.pgvector.available, .pgvector.coverage'

# CORS: should echo the origin back
curl -i -X OPTIONS https://your-api.up.railway.app/api/experiments/x/strategies \
  -H 'Origin: https://your-app.vercel.app' \
  -H 'Access-Control-Request-Method: PATCH' | grep -i access-control
```

If the browser reports a CORS failure, check the API's startup log — it prints
`CORS allows: …` with exactly the list it parsed.

### Switching back to local Postgres

```bash
npm run db:up                                              # from the repo root
# in .env:
DATABASE_URL=postgresql://rag:rag@localhost:5434/ragbench
# unset MIGRATION_DATABASE_URL, then:
npm run migrate && npm run seed
```

---

## Layout

```
src/
  common/          shared types, rate limiting, error filter
  config/          env access (AppConfig), limits, model pricing
  datasets/        demo corpus loader, dataset parser, question generator
  evaluation/      the run loop, result aggregation
  experiments/     REST controller, experiment lifecycle, in-memory store
  ingestion/       document parsing, chunking profiles
  llm/             OpenAI client, answer/judge services, prompts, usage tracking
  metrics/         retrieval metrics, relevance labelling
  rag/             the four strategies, BM25, RRF, reranking, vector index
    graph/         entity extraction, Louvain communities, graph search
  vector-store/    pgvector access, migrations, migration runner
scripts/
  migrate.ts       migration CLI
  seed-default-kb.ts
```

---

## Testing

```bash
npm test           # 181 unit tests, no database or network needed
```

Integration checks that need the API running live in
[`../scripts/`](../scripts/) — see the root README's Testing section.

---

## Operational notes

- **Quota is only charged for work that happens.** A run rejected for a missing
  corpus, or an upload rejected as too short, refunds its charge
  (`RateLimitService.spendOn`). Limits are per-IP and in memory, so they reset on
  restart — a spend control, not a security control.
- **Experiments expire** after 60 minutes of inactivity, and are evicted early
  under a capacity cap. The API returns 404 with an explanation; the frontend
  clears the dead session and reloads the demo corpus.
- **The corpus fingerprint** is compared against the manifest on every
  `GET /api/meta`. If the markdown on disk changes without a re-seed, the UI
  shows the demo corpus as stale — re-run `npm run seed:reset`.
