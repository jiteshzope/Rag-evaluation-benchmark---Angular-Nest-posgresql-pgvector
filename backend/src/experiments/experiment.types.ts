import { Subject } from 'rxjs';

import {
  EvaluationItem,
  QuestionResult,
  SourceDocument,
  StrategyId,
  StrategySummary,
} from '../common/types';

export type ExperimentStatus =
  | 'created'
  | 'indexing'
  | 'ready'
  | 'evaluating'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type KnowledgeBaseSource = 'default' | 'upload';
export type DatasetSource = 'default' | 'upload' | 'paste' | 'generated';

export interface KnowledgeBaseInfo {
  source: KnowledgeBaseSource;
  label: string;
  documentCount: number;
  totalChars: number;
  originalChars: number;
  trimmed: boolean;
  notice?: string;
  categories: Array<{ name: string; documents: number }>;
  /** True when vectors are served pre-embedded from pgvector. */
  preEmbedded: boolean;
}

export interface DatasetInfo {
  source: DatasetSource;
  questionCount: number;
  byType: Array<{ questionType: string; count: number }>;
  /** The submitted set was cut down to fit MAX_QUESTIONS. */
  truncated: boolean;
  /** Total questions the source held, when it is a set the user sampled from. */
  available?: number;
  skipped: Array<{ line: number; reason: string }>;
}

/**
 * All state for one experiment, held in memory only.
 *
 * Nothing here is persisted. When the experiment is evicted (TTL or capacity)
 * the documents, chunks, vectors and results are dropped with it — an uploaded
 * knowledge base never outlives the session that sent it.
 */
export interface ExperimentContext {
  id: string;
  createdAt: number;
  lastTouchedAt: number;
  status: ExperimentStatus;

  strategies: StrategyId[];
  documents: SourceDocument[];
  knowledgeBase: KnowledgeBaseInfo | null;
  dataset: EvaluationItem[];
  datasetInfo: DatasetInfo | null;

  /** Populated as the run proceeds. */
  results: Map<StrategyId, QuestionResult[]>;
  summaries: Map<StrategyId, StrategySummary>;

  error?: string;
  startedAt?: number;
  finishedAt?: number;

  /** Live event stream for SSE subscribers. */
  events: Subject<EvaluationEvent>;
  /** Replay buffer so a client that connects late still sees prior events. */
  eventLog: EvaluationEvent[];
  cancelled: boolean;
}

// ── SSE event contract ──────────────────────────────────────────────────────

export type EvaluationEvent =
  | { type: 'status'; status: ExperimentStatus; message: string; at: number }
  | {
      type: 'indexing';
      strategy: StrategyId;
      message: string;
      at: number;
    }
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
  | {
      type: 'question';
      strategy: StrategyId;
      result: QuestionResult;
      at: number;
    }
  | {
      type: 'strategy-complete';
      strategy: StrategyId;
      summary: StrategySummary;
      at: number;
    }
  | {
      type: 'complete';
      summaries: StrategySummary[];
      totalCostUsd: number;
      durationMs: number;
      at: number;
    }
  | { type: 'error'; message: string; strategy?: StrategyId; at: number };
