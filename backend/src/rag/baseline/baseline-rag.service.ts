import { Injectable } from '@nestjs/common';

import { Chunk, EmbeddedChunk, RetrievalResult, StrategyId } from '../../common/types';
import { ChunkProfile, ChunkingService } from '../../ingestion/chunking.service';
import { OpenAiService } from '../../llm/openai.service';
import { toRetrieved } from '../fusion';
import {
  IngestOptions,
  RagStrategy,
  RetrieveOptions,
  StrategyContext,
  TraceBuilder,
} from '../rag-strategy.interface';
import { VectorIndex } from '../vector-index';
import { estimateTokens } from '../../ingestion/text-utils';

/**
 * Baseline RAG — the control group.
 *
 * Fixed-size chunks, one dense embedding each, single-vector similarity search,
 * top-k straight to the answering LLM. No rewriting, no lexical channel, no
 * fusion, no reranking.
 *
 * Its job is to be a fair, honest floor. Every gain the other strategies show is
 * measured against this, so it is implemented properly rather than hobbled.
 */
@Injectable()
export class BaselineRagService implements RagStrategy {
  readonly id: StrategyId = 'baseline';
  readonly label = 'Baseline';
  readonly description = 'Fixed chunks, dense vector search, top-k. The control group.';
  readonly capabilities = ['Fixed-size chunking', 'Dense vector search', 'Top-K retrieval'];
  readonly chunkProfile: ChunkProfile = 'fixed';

  constructor(
    private readonly chunking: ChunkingService,
    private readonly openai: OpenAiService,
  ) {}

  async ingest(options: IngestOptions): Promise<StrategyContext> {
    const startedAt = Date.now();
    const chunks = this.chunking.chunkAll(options.documents, this.chunkProfile);

    options.onProgress?.(`Embedding ${chunks.length} chunks`);
    const embedded = await embedChunks(this.openai, chunks, options);
    const index = VectorIndex.from(embedded);

    const embeddingTokens = options.cachedEmbeddings
      ? 0
      : chunks.reduce((sum, c) => sum + estimateTokens(c.embedText), 0);

    return {
      strategy: this.id,
      chunks,
      index,
      stats: {
        chunkCount: chunks.length,
        avgChunkTokens: average(chunks.map((c) => c.tokenEstimate)),
        indexingMs: Date.now() - startedAt,
        embeddingTokens,
        indexBytes: index.byteSize,
        fromCache: Boolean(options.cachedEmbeddings),
      },
    };
  }

  async retrieve(options: RetrieveOptions): Promise<RetrievalResult> {
    const trace = new TraceBuilder();
    const index = options.context.index as VectorIndex;

    const queryVector = await this.openai.embedOne(options.question, options.tracker);
    trace.step('Embed query', 'text-embedding-3-small');

    const hits = index.search(queryVector, options.topK);
    trace.step('Dense vector search', `top-${options.topK} by cosine`, hits.length);

    return {
      chunks: toRetrieved(hits, 'dense', options.question),
      trace: trace.build(this.id, [options.question]),
    };
  }
}

// ── Shared helpers used by every vector-based strategy ──────────────────────

/**
 * Embeds chunks, or reuses pre-embedded vectors from pgvector when the default
 * knowledge base is in play. Any chunk missing from the cache is embedded
 * normally, so a partial cache is safe.
 */
export async function embedChunks(
  openai: OpenAiService,
  chunks: Chunk[],
  options: IngestOptions,
): Promise<EmbeddedChunk[]> {
  const cache = options.cachedEmbeddings;
  const missing: number[] = [];
  const vectors = new Array<Float32Array | undefined>(chunks.length);

  chunks.forEach((c, i) => {
    const cached = cache?.get(c.id);
    if (cached) vectors[i] = cached;
    else missing.push(i);
  });

  if (missing.length > 0) {
    const fresh = await openai.embed(
      missing.map((i) => chunks[i].embedText),
      options.tracker,
    );
    missing.forEach((chunkIndex, j) => {
      vectors[chunkIndex] = fresh[j];
    });
  }

  return chunks.map((c, i) => ({ ...c, embedding: vectors[i]! }));
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
