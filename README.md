# RAG Evaluation Benchmark

A workbench for answering the question every RAG project eventually runs into:
**which retrieval strategy is actually better, for which kinds of question, and is
the improvement worth what it costs?**

Four strategies run over the same corpus and the same questions, and are scored on
retrieval quality, answer quality, token cost and latency — separately, so a
strategy that retrieves well but hallucinates cannot hide behind a single
"accuracy" number.

```
                         RAG EVALUATION BENCHMARK

              Knowledge base                Evaluation dataset
        ┌───────────────────────┐      ┌────────────────────────┐
        │ Pre-embedded demo     │      │ 150-question demo set  │
        │ corpus (pgvector)     │      │ Upload JSON/JSONL/CSV  │
        │ Upload PDF/DOCX/TXT   │      │ Paste                  │
        │ Paste text            │      │ LLM auto-generate      │
        └───────────┬───────────┘      └───────────┬────────────┘
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │   Baseline                   │
                    │   Advanced Hybrid            │
                    │   Advanced-Pro Adaptive      │
                    │   GraphRAG                   │
                    └──────────────┬───────────────┘
                                   ▼
            for each question:  retrieve → score retrieval
                                        → answer (no reference answer)
                                        → judge (sees everything)
                                   │
                                   ▼  Server-Sent Events
                        ┌──────────────────────┐
                        │  Results dashboard   │
                        │  retrieval · answer  │
                        │  cost · latency      │
                        │  per-question drill  │
                        └──────────────────────┘
```

---

## Quick start

```bash
# 1. Postgres + pgvector
npm run db:up

# 2. Configure
cp backend/.env.example backend/.env      # add your OPENAI_API_KEY
cp frontend/.env.example frontend/.env    # points at http://localhost:3001

# 3. Install
npm install

# 4. Pre-embed the demo corpus (one-time, ~6 minutes, ~$0.09)
#    Applies any pending database migrations first.
npm run seed

# 5. Run
npm run dev        # API on :3001, UI on :5173
```

Open <http://localhost:5173>.

Hosting the database elsewhere (Neon, RDS, anything with pgvector)? The schema
lives in versioned migrations — see the [backend README](backend/README.md).

The demo knowledge base is pre-selected. Pick your strategies and press **Run
evaluation** — nothing else is required.

---

## The four strategies

| Capability | Baseline | Advanced | Advanced-Pro | GraphRAG |
|---|:--:|:--:|:--:|:--:|
| Chunking | fixed window | structure-aware | context-enriched | structure-aware |
| Dense vector search | ✅ | ✅ | ✅ | ✅ |
| BM25 lexical | — | ✅ | ✅ | ✅ |
| Reciprocal Rank Fusion | — | ✅ | ✅ | ✅ |
| Query rewriting | — | ✅ | ✅ | — |
| LLM reranking | — | ✅ | ✅ | — |
| Multi-query | — | — | ✅ | — |
| Query decomposition | — | — | ✅ | — |
| Adaptive routing | — | — | ✅ | ✅ |
| Dynamic top-K | — | — | ✅ | — |
| Contextual chunk enrichment | — | — | ✅ | — |
| Parent/neighbour expansion | — | — | ✅ | — |
| Context compression | — | — | ✅ | — |
| Entity + relationship graph | — | — | — | ✅ |
| Community detection & summaries | — | — | — | ✅ |
| Local / Global / DRIFT search | — | — | — | ✅ |

### Baseline — the control group

Fixed-size chunks, one embedding each, cosine top-k. Implemented properly rather
than hobbled: every gain the other strategies report is measured against this, so
a weak baseline would make the whole benchmark dishonest.

### Advanced Hybrid

```
question ──► rewrite ─┬─► dense search ─┐
                      └─► BM25 search ──┴─► RRF ─► LLM rerank ─► top-k
```

Dense retrieval and BM25 fail differently. An embedding of *"Contract with Apex
Reinsurance"* sits almost on top of *"Contract with Belvedere Insurance"*; BM25
separates them instantly on the rare proper noun. Fusing on **rank** rather than
score is what makes them combinable — a cosine of 0.82 and a BM25 score of 14.3
are not comparable quantities.

