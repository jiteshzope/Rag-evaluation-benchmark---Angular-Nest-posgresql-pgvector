import { Injectable } from '@nestjs/common';

import { Chunk, RetrievalResult, RetrievedChunk, StrategyId } from '../../common/types';
import { MAX_CONTEXT_CHUNKS, RETRIEVAL_CANDIDATE_POOL } from '../../config/limits';
import { ChunkProfile, ChunkingService } from '../../ingestion/chunking.service';
import { estimateTokens } from '../../ingestion/text-utils';
import { OpenAiService } from '../../llm/openai.service';
import { Bm25Index } from '../bm25';
import { RankedList, dedupe, reciprocalRankFusion, renumber } from '../fusion';
import {
  IngestOptions,
  RagStrategy,
  RetrieveOptions,
  StrategyContext,
  TraceBuilder,
} from '../rag-strategy.interface';
import { QueryRoute, QueryTransformService } from '../query-transform.service';
import { RerankerService } from '../reranker.service';
import { UsageTracker } from '../../llm/usage-tracker';
import { VectorIndex } from '../vector-index';
import { average, embedChunks } from '../baseline/baseline-rag.service';
import { ContextualizerService } from './contextualizer.service';

export interface AdvancedProIndex {
  vector: VectorIndex;
  bm25: Bm25Index;
  /** docId -> chunks in document order, for parent/neighbour expansion. */
  byDocument: Map<string, Chunk[]>;
}

/**
 * Advanced-Pro RAG — adaptive, contextual retrieval.
 *
 *                          question
 *                             |
 *                     query classifier
 *          specific  /        |         \  broad
 *                   /      multi_hop     \
 *          narrow search   decompose    wide multi-query
 *                   \         |         /
 *                    multi-query hybrid search (dense + BM25)
 *                             |
 *                    Reciprocal Rank Fusion
 *                             |
 *                        LLM rerank
 *                             |
 *                 parent / neighbour expansion
 *                             |
 *                     context compression
 *                             |
 *                        answer LLM
 *
 * Two ideas do the heavy lifting:
 *
 * 1. Contextual chunk enrichment at ingest (see ContextualizerService) — the
 *    retrieval representation carries document context the raw chunk lacks.
 * 2. Adaptive routing at query time — a question asking for one salary and a
 *    question asking for themes across the whole corpus should not get the same
 *    retrieval behaviour. Because the dataset is tagged by question type, the
 *    dashboard can show exactly which types this pays off for.
 */
@Injectable()
export class AdvancedProRagService implements RagStrategy {
  readonly id: StrategyId = 'advanced-pro';
  readonly label = 'Advanced-Pro Adaptive';
  readonly description =
    'Contextual chunk enrichment, adaptive routing, query decomposition, multi-query hybrid search, reranking, parent expansion and context compression.';
  readonly capabilities = [
    'Contextual chunk enrichment',
    'Adaptive query routing',
    'Query decomposition',
    'Multi-query hybrid search',
    'Reciprocal Rank Fusion',
    'LLM reranking',
    'Parent/neighbour expansion',
    'Context compression',
    'Dynamic top-K',
  ];
  readonly chunkProfile: ChunkProfile = 'contextual';

  constructor(
    private readonly chunking: ChunkingService,
    private readonly openai: OpenAiService,
    private readonly queryTransform: QueryTransformService,
    private readonly reranker: RerankerService,
    private readonly contextualizer: ContextualizerService,
  ) {}

