// Mirrors backend/src/common/types.ts and experiments/experiment.types.ts.

export type StrategyId = 'baseline' | 'advanced' | 'advanced-pro' | 'graphrag';

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

export type ExperimentStatus =
  'created' | 'indexing' | 'ready' | 'evaluating' | 'complete' | 'failed' | 'cancelled';

export type UsageStage =
  'embedding' | 'query-transform' | 'rerank' | 'graph' | 'answer' | 'judge' | 'dataset-generation';

export interface StrategyDescriptor {
  id: StrategyId;
  label: string;
  description: string;
  capabilities: string[];
  chunkProfile: string;
}

export interface PublicLimits {
  maxFileSizeBytes: number;
  maxKbChars: number;
  maxQuestions: number;
  defaultQuestionCount: number;
  maxStrategiesPerRun: number;
  maxContextChunks: number;
  maxOutputTokens: number;
  maxGeneratedQuestions: number;
  maxRunsPerDay: number;
  maxUploadsPerDay: number;
  maxDatasetGenerationsPerDay: number;
  acceptedExtensions: string[];
}

export interface QuotaStatus {
  action: 'run' | 'upload' | 'generate';
  used: number;
  limit: number;
  remaining: number;
  resetsAt: number;
}

export interface MetaResponse {
  strategies: StrategyDescriptor[];
  limits: PublicLimits;
  quotas: QuotaStatus[];
  defaultKnowledgeBase: {
    label: string;
    documentCount: number;
    totalChars: number;
    categories: Array<{ name: string; documents: number }>;
    preEmbedded: boolean;
    fingerprint: string;
    stale: boolean;
  } | null;
  defaultDataset: {
    questionCount: number;
    byType: Array<{ questionType: QuestionType; count: number }>;
  } | null;
  pgvector: {
    available: boolean;
    manifest: {
      documentCount: number;
      totalChars: number;
      corpusFingerprint: string;
      embeddingModel: string;
      seededAt: string;
    } | null;
    coverage: Array<{ strategy: StrategyId; chunkCount: number }>;
  };
  activeRuns: number;
}

export interface KnowledgeBaseInfo {
  source: 'default' | 'upload';
  label: string;
  documentCount: number;
  totalChars: number;
  originalChars: number;
  trimmed: boolean;
  notice?: string;
  categories: Array<{ name: string; documents: number }>;
  preEmbedded: boolean;
}

export interface DatasetInfo {
  source: 'default' | 'upload' | 'paste' | 'generated';
  questionCount: number;
  byType: Array<{ questionType: string; count: number }>;
  /** The submitted set was cut down to fit the per-run question limit. */
  truncated: boolean;
  /** Total questions the source held, when it is a set the user sampled from. */
  available?: number;
  skipped: Array<{ line: number; reason: string }>;
}

export interface EvaluationItem {
  id: string;
  question: string;
  referenceAnswer: string;
  expectedKeywords: string[];
  questionType: QuestionType;
  goldChunkIds?: string[];
}

export interface Experiment {
  id: string;
  status: ExperimentStatus;
  strategies: StrategyId[];
  knowledgeBase: KnowledgeBaseInfo | null;
  dataset: DatasetInfo | null;
  createdAt: number;
  error?: string;
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
  query?: string;
}

export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  category: string;
  ordinal: number;
  text: string;
  embedText: string;
  headingPath: string[];
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}

export interface RetrievedChunk {
  chunk: Chunk;
  score: number;
  provenance: RetrievalProvenance[];
  rank: number;
}

export interface TraceStep {
  name: string;
  detail?: string;
  candidates?: number;
  latencyMs: number;
}

export interface RetrievalTrace {
  strategy: StrategyId;
  steps: TraceStep[];
  queries: string[];
  routedAs?: string;
  latencyMs: number;
}

// ── Results ──────────────────────────────────────────────────────────────────

export interface RetrievalMetrics {
  reciprocalRank: number;
  ndcg: number;
  recall: number;
  precision: number;
  hitRate: number;
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
  answerKeywordCoverage: number;
  referenceSimilarity: number;
  verdict: 'pass' | 'partial' | 'fail';
  judgeReasoning: string;
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
  relevanceLabels: Record<string, number>;
  retrieval: RetrievalMetrics;
  answer: AnswerMetrics;
  usage: UsageTotals;
  latency: LatencyBreakdown;
  trace: RetrievalTrace;
  error?: string;
}

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
  indexBytes: number;
  graph?: { entities: number; relationships: number; communities: number; levels: number };
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

export interface StrategySummary {
  strategy: StrategyId;
  label: string;
  questionCount: number;
  failures: number;
  retrieval: Record<keyof RetrievalMetrics, number>;
  answer: Record<Exclude<keyof AnswerMetrics, 'verdict' | 'judgeReasoning'>, number>;
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

// ── SSE events ───────────────────────────────────────────────────────────────

export type EvaluationEvent =
  | { type: 'status'; status: ExperimentStatus; message: string; at: number }
  | { type: 'indexing'; strategy: StrategyId; message: string; at: number }
  | {
      type: 'indexed';
      strategy: StrategyId;
      chunkCount: number;
      indexingMs: number;
      fromCache: boolean;
      graph?: { entities: number; relationships: number; communities: number; levels: number };
      at: number;
    }
  | {
      type: 'progress';
      strategy: StrategyId;
      completed: number;
      total: number;
      overallCompleted: number;
      overallTotal: number;
      currentQuestion: string;
      at: number;
    }
  | { type: 'question'; strategy: StrategyId; result: QuestionResult; at: number }
  | { type: 'strategy-complete'; strategy: StrategyId; summary: StrategySummary; at: number }
  | {
      type: 'complete';
      summaries: StrategySummary[];
      totalCostUsd: number;
      durationMs: number;
      at: number;
    }
  | { type: 'error'; message: string; strategy?: StrategyId; at: number };