### Advanced-Pro Adaptive

Adds two ideas that change the shape of retrieval rather than its parameters:

1. **Contextual chunk enrichment.** A chunk reading *"The agreement may be
   terminated after 30 days"* names neither the agreement nor the parties, so it
   is nearly unretrievable. At ingest, an LLM writes one sentence situating each
   chunk in its document, and *that* is embedded. The original text is what the
   answering model sees — enrichment never leaks into an answer.
2. **Adaptive routing.** A question asking for one salary and a question asking
   for themes across the whole corpus should not get identical retrieval. The
   router classifies the question, then decomposes, multi-queries or narrows
   accordingly, with a dynamic top-K.

### GraphRAG

Not "Advanced-Pro with more steps" — it answers a different question *shape*.
Top-k retrieval fundamentally cannot answer *"what themes run across all 76
documents?"*, because no single chunk contains the answer; the answer is a
property of the corpus.

At index time it extracts entities and relationships, detects communities with
**Louvain** modularity optimisation (hierarchical, deterministic), and writes an
LLM summary per community. At query time it routes to one of four modes:

| Mode | How it retrieves | Best for |
|---|---|---|
| **Local** | anchor on entities the question names, walk to graph neighbours, rank their text units | "what do we know about X and its connections?" |
| **Global** | map-reduce over community summaries, then surface the evidence behind the contributing communities | corpus-wide, thematic questions |
| **DRIFT** | community summaries as a primer, then local search on the entities that surfaced | multi-hop questions |
| **Basic** | plain hybrid search over text units | fallback |

Entity contributions are damped by an IDF factor. Without it a hub entity —
"Assurio" occurs in nearly every document of the demo corpus — adds the same
score to hundreds of text units and flattens the ranking into noise.

---

## Metrics

Retrieval and generation are scored as **separate layers**. That separation is the
single most important design decision here: MRR and nDCG say whether the retriever
found the evidence; faithfulness and correctness say whether the generator used
it. Collapsing them into one "accuracy" number would let a strategy with excellent
retrieval and rampant hallucination look good.

| Retrieval quality | Answer quality | Efficiency | System |
|---|---|---|---|
| MRR | Faithfulness | Input tokens | Indexing time |
| nDCG@5 | Factual correctness | Output tokens | Retrieval time |
| Recall@5 | Answer relevance | Embedding tokens | Generation time |
| Precision@5 | LLM judge score | Cost per stage | Judge time |
| Hit rate@5 | Answer keyword coverage | Cost per question | p50 / p95 latency |
| Context precision | Reference similarity | | Index size |
| Context recall | | | |
| Context keyword coverage | | | |

A **composite score** blends them for easy ranking, but every component stays
visible so the composite never has to be trusted alone.

### Where the ground truth comes from

MRR and nDCG are *ranking* metrics — they need to know which chunks should have
been retrieved. Neither the shipped question set nor a user's uploaded one carries
chunk ids, so relevance labels are derived from the evidence each item already
has:

```
relevance(chunk) = 0.6 · (expected keywords present in chunk)
                 + 0.4 · (reference-answer content words present in chunk)
```

Graded relevance feeds nDCG (which is defined for graded relevance); a 0.5
threshold gives the binary relevance that MRR, Recall, Precision and Hit-rate
need. Both signals are used because keywords alone are too few and would make the
labels near-tautological with the keyword-coverage metric, while reference-answer
overlap alone is noisy.

When a dataset *is* auto-generated, each question records the chunk it was written
from as `goldChunkIds`, and that authoritative label wins outright.

Labels are computed once per (index, dataset) pair and reused for every strategy,
so all strategies are scored against identical ground truth.

### No reference-answer leakage

```
ANSWER LLM                    JUDGE LLM
  question                      question
  + retrieved context           + reference answer
                                + generated answer
  ✗ NO reference answer         + retrieved context
```

The answering service has no access to the reference answer — it is not even in
its request type.

---

## Architecture

