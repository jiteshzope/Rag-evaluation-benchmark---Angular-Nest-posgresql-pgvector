/**
 * Central guardrails.
 *
 * This is a public portfolio deployment: anonymous visitors (recruiters) can run
 * real evaluations that spend real OpenAI credit. Every limit that protects the
 * budget lives here so the blast radius of a change is one file.
 *
 * Sizing target: ~6-7 full recruiter interactions per day per visitor.
 */

/** Hard multipart limit. Anything larger is rejected before it reaches disk. */
export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB

/**
 * After text extraction the knowledge base is trimmed to this many characters.
 * 1 MB of PDF/DOCX is far more prose than the demo corpus (~310k chars), so the
 * trim keeps embedding + graph-extraction cost bounded. The user is always told
 * when a trim happened.
 */
export const MAX_KB_CHARS = 240_000; // ~60k tokens

/** Uploaded files must extract at least this much text to be worth indexing. */
export const MIN_KB_CHARS = 500;

/** Maximum evaluation questions per run (applies to uploaded AND default sets). */
export const MAX_QUESTIONS = 100;

/** Default question count pre-selected in the UI — keeps a casual run cheap. */
export const DEFAULT_QUESTION_COUNT = 20;

/** Strategies that may be benchmarked in a single run. */
export const MAX_STRATEGIES_PER_RUN = 3;

/** Chunks handed to the answering LLM. Also the K in nDCG@K / Recall@K / etc. */
export const MAX_CONTEXT_CHUNKS = 5;

/** Retrieval depth before fusion/reranking narrows down to MAX_CONTEXT_CHUNKS. */
export const RETRIEVAL_CANDIDATE_POOL = 20;

/** Output token ceilings, per LLM role. */
export const MAX_OUTPUT_TOKENS = 500; // answering LLM
export const MAX_JUDGE_OUTPUT_TOKENS = 700;
export const MAX_UTILITY_OUTPUT_TOKENS = 300; // rewrite / decompose / classify
export const MAX_SUMMARY_OUTPUT_TOKENS = 400; // graph community summaries
/** Entity extraction emits a whole JSON graph fragment, so it needs real headroom;
  * a truncated response fails to parse and loses the entire batch. */
export const MAX_GRAPH_EXTRACTION_OUTPUT_TOKENS = 3000;

/** Characters of a single chunk ever sent to a model (guards pathological chunks). */
export const MAX_CHUNK_CHARS_IN_PROMPT = 4_000;

/** Auto-generated dataset ceiling. */
export const MAX_GENERATED_QUESTIONS = 40;

/**
 * LLM-enrichment ceilings for *uploaded* corpora. The default knowledge base is
 * enriched once, offline, by the seed script and read back from pgvector, so these
 * only bound what an anonymous upload can trigger.
 */
export const MAX_CONTEXTUALIZED_CHUNKS = 120; // Anthropic-style contextual retrieval
export const MAX_GRAPH_EXTRACTION_UNITS = 60; // text units sent to entity extraction
export const GRAPH_EXTRACTION_BATCH_SIZE = 3; // text units per extraction call
export const MAX_GRAPH_COMMUNITY_SUMMARIES = 30;

/** Concurrency — keeps us under OpenAI rate limits without serialising the run. */
export const EMBEDDING_BATCH_SIZE = 96;
export const LLM_CONCURRENCY = 4;
export const QUESTION_CONCURRENCY = 3;

/** Per-visitor (per-IP) daily quota. */
export const MAX_RUNS_PER_DAY = 7;
export const MAX_UPLOADS_PER_DAY = 7;
export const MAX_DATASET_GENERATIONS_PER_DAY = 3;
export const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Hard stop on concurrent in-flight runs process-wide. */
export const MAX_CONCURRENT_RUNS = 2;

/** In-memory experiments are dropped after this long to bound RSS. */
export const EXPERIMENT_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_LIVE_EXPERIMENTS = 25;

/** Accepted upload types — text is extracted, nothing else is retained. */
export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
] as const;

export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'] as const;

/**
 * Public shape of the limits, surfaced at GET /limits so the frontend can render
 * the same numbers it enforces client-side. Single source of truth.
 */
export const PUBLIC_LIMITS = {
  maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
  maxKbChars: MAX_KB_CHARS,
  maxQuestions: MAX_QUESTIONS,
  defaultQuestionCount: DEFAULT_QUESTION_COUNT,
  maxStrategiesPerRun: MAX_STRATEGIES_PER_RUN,
  maxContextChunks: MAX_CONTEXT_CHUNKS,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  maxGeneratedQuestions: MAX_GENERATED_QUESTIONS,
  maxRunsPerDay: MAX_RUNS_PER_DAY,
  maxUploadsPerDay: MAX_UPLOADS_PER_DAY,
  maxDatasetGenerationsPerDay: MAX_DATASET_GENERATIONS_PER_DAY,
  acceptedExtensions: ACCEPTED_EXTENSIONS,
} as const;

export type PublicLimits = typeof PUBLIC_LIMITS;