  async ingest(options: IngestOptions): Promise<StrategyContext> {
    const startedAt = Date.now();
    const base = this.chunking.chunkAll(options.documents, this.chunkProfile);

    options.onProgress?.(`Contextualising ${base.length} chunks`);
    const chunks = await this.contextualizer.contextualize(
      base,
      options.documents,
      options.tracker,
      options.cachedContexts,
    );

    options.onProgress?.(`Embedding ${chunks.length} contextualised chunks`);
    const embedded = await embedChunks(this.openai, chunks, options);

    const byDocument = new Map<string, Chunk[]>();
    for (const c of chunks) {
      const list = byDocument.get(c.docId) ?? [];
      list.push(c);
      byDocument.set(c.docId, list);
    }
    for (const list of byDocument.values()) list.sort((a, b) => a.ordinal - b.ordinal);

    const index: AdvancedProIndex = {
      vector: VectorIndex.from(embedded),
      bm25: Bm25Index.from(chunks),
      byDocument,
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
    const index = options.context.index as AdvancedProIndex;
    const { question, tracker } = options;

    // 1. Route.
    const route = await this.queryTransform.route(question, tracker);
    trace.step('Classify query', `${route.category}, k=${route.suggestedK}`);

    // 2. Expand into sub-queries according to the route.
    const queries = await this.buildQueries(question, route, tracker, trace);

    // 3. Hybrid search across every sub-query.
    const queryVectors = await this.openai.embed(queries, tracker);
    trace.step('Embed queries', `${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);

    const pool = route.category === 'broad' ? RETRIEVAL_CANDIDATE_POOL : Math.ceil(RETRIEVAL_CANDIDATE_POOL * 0.75);
    const lists: RankedList[] = [];
    queries.forEach((q, i) => {
      // The original question is weighted highest; rewrites are support.
      const weight = i === 0 ? 1.25 : 1;
      lists.push({ source: 'dense', results: index.vector.search(queryVectors[i], pool), query: q, weight });
      lists.push({ source: 'bm25', results: index.bm25.search(q, pool), query: q, weight });
    });
    trace.step('Multi-query hybrid search', `dense + BM25, pool=${pool}`,
      lists.reduce((sum, l) => sum + l.results.length, 0));

    const fused = reciprocalRankFusion(lists).slice(0, RETRIEVAL_CANDIDATE_POOL);
    trace.step('Reciprocal Rank Fusion', 'k=60', fused.length);

    // 4. Dynamic top-K: a broad question needs more evidence than a lookup.
    const dynamicK = Math.min(
      MAX_CONTEXT_CHUNKS,
      route.category === 'broad' ? MAX_CONTEXT_CHUNKS : route.suggestedK,
    );

    const reranked = await this.reranker.rerank(question, fused, dynamicK, tracker);
    trace.step('LLM rerank', `${fused.length} -> ${reranked.length}`, reranked.length);

    // 5. Parent/neighbour expansion, then compression back to the budget.
    const expanded = this.expandNeighbours(reranked, index, dynamicK);
    trace.step('Parent expansion', `${reranked.length} -> ${expanded.length}`, expanded.length);

    const compressed = this.compress(expanded, dynamicK);
    trace.step('Context compression', `kept ${compressed.length} of ${expanded.length}`, compressed.length);

    return {
      chunks: compressed,
      trace: trace.build(this.id, queries, route.category),
    };
  }

  private async buildQueries(
    question: string,
    route: QueryRoute,
    tracker: UsageTracker,
    trace: TraceBuilder,
  ): Promise<string[]> {
    if (route.category === 'multi_hop' || route.needsDecomposition) {
      const parts = await this.queryTransform.decompose(question, tracker);
      trace.step('Decompose', `${parts.length} sub-question(s)`);
      return dedupeStrings([question, ...parts]);
    }

    if (route.category === 'broad') {
      const variants = await this.queryTransform.multiQuery(question, tracker);
      trace.step('Multi-query expansion', `${variants.length} variant(s)`);
      return dedupeStrings(variants);
    }

    const rewritten = await this.queryTransform.rewrite(question, tracker);
    trace.step('Query rewrite', rewritten === question ? 'unchanged' : rewritten);
    return dedupeStrings([question, rewritten]);
  }

  /**
   * Pull in the chunk immediately before/after each top hit from the same
   * document. Recovers facts that fall just across a chunk boundary — the
   * classic small-chunk failure mode.
   */
  private expandNeighbours(
    ranked: RetrievedChunk[],
    index: AdvancedProIndex,
    limit: number,
  ): RetrievedChunk[] {
    const present = new Set(ranked.map((r) => r.chunk.id));
    const out: RetrievedChunk[] = [...ranked];

    for (const hit of ranked.slice(0, Math.min(2, limit))) {
      const siblings = index.byDocument.get(hit.chunk.docId) ?? [];
      const pos = siblings.findIndex((c) => c.id === hit.chunk.id);
      if (pos < 0) continue;

      for (const neighbour of [siblings[pos - 1], siblings[pos + 1]]) {
        if (!neighbour || present.has(neighbour.id)) continue;
        present.add(neighbour.id);
        out.push({
          chunk: neighbour,
          // Neighbours inherit a fraction of the parent's score so they sort
          // just below it rather than displacing a genuine hit.
          score: hit.score * 0.5,
          provenance: [{ source: 'parent-expansion', score: hit.score * 0.5 }],
          rank: out.length + 1,
        });
      }
    }

    return renumber(dedupe(out));
  }

  /**
   * Context compression: keep the highest-scoring chunks up to the budget and
   * drop near-duplicates, so the answering prompt spends its tokens on distinct
   * evidence rather than three copies of the same paragraph.
   */
  private compress(chunks: RetrievedChunk[], limit: number): RetrievedChunk[] {
    const kept: RetrievedChunk[] = [];
    const seenPrefixes = new Set<string>();

    for (const c of [...chunks].sort((a, b) => b.score - a.score)) {
      if (kept.length >= limit) break;

      // A cheap near-duplicate signal: identical opening 120 characters.
      const fingerprint = c.chunk.text.slice(0, 120).toLowerCase().replace(/\s+/g, ' ');
      if (seenPrefixes.has(fingerprint)) continue;
      seenPrefixes.add(fingerprint);

      kept.push({
        ...c,
        provenance: [...c.provenance, { source: 'compression' as const }],
      });
    }

    return renumber(kept);
  }
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}