```
backend/src/
├── config/          limits.ts (every guardrail), pricing, app config
├── common/          domain types, rate limiting, error filter
├── ingestion/       text extraction, three chunking profiles, text utils
├── llm/             OpenAI wrapper (all token accounting), prompts, answer, judge
├── rag/
│   ├── vector-index.ts   flat exact-cosine index
│   ├── bm25.ts           Okapi BM25
│   ├── fusion.ts         Reciprocal Rank Fusion
│   ├── reranker.service.ts
│   ├── query-transform.service.ts
│   ├── baseline/ advanced/ advanced-pro/ graph/
│   └── rag-strategy.factory.ts
├── metrics/         retrieval metrics, relevance labelling
├── datasets/        default corpus, parser (JSON/JSONL/CSV), generator
├── evaluation/      orchestrator, result aggregator
├── experiments/     in-memory store, controller, SSE
└── vector-store/    pgvector (default corpus only)

frontend/src/app/
├── api/             typed client, SSE subscription
├── store/           experiment & meta state, held in signals
├── lib/             formatting, colour assignment
└── components/
    ├── setup/       strategy, knowledge base, dataset pickers
    ├── progress/    live run view
    ├── results/     charts, comparison, table, detail drawer
    └── ui/          SVG chart frame & primitives
```

**Stack** — Angular 21 (zoneless, standalone, signals) · TypeScript · Tailwind on
the frontend; NestJS 11 · Postgres with pgvector on the backend;
`text-embedding-3-small` + `gpt-5-nano` throughout.

There is no chart library: `BarChart` computes the geometry and emits plain SVG,
so every chart in the dashboard shares one tooltip, one grid and one tick rule.
More on the front end in the [frontend README](frontend/README.md).

### Why exact vector search

The corpora here are at most a few thousand chunks. An approximate index
(HNSW/IVF) would introduce recall loss indistinguishable from a
retrieval-strategy difference — precisely the thing being measured. Exact search
is the correct choice, not a shortcut.

---

## Storage: deliberately minimal

pgvector holds **only** the pre-embedded demo corpus. That is its entire purpose:
embedding 76 documents four different ways, writing ~540 contextual headers and
running entity extraction on every visit would be slow and wasteful, so it happens
once in `npm run seed`.

Everything else is in memory:

- **Uploaded documents** are parsed to text, indexed, evaluated and dropped. They
  are never written to disk or to Postgres.
- **Evaluation runs are never cached.** Every run executes live and streams over
  SSE, so the numbers on screen always come from a real execution.
- Experiments are evicted after an hour, or sooner under capacity pressure.

### Schema and migrations

The schema is four tables, versioned as forward-only SQL files in
[`backend/src/vector-store/migrations/`](backend/src/vector-store/migrations/):

```bash
npm run migrate          # apply everything pending
npm run migrate:status   # what is applied, pending or modified
```

The runner ([`migrator.ts`](backend/src/vector-store/migrator.ts)) applies each
file once, in version order, each in its own transaction, and records a checksum.
Editing a file that has already been applied is a hard error — the database
cannot be changed by rewriting the record of what it ran, so the fix is a new
migration. A session advisory lock is held for the whole run so two deploys
serialise instead of racing.

There are no down-migrations. This schema is a cache: recovering from a bad
migration means fixing it forward and re-seeding, which costs one seed run rather
than a restore. `npm run seed` runs any pending migrations first, so local setup
stays a single command.

### Deploying

The three pieces deploy independently:

| Piece | Runs on | Configured with |
|---|---|---|
| Database | any Postgres with pgvector (Neon) | `DATABASE_URL`, `MIGRATION_DATABASE_URL` |
| API | any Node host (Railway) | `OPENAI_API_KEY`, `CORS_ORIGIN`, the two database URLs |
| UI | any static host (Vercel) | `NG_APP_API_BASE_URL` |

