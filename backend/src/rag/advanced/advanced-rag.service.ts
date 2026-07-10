import { Injectable } from '@nestjs/common';

import { RetrievalResult, StrategyId } from '../../common/types';
import { RETRIEVAL_CANDIDATE_POOL } from '../../config/limits';
import { ChunkProfile, ChunkingService } from '../../ingestion/chunking.service';
import { estimateTokens } from '../../ingestion/text-utils';
import { OpenAiService } from '../../llm/openai.service';
import { Bm25Index } from '../bm25';
import { RankedList, reciprocalRankFusion } from '../fusion';
import {
  IngestOptions,
  RagStrategy,
  RetrieveOptions,
  StrategyContext,
  TraceBuilder,
} from '../rag-strategy.interface';
import { RerankerService } from '../reranker.service';
import { QueryTransformService } from '../query-transform.service';
import { VectorIndex } from '../vector-index';
import { average, embedChunks } from '../baseline/baseline-rag.service';

export interface AdvancedIndex {
  vector: VectorIndex;
  bm25: Bm25Index;
}

/**
 * Advanced RAG — hybrid retrieval with fusion and reranking.
 *
 *   question
 *      -> query rewrite (kept alongside the original)
 *      -> dense search  +  BM25 search        (both queries, both channels)
 *      -> Reciprocal Rank Fusion              -> wide candidate pool
 *      -> LLM cross-encoder rerank            -> precise top-k
 *
 * Structure-aware chunking replaces the baseline's fixed windows, so a chunk no
 * longer straddles two unrelated sections.
 */
@Injectable()
export class AdvancedRagService implements RagStrategy {
  readonly id: StrategyId = 'advanced';
  readonly label = 'Advanced Hybrid';
  readonly description =
    'Structure-aware chunks, query rewriting, dense + BM25 hybrid search fused with RRF, then LLM reranking.';
  readonly capabilities = [
    'Structure-aware chunking',
    'Query rewriting',
    'Dense + BM25 hybrid',
    'Reciprocal Rank Fusion',
    'LLM reranking',
  ];
  readonly chunkProfile: ChunkProfile = 'structural';

  constructor(
    private readonly chunking: ChunkingService,
    private readonly openai: OpenAiService,
    private readonly queryTransform: QueryTransformService,
    private readonly reranker: RerankerService,
  ) {}

  async ingest(options: IngestOptions): Promise<StrategyContext> {
    const startedAt = Date.now();
    const chunks = this.chunking.chunkAll(options.documents, this.chunkProfile);

    options.onProgress?.(`Embedding ${chunks.length} chunks and building BM25 index`);
    const embedded = await embedChunks(this.openai, chunks, options);

    const index: AdvancedIndex = {
      vector: VectorIndex.from(embedded),
      bm25: Bm25Index.from(chunks),
    };

    return {
      strategy: this.id,
      chunks,
      index,
      stats: {
        chunkCount: chunks.length,
        avgChunkTokens: average(chunks.map((c) => c.tokenEstimate)),
        indexingMs: Date.now() - startedAt,
        embeddingTokens: options.cachedEmbeddings
          ? 0
          : chunks.reduce((sum, c) => sum + estimateTokens(c.embedText), 0),
        indexBytes: index.vector.byteSize,
        fromCache: Boolean(options.cachedEmbeddings),
      },
    };
  }

  async retrieve(options: RetrieveOptions): Promise<RetrievalResult> {
    const trace = new TraceBuilder();
    const { vector, bm25 } = options.context.index as AdvancedIndex;
    const { question, topK, tracker } = options;

    const rewritten = await this.queryTransform.rewrite(question, tracker);
    const queries = rewritten === question ? [question] : [question, rewritten];
    trace.step('Query rewrite', rewritten === question ? 'unchanged' : rewritten);

    // Embed every query in one batched call rather than one call per query.
    const queryVectors = await this.openai.embed(queries, tracker);
    trace.step('Embed queries', `${queries.length} variant(s)`);

    const lists: RankedList[] = [];
    queries.forEach((q, i) => {
      lists.push({
        source: 'dense',
        results: vector.search(queryVectors[i], RETRIEVAL_CANDIDATE_POOL),
        query: q,
      });
      lists.push({
        source: 'bm25',
        results: bm25.search(q, RETRIEVAL_CANDIDATE_POOL),
        query: q,
      });
    });
    trace.step(
      'Hybrid search',
      `dense + BM25 over ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`,
      lists.reduce((sum, l) => sum + l.results.length, 0),
    );

    const fused = reciprocalRankFusion(lists).slice(0, RETRIEVAL_CANDIDATE_POOL);
    trace.step('Reciprocal Rank Fusion', `k=60`, fused.length);

    const reranked = await this.reranker.rerank(question, fused, topK, tracker);
    trace.step('LLM rerank', `${fused.length} -> ${reranked.length}`, reranked.length);

    return { chunks: reranked, trace: trace.build(this.id, queries) };
  }
}
