// ─────────────────────────────────────────────────────────────────────────────
// Core domain types shared by ingestion, retrieval, evaluation and the API.
// ─────────────────────────────────────────────────────────────────────────────

export type StrategyId = 'baseline' | 'advanced' | 'advanced-pro' | 'graphrag';

export const ALL_STRATEGIES: StrategyId[] = ['baseline', 'advanced', 'advanced-pro', 'graphrag'];

/**
 * Question taxonomy. The first seven match the shipped default QA set; the rest
 * are accepted from uploaded/generated sets so nothing is silently dropped.
 */
export type QuestionType =
  | 'direct_fact'
  | 'temporal'
  | 'comparative'
  | 'numerical'
  | 'relationship'
  | 'spanning'
  | 'holistic'
  | 'multi_hop'
  | 'procedural'
  | 'definition'
  | 'summarization'
  | 'other';

export const KNOWN_QUESTION_TYPES: QuestionType[] = [
  'direct_fact',
  'temporal',
  'comparative',
  'numerical',
  'relationship',
  'spanning',
  'holistic',
  'multi_hop',
  'procedural',
  'definition',
  'summarization',
  'other',
];

// ── Documents & chunks ───────────────────────────────────────────────────────

export interface SourceDocument {
  id: string;
  /** Display name, e.g. "employees/Avery Lancaster.md". */
  title: string;
  /** Folder the file came from, used as coarse metadata for filtering. */
  category: string;
  text: string;
}

export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  category: string;
  /** Ordinal within the document — enables parent/neighbour expansion. */
  ordinal: number;
  /** Raw text. This is what the answering LLM sees. */
  text: string;
  /**
   * Text actually embedded. For baseline/advanced this equals `text`; for
   * advanced-pro it is the contextual header + text (contextual retrieval).
   * Keeping both lets us index enriched but answer from the original.
   */
  embedText: string;
  /** Markdown heading path, e.g. ["Avery Lancaster", "Annual Performance History"]. */
  headingPath: string[];
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}

export interface EmbeddedChunk extends Chunk {
  embedding: Float32Array;
}

// ── Retrieval ────────────────────────────────────────────────────────────────

export type RetrievalSource =
  | 'dense'
  | 'bm25'
  | 'rrf'
  | 'rerank'
  | 'graph-local'
  | 'graph-global'
  | 'graph-drift'
  | 'parent-expansion'
  | 'compression';

export interface RetrievalProvenance {
  source: RetrievalSource;
  rank?: number;
  score?: number;
  /** Which sub-query surfaced it (multi-query / decomposition). */
  query?: string;
}

export interface RetrievedChunk {
  chunk: Chunk;
  /** Final score after fusion/reranking. Comparable only within one retrieval. */
  score: number;
  /** Where this candidate came from — shown in the per-question explorer. */
  provenance: RetrievalProvenance[];
  /** 1-based rank in the final ordering. */
  rank: number;
}

export interface TraceStep {
  name: string;
  detail?: string;
  candidates?: number;
  latencyMs: number;
}

/** Everything a strategy did for one question — powers the pipeline trace UI. */
export interface RetrievalTrace {
  strategy: StrategyId;
  steps: TraceStep[];
  /** Sub-queries actually issued (original + rewrites + decompositions). */
  queries: string[];
  routedAs?: string;
  latencyMs: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  trace: RetrievalTrace;
}

// ── Evaluation dataset ───────────────────────────────────────────────────────

export interface EvaluationItem {
  id: string;
  question: string;
  referenceAnswer: string;
  expectedKeywords: string[];
  questionType: QuestionType;
  /**
   * Ground-truth chunk ids, when known (auto-generated datasets record the chunk
   * that produced the question). When absent, relevance is derived from keyword
   * evidence — see metrics/relevance-labels.ts.
   */
  goldChunkIds?: string[];
}

// ── Per-question results ─────────────────────────────────────────────────────

