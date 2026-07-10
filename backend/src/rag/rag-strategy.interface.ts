import { Chunk, IndexingStats, RetrievalResult, SourceDocument, StrategyId } from '../common/types';
import { UsageTracker } from '../llm/usage-tracker';
import { ChunkProfile } from '../ingestion/chunking.service';

/**
 * Per-run state a strategy builds during ingestion and reads during retrieval.
 *
 * Kept out of the service instances deliberately: the services are Nest
 * singletons, so holding index state on `this` would make two concurrent runs
 * corrupt each other. Every strategy method takes its context explicitly.
 */
export interface StrategyContext {
  strategy: StrategyId;
  chunks: Chunk[];
  stats: IndexingStats;
  /** Strategy-specific index payload (vector index, bm25, graph, ...). */
  index: unknown;
}

export interface IngestOptions {
  documents: SourceDocument[];
  tracker: UsageTracker;
  /**
   * Pre-embedded vectors keyed by chunk id, read from pgvector for the default
   * knowledge base. When present the strategy must not call the embeddings API.
   */
  cachedEmbeddings?: Map<string, Float32Array>;
  /** Pre-computed LLM context headers keyed by chunk id (advanced-pro). */
  cachedContexts?: Map<string, string>;
  /** Serialised graph payload from pgvector (graphrag). */
  cachedGraph?: unknown;
  onProgress?: (message: string) => void;
}

export interface RetrieveOptions {
  question: string;
  topK: number;
  tracker: UsageTracker;
  context: StrategyContext;
}

/**
 * The abstraction the evaluation orchestrator programs against. It never learns
 * how a strategy retrieves — only that it can ingest and return ranked chunks.
 */
export interface RagStrategy {
  readonly id: StrategyId;
  readonly label: string;
  readonly description: string;
  /** Capability flags rendered on the strategy cards in the UI. */
  readonly capabilities: string[];
  readonly chunkProfile: ChunkProfile;

  ingest(options: IngestOptions): Promise<StrategyContext>;
  retrieve(options: RetrieveOptions): Promise<RetrievalResult>;
}

/** Convenience for building the trace steps every strategy records. */
export class TraceBuilder {
  private readonly steps: Array<{
    name: string;
    detail?: string;
    candidates?: number;
    latencyMs: number;
  }> = [];

  private readonly startedAt = Date.now();
  private lastMark = Date.now();

  step(name: string, detail?: string, candidates?: number): void {
    const now = Date.now();
    this.steps.push({ name, detail, candidates, latencyMs: now - this.lastMark });
    this.lastMark = now;
  }

  build(strategy: StrategyId, queries: string[], routedAs?: string) {
    return {
      strategy,
      steps: this.steps,
      queries,
      routedAs,
      latencyMs: Date.now() - this.startedAt,
    };
  }
}