Split across origins, three things matter: `CORS_ORIGIN` needs a wildcard entry
for preview deployments, `PATCH` has to stay in the allowed methods, and the SSE
stream needs its heartbeat to survive a proxy's idle timeout. All of it — plus
the migrate-then-seed steps and the serverless-suspend behaviour — is in the
**[backend README](backend/README.md#deploying-the-database-to-neon)**.

Same-origin deployments need none of this: set `NG_APP_API_BASE_URL` to an empty
value and requests stay relative.

---

## Guardrails

This is a public portfolio deployment where every run spends real API credit. All
limits live in [`backend/src/config/limits.ts`](backend/src/config/limits.ts) and
are served to the UI at `GET /api/meta`, so the frontend renders the same numbers
the server enforces.

| Limit | Value |
|---|---|
| Max upload size | 1 MB (rejected above) |
| Knowledge base text kept | 240,000 chars (trimmed, with a notice to the user) |
| Max questions per run | 100 |
| Max strategies per run | 3 |
| Context chunks (= k in nDCG@k) | 5 |
| Answer output tokens | 500 |
| Judge output tokens | 700 |
| Generated dataset size | 40 |
| Runs / uploads / generations per IP per day | 7 / 7 / 3 |
| Concurrent runs, process-wide | 2 |

Uploads are trimmed rather than rejected when they exceed the character budget,
and the user is told exactly what was cut and why.

Quota is only charged for work that actually happens. A run rejected for a missing
corpus, an upload rejected for being too short, a generation refused on the demo
corpus — none of them cost the visitor anything, because none of them spent
anything (`RateLimitService.spendOn` refunds the charge if the work throws).

### The demo corpus and its question set are one pairing

The 150 shipped questions are hand-written against the Assurio documents and carry
reference answers taken from their contents, so the two only mean anything
together. Choosing the demo knowledge base therefore fixes the question source:
the UI greys out upload, paste and generate and says why, and the server refuses
them independently — the buttons being disabled is a convenience, not the control.
The rule holds in both directions: the demo questions cannot be attached to an
uploaded corpus either, and changing the corpus drops a dataset that no longer
applies to it rather than leaving a pairing `POST /run` would reject.

Bring your own documents and you supply your own questions, in any of three ways.

### Starting over

**Start over** in the header clears every selection, releases the server-side
experiment (which is what discards an uploaded corpus from memory) and returns to
a fresh setup. Hit it while a run is in flight and it confirms first, then cancels
the run before releasing it — otherwise the cancel could arrive after the delete
and leave the evaluation finishing in the background on real credit.

---

## API

```
GET    /api/meta                                  strategies, limits, quotas, corpus info
GET    /api/quotas

POST   /api/experiments
GET    /api/experiments/:id
DELETE /api/experiments/:id

POST   /api/experiments/:id/knowledge-base        multipart upload
POST   /api/experiments/:id/knowledge-base/text
POST   /api/experiments/:id/knowledge-base/default

POST   /api/experiments/:id/dataset               paste
POST   /api/experiments/:id/dataset/upload
POST   /api/experiments/:id/dataset/default
POST   /api/experiments/:id/dataset/generate
GET    /api/experiments/:id/dataset

POST   /api/experiments/:id/run
POST   /api/experiments/:id/cancel
GET    /api/experiments/:id/events                Server-Sent Events

GET    /api/experiments/:id/results
GET    /api/experiments/:id/results/questions
GET    /api/experiments/:id/results/questions/:questionId

GET    /health
```

SSE events: `status`, `indexing`, `indexed`, `progress`, `question`,
`strategy-complete`, `complete`, `error`. The server replays its buffered event
log to every new subscriber, so a client that connects a moment after `POST /run`
still sees the indexing phase.

---

## The demo corpus

76 markdown documents (~300k characters) describing *Assurio*, a fictional
insurance-tech company: company pages, 32 employee records, 8 product pages and 36
client contracts. It is a good RAG benchmark because it contains many
near-identical documents that differ only in proper nouns — exactly the case where
dense retrieval alone struggles.

The 150-question set spans seven types:

| Type | n | What it tests |
|---|---:|---|
| `direct_fact` | 70 | single-passage lookup |
| `temporal` | 20 | dates, sequence, duration |
| `spanning` | 20 | evidence across several documents |
| `comparative` | 10 | comparing two or more entities |
| `numerical` | 10 | figures and aggregates |
| `relationship` | 10 | how entities connect |
| `holistic` | 10 | corpus-wide themes |

### What a run actually shows

A 21-question run (3 per type) over the pre-embedded corpus, `gpt-5-nano`
throughout, ~$0.017 and ~105 seconds:

| | Baseline | Advanced-Pro | GraphRAG |
|---|---:|---:|---:|
| Composite | 0.586 | **0.610** | 0.589 |
| nDCG@5 | 0.610 | 0.601 | **0.638** |
| Faithfulness | 0.636 | **0.710** | 0.633 |
| Factual correctness | 0.400 | **0.486** | 0.467 |
| Cost / question | **$0.00016** | $0.00041 | $0.00022 |
| p95 latency | **3.5 s** | 7.6 s | 6.6 s |

nDCG@5 by question type — **no strategy wins everywhere**, which is the whole
point of scoring by type:

| Question type | Baseline | Advanced-Pro | GraphRAG |
|---|---:|---:|---:|
| Direct fact | 0.676 | **0.766** | 0.655 |
| Temporal | 0.584 | 0.563 | **0.700** |
| Comparative | 0.678 | 0.590 | **0.687** |
| Numerical | 0.711 | 0.515 | **0.717** |
| Relationship | 0.790 | **0.818** | 0.638 |
| Spanning | 0.394 | 0.435 | **0.622** |
| Holistic | 0.438 | **0.519** | 0.450 |

The headline: **baseline is 2.5× cheaper and 2× faster, and on this corpus it is
genuinely competitive on single-passage lookups.** The advanced pipelines earn
their cost on the hard types — GraphRAG is 58% better than baseline on
*spanning* questions (0.622 vs 0.394), where the evidence is split across
documents, and Advanced-Pro leads on *holistic* and *relationship*. Buying
Advanced-Pro's +21% factual correctness costs 2.5× per question and doubles p95
latency.

Every strategy scores near zero on factual correctness for *holistic* questions.
That is honest and worth showing: corpus-wide synthesis over 76 documents is not
solved by any of these four approaches at k=5.

> Exact numbers move between runs — routing, reranking and judging are all LLM
> calls. The *shape* of the result is stable.

> **Note on the shipped data.** The question set was written against an earlier
> name for the company ("Insurellm") while the corpus now says "Assurio". Left
> alone, the judge would mark factually correct answers wrong for using the name
> that actually appears in the documents. The loader normalises the name at read
> time ([`default-corpus.service.ts`](backend/src/datasets/default-corpus.service.ts)).
> The mismatch was confined to prose — no expected keyword contained it — so this
> does not touch what is being measured.

---

## Testing

```bash
npm test                    # 190 unit tests, no services needed
npm run test:api            # API contract check   (needs the backend)
npm run test:ui             # setup + upload flows (needs backend and frontend)
npm run test:ui:run         # a live run end to end (spends one run of quota)
```

**Unit tests** cover the parts where a silent bug would corrupt every number
downstream: ranking metrics against hand-worked expected values, chunking profile
invariants, BM25 and RRF properties (including scale-invariance), Louvain community
detection, IDF damping in graph scoring, dataset parsing across JSON/JSONL/CSV, the
corpus/question-set pairing rule, and quota refunds.

`scripts/api-contract-check.mjs` drives every path the setup screen can take
against a running backend — including the ones the UI makes unreachable, because
the server has to refuse them on its own rather than because a button was greyed
out. It spends 5 uploads of daily quota and no runs.

`frontend/scripts/ui-flow-check.mjs` and `ui-upload-check.mjs` drive the real UI
over the Chrome DevTools Protocol using whatever Chromium is installed (set
`BROWSER_BIN` to choose one), asserting the lock, the parse results and the reset,
and writing screenshots. `ui-run-check.mjs` covers a real evaluation through the
progress screen and every chart, table and drawer on the results screen, and
`ui-cancel-check.mjs` starts a run and interrupts it; both spend a run of quota.

Fixtures for all of these live in [`test-fixtures/`](test-fixtures/): a small
fictional corpus plus matching question sets in JSONL, JSON and CSV, and one
deliberately malformed file to exercise the skipped-row reporting.

---

## Cost

With the demo corpus pre-embedded, a 12-question run across three strategies costs
roughly **$0.01** and takes about a minute. The one-time seed costs about
**$0.09** and takes around six minutes.

The dashboard breaks cost down per pipeline stage — embedding, query transform,
reranking, graph, answer, judge — because the interesting question is not "what
did this cost" but "did the retrieval improvement justify the extra spend".