export interface RetrievalMetrics {
  reciprocalRank: number;
  ndcg: number;
  recall: number;
  precision: number;
  hitRate: number;
  /** Fraction of expected keywords present anywhere in the retrieved context. */
  contextKeywordCoverage: number;
  contextPrecision: number;
  contextRecall: number;
  relevantRetrieved: number;
  relevantTotal: number;
}

export interface AnswerMetrics {
  faithfulness: number;
  factualCorrectness: number;
  answerRelevance: number;
  judgeScore: number;
  /** Fraction of expected keywords present in the generated answer. */
  answerKeywordCoverage: number;
  /** Cosine similarity between generated and reference answer embeddings. */
  referenceSimilarity: number;
  verdict: 'pass' | 'partial' | 'fail';
  judgeReasoning: string;
}

export type UsageStage =
  | 'embedding'
  | 'query-transform'
  | 'rerank'
  | 'graph'
  | 'answer'
  | 'judge'
  | 'dataset-generation';

export const USAGE_STAGES: UsageStage[] = [
  'embedding',
  'query-transform',
  'rerank',
  'graph',
  'answer',
  'judge',
  'dataset-generation',
];

export interface UsageRecord {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  stage: UsageStage;
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  embeddingTokens: number;
  costUsd: number;
  costByStage: Record<UsageStage, number>;
  tokensByStage: Record<UsageStage, number>;
}

export interface LatencyBreakdown {
  retrievalMs: number;
  answerMs: number;
  judgeMs: number;
  totalMs: number;
}

export interface QuestionResult {
  itemId: string;
  strategy: StrategyId;
  question: string;
  questionType: QuestionType;
  referenceAnswer: string;
  generatedAnswer: string;
  expectedKeywords: string[];
  keywordHits: Record<string, boolean>;
  retrieved: RetrievedChunk[];
  /** Chunk ids judged relevant for this question, with graded relevance 0..1. */
  relevanceLabels: Record<string, number>;
  retrieval: RetrievalMetrics;
  answer: AnswerMetrics;
  usage: UsageTotals;
  latency: LatencyBreakdown;
  trace: RetrievalTrace;
  error?: string;
}

// ── Aggregates ───────────────────────────────────────────────────────────────

export interface MetricAggregate {
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  stdDev: number;
  count: number;
}

export interface IndexingStats {
  chunkCount: number;
  avgChunkTokens: number;
  indexingMs: number;
  embeddingTokens: number;
  /** Rough in-memory footprint of the index in bytes. */
  indexBytes: number;
  /** GraphRAG only. */
  graph?: { entities: number; relationships: number; communities: number; levels: number };
  /** True when vectors came pre-embedded out of pgvector instead of the API. */
  fromCache: boolean;
}

export interface QuestionTypeSummary {
  questionType: QuestionType;
  count: number;
  mrr: number;
  ndcg: number;
  recall: number;
  precision: number;
  hitRate: number;
  contextKeywordCoverage: number;
  contextPrecision: number;
  contextRecall: number;
  faithfulness: number;
  factualCorrectness: number;
  answerRelevance: number;
  judgeScore: number;
  answerKeywordCoverage: number;
  referenceSimilarity: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCostUsd: number;
  avgLatencyMs: number;
}

export type RetrievalMetricAverages = Record<keyof RetrievalMetrics, number>;
export type AnswerMetricAverages = Record<
  Exclude<keyof AnswerMetrics, 'verdict' | 'judgeReasoning'>,
  number
>;

export interface StrategySummary {
  strategy: StrategyId;
  label: string;
  questionCount: number;
  failures: number;

  retrieval: RetrievalMetricAverages;
  answer: AnswerMetricAverages;

  /** Weighted blend of retrieval + answer quality, penalised by failures. */
  compositeScore: number;

  usage: UsageTotals;
  usagePerQuestion: UsageTotals;

  latency: {
    retrieval: MetricAggregate;
    answer: MetricAggregate;
    judge: MetricAggregate;
    total: MetricAggregate;
  };

  byQuestionType: QuestionTypeSummary[];
  verdicts: { pass: number; partial: number; fail: number };
  indexing: IndexingStats;
}
