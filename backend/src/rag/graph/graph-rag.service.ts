import { Injectable, Logger } from '@nestjs/common';

import { Chunk, RetrievalResult, RetrievedChunk, StrategyId } from '../../common/types';
import {
  LLM_CONCURRENCY,
  MAX_UTILITY_OUTPUT_TOKENS,
  RETRIEVAL_CANDIDATE_POOL,
} from '../../config/limits';
import { AppConfig } from '../../config/app-config';
import { ChunkProfile, ChunkingService } from '../../ingestion/chunking.service';
import { OpenAiService } from '../../llm/openai.service';
import { UsageTracker } from '../../llm/usage-tracker';
import { cosineSimilarity, estimateTokens, mapWithConcurrency } from '../../ingestion/text-utils';
import { Bm25Index } from '../bm25';
import { RankedList, dedupe, reciprocalRankFusion, renumber } from '../fusion';
import {
  IngestOptions,
  RagStrategy,
  RetrieveOptions,
  StrategyContext,
  TraceBuilder,
} from '../rag-strategy.interface';
import { QueryTransformService } from '../query-transform.service';
import { VectorIndex } from '../vector-index';
import { average, embedChunks } from '../baseline/baseline-rag.service';
import { GraphBuilderService } from './graph-builder.service';
import { GLOBAL_MAP_SCHEMA, GLOBAL_MAP_SYSTEM_PROMPT, buildGlobalMapPrompt } from './graph-prompts';
import { GraphCommunity, GraphEntity, KnowledgeGraph, SerializedGraph } from './graph.types';

export interface GraphIndex {
  vector: VectorIndex;
  bm25: Bm25Index;
  graph: KnowledgeGraph;
}

export type GraphSearchMode = 'basic' | 'local' | 'global' | 'drift';

/** How many communities the global map step reads. */
const GLOBAL_COMMUNITY_FANOUT = 6;
/** Entities used as anchors in local search. */
const LOCAL_ANCHOR_ENTITIES = 6;

/**
 * GraphRAG — retrieval over an entity/relationship/community graph.
 *
 * This is not "advanced-pro with more steps". It answers a different question
 * shape. Top-k vector retrieval fundamentally cannot answer "what themes run
 * across all 76 documents?", because no single chunk contains the answer — the
 * answer is a property of the corpus. GraphRAG builds that structure at index
 * time and queries it.
 *
 * Four search modes, matching Microsoft's GraphRAG:
 *
 *  basic   Plain vector search over text units. The fallback.
 *  local   Anchor on the entities named in the question, walk to their graph
 *          neighbours, and gather the text units those entities came from.
 *          Best for "what do we know about X and its connections?".
 *  global  Map-reduce over community summaries: ask each relevant community
 *          what it contributes, then fuse. Best for corpus-wide questions.
 *  drift   Start from community summaries for orientation (the "primer"), then
 *          follow up with local search on the entities that surfaced. Combines
 *          global breadth with local precision.
 *
 * The mode is chosen per question by the router, so the dashboard can show
 * which question types graph retrieval actually helps.
 */
@Injectable()
export class GraphRagService implements RagStrategy {
  private readonly logger = new Logger(GraphRagService.name);

  readonly id: StrategyId = 'graphrag';
  readonly label = 'GraphRAG';
  readonly description =
    'Extracts an entity/relationship graph, detects communities with Louvain, summarises them, then answers with local, global or DRIFT search.';
  readonly capabilities = [
    'Entity + relationship extraction',
    'Louvain community detection',
    'Community summarisation',
    'Local search (entity neighbourhood)',
    'Global search (map-reduce over communities)',
    'DRIFT search (primer then follow-up)',
    'Adaptive mode routing',
  ];
  readonly chunkProfile: ChunkProfile = 'structural';

  constructor(
    private readonly chunking: ChunkingService,
    private readonly openai: OpenAiService,
    private readonly config: AppConfig,
    private readonly graphBuilder: GraphBuilderService,
    private readonly queryTransform: QueryTransformService,
  ) {}

  async ingest(options: IngestOptions): Promise<StrategyContext> {
    const startedAt = Date.now();
    const chunks = this.chunking.chunkAll(options.documents, this.chunkProfile);

    options.onProgress?.(`Embedding ${chunks.length} text units`);
    const embedded = await embedChunks(this.openai, chunks, options);

    const graph = options.cachedGraph
      ? this.graphBuilder.deserialize(options.cachedGraph as SerializedGraph, chunks)
      : await this.graphBuilder.build(chunks, options.tracker, options.onProgress);

    const index: GraphIndex = {
      vector: VectorIndex.from(embedded),
      bm25: Bm25Index.from(chunks),
      graph,
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
        fromCache: Boolean(options.cachedGraph),
        graph: {
          entities: graph.entities.size,
          relationships: graph.relationships.length,
          communities: graph.communities.length,
          levels: graph.levels,
        },
      },
    };
  }

  async retrieve(options: RetrieveOptions): Promise<RetrievalResult> {
    const trace = new TraceBuilder();
    const index = options.context.index as GraphIndex;
    const { question, topK, tracker } = options;

    const mode = await this.pickMode(question, index, tracker, trace);

    let chunks: RetrievedChunk[];
    switch (mode) {
      case 'global':
        chunks = await this.globalSearch(question, index, topK, tracker, trace);
        break;
      case 'drift':
        chunks = await this.driftSearch(question, index, topK, tracker, trace);
        break;
      case 'local':
        chunks = await this.localSearch(question, index, topK, tracker, trace);
        break;
      default:
        chunks = await this.basicSearch(question, index, topK, tracker, trace);
    }

    // Any mode can come up empty on a sparse graph; never hand the answerer
    // nothing when a plain vector search would have found something.
    if (chunks.length === 0) {
      chunks = await this.basicSearch(question, index, topK, tracker, trace);
      trace.step('Fallback to basic search', 'graph search returned no text units');
    }

    return { chunks: renumber(chunks.slice(0, topK)), trace: trace.build(this.id, [question], mode) };
  }

  // ── Mode routing ──────────────────────────────────────────────────────────

  private async pickMode(
    question: string,
    index: GraphIndex,
    tracker: UsageTracker,
    trace: TraceBuilder,
  ): Promise<GraphSearchMode> {
    if (index.graph.entities.size === 0) {
      trace.step('Route', 'empty graph -> basic');
      return 'basic';
    }

    const route = await this.queryTransform.route(question, tracker);
    const hasCommunities = index.graph.communities.length > 0;

    const mode: GraphSearchMode =
      route.category === 'broad' && hasCommunities
        ? 'global'
        : route.category === 'multi_hop'
          ? hasCommunities
            ? 'drift'
            : 'local'
          : 'local';

    trace.step('Route', `${route.category} -> ${mode} search`);
    return mode;
  }

  // ── Basic ─────────────────────────────────────────────────────────────────

  private async basicSearch(
    question: string,
    index: GraphIndex,
    topK: number,
    tracker: UsageTracker,
    trace: TraceBuilder,
  ): Promise<RetrievedChunk[]> {
    const queryVector = await this.openai.embedOne(question, tracker);
    const lists: RankedList[] = [
      { source: 'dense', results: index.vector.search(queryVector, RETRIEVAL_CANDIDATE_POOL), query: question },
      { source: 'bm25', results: index.bm25.search(question, RETRIEVAL_CANDIDATE_POOL), query: question },
    ];
    trace.step('Basic hybrid search', 'dense + BM25 over text units');
    return reciprocalRankFusion(lists).slice(0, topK);
  }

  // ── Local ─────────────────────────────────────────────────────────────────

  /**
   * Local search: find the entities the question is about, expand to their
   * graph neighbours, and rank the text units those entities were extracted
   * from. A text unit backed by several related entities outranks one backed by
   * a single mention.
   */
  private async localSearch(
    question: string,
    index: GraphIndex,
    topK: number,
    tracker: UsageTracker,
    trace: TraceBuilder,
  ): Promise<RetrievedChunk[]> {
    const anchors = this.matchEntities(question, index.graph, LOCAL_ANCHOR_ENTITIES);
    trace.step(
      'Anchor entities',
      anchors.map((a) => a.name).join(', ') || 'none matched',
      anchors.length,
    );

    if (anchors.length === 0) return [];

    // Expand one hop into the neighbourhood, weighting neighbours below anchors.
    const entityWeights = new Map<string, number>();
    for (const anchor of anchors) {
      entityWeights.set(anchor.id, (entityWeights.get(anchor.id) ?? 0) + 1);
      for (const neighbourId of index.graph.adjacency.get(anchor.id) ?? []) {
        entityWeights.set(neighbourId, (entityWeights.get(neighbourId) ?? 0) + 0.4);
      }
    }
    trace.step('Expand neighbourhood', `${entityWeights.size} entities in scope`);

    // Score each text unit by the weight of entities extracted from it.
    const unitScores = scoreTextUnitsByEntities(index.graph, entityWeights);

    const graphHits = [...unitScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RETRIEVAL_CANDIDATE_POOL)
      .map(([unitId, score]) => ({ chunk: index.graph.textUnits.get(unitId), score }))
      .filter((h): h is { chunk: Chunk; score: number } => Boolean(h.chunk));

    trace.step('Rank text units by entity support', undefined, graphHits.length);

    // Fuse with plain vector search so a strong lexical/semantic match is not
    // lost just because extraction missed its entities.
    //
    // The graph list's weight tracks how *specific* its anchors are. RRF fuses
    // on rank, so a list always injects its top-k at full strength regardless of
    // how confident it is — a question that only names "Assurio" (225 text
    // units) would otherwise let 20 essentially arbitrary units outrank genuine
    // dense matches. Rare anchors earn a strong weight; hub anchors do not.
    const graphWeight = anchorSpecificity(anchors);
    const queryVector = await this.openai.embedOne(question, tracker);
    const fused = reciprocalRankFusion([
      { source: 'graph-local', results: graphHits, query: question, weight: graphWeight },
      { source: 'dense', results: index.vector.search(queryVector, RETRIEVAL_CANDIDATE_POOL), query: question },
      // BM25 belongs here for the same reason it does in the hybrid strategies:
      // it is the channel that pins down rare proper nouns and identifiers, and
      // it fails independently of both the graph and the embedding.
      { source: 'bm25', results: index.bm25.search(question, RETRIEVAL_CANDIDATE_POOL), query: question },
    ]);
    trace.step('Fuse graph + dense + BM25', `RRF, graph weight ${graphWeight.toFixed(2)}`, fused.length);

    return fused.slice(0, topK);
  }

  // ── Global ────────────────────────────────────────────────────────────────

  /**
   * Global search: map-reduce over community summaries.
   *
   * Map   — ask each candidate community what it contributes to the question.
   * Reduce— keep the communities that scored, and surface the text units behind
   *         their member entities as the evidence handed to the answerer.
   */
  private async globalSearch(
    question: string,
    index: GraphIndex,
    topK: number,
    tracker: UsageTracker,
    trace: TraceBuilder,
  ): Promise<RetrievedChunk[]> {
    const candidates = await this.selectCommunities(question, index, tracker);
    trace.step('Select communities', `${candidates.length} candidates`, candidates.length);

    if (candidates.length === 0) return [];

    const mapped = await mapWithConcurrency(candidates, LLM_CONCURRENCY, async (community) => {
      const result = await this.openai.chatJson<{
        points: Array<{ description: string; score: number }>;
      }>(this.config.utilityModel, {
        system: GLOBAL_MAP_SYSTEM_PROMPT,
        user: buildGlobalMapPrompt(question, `${community.title}\n${community.summary}`),
        maxOutputTokens: MAX_UTILITY_OUTPUT_TOKENS,
        stage: 'graph',
        tracker,
        reasoningEffort: 'minimal',
        jsonSchema: GLOBAL_MAP_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      });

      const best = (result?.points ?? []).reduce((max, p) => Math.max(max, p.score ?? 0), 0);
      return { community, score: best };
    });

    const relevant = mapped.filter((m) => m.score > 0).sort((a, b) => b.score - a.score);
    trace.step('Map over communities', `${relevant.length} contributed points`, relevant.length);

    if (relevant.length === 0) return [];

    // Reduce: gather the evidence behind the contributing communities.
    const entityWeights = new Map<string, number>();
    for (const { community, score } of relevant) {
      const normalized = score / 100;
      for (const entityId of community.entityIds) {
        entityWeights.set(entityId, (entityWeights.get(entityId) ?? 0) + normalized);
      }
    }
    const unitScores = this.scoreUnits(index.graph, entityWeights);

    const hits = [...unitScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RETRIEVAL_CANDIDATE_POOL)
      .map(([unitId, score]) => ({ chunk: index.graph.textUnits.get(unitId), score }))
      .filter((h): h is { chunk: Chunk; score: number } => Boolean(h.chunk));

    trace.step('Reduce to text units', undefined, hits.length);

    // Global search is the one mode where the graph genuinely knows something
    // vector search cannot: which communities the question spans. It keeps a
    // strong weight, and BM25 backs it up on named entities.
    const queryVector = await this.openai.embedOne(question, tracker);
    const fused = reciprocalRankFusion([
      { source: 'graph-global', results: hits, query: question, weight: 1.5 },
      { source: 'dense', results: index.vector.search(queryVector, RETRIEVAL_CANDIDATE_POOL), query: question },
      { source: 'bm25', results: index.bm25.search(question, RETRIEVAL_CANDIDATE_POOL), query: question },
    ]);

    return fused.slice(0, topK);
  }

  // ── DRIFT ─────────────────────────────────────────────────────────────────

  /**
   * DRIFT search: use community summaries as a primer to discover which
   * entities matter, then run local search anchored on those entities. Gives a
   * multi-hop question global orientation before local precision.
   */
  private async driftSearch(
    question: string,
    index: GraphIndex,
    topK: number,
    tracker: UsageTracker,
    trace: TraceBuilder,
  ): Promise<RetrievedChunk[]> {
    const primer = await this.selectCommunities(question, index, tracker, 3);
    trace.step('DRIFT primer', `${primer.length} orienting communities`, primer.length);

    // Entities named by the primer communities become extra anchors.
    const primerEntityIds = new Set<string>();
    for (const community of primer) {
      for (const id of community.entityIds.slice(0, 12)) primerEntityIds.add(id);
    }

    const named = this.matchEntities(question, index.graph, LOCAL_ANCHOR_ENTITIES);
    for (const e of named) primerEntityIds.add(e.id);
    trace.step('DRIFT follow-up anchors', `${primerEntityIds.size} entities`);

    if (primerEntityIds.size === 0) return [];

    const namedIds = new Set(named.map((n) => n.id));
    const entityWeights = new Map<string, number>();

    for (const entityId of primerEntityIds) {
      // Entities the question actually names outrank ones the primer suggested.
      entityWeights.set(entityId, namedIds.has(entityId) ? 1 : 0.5);
    }
    const unitScores = this.scoreUnits(index.graph, entityWeights);

    const hits = [...unitScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RETRIEVAL_CANDIDATE_POOL)
      .map(([unitId, score]) => ({ chunk: index.graph.textUnits.get(unitId), score }))
      .filter((h): h is { chunk: Chunk; score: number } => Boolean(h.chunk));

    const queryVector = await this.openai.embedOne(question, tracker);
    const fused = reciprocalRankFusion([
      { source: 'graph-drift', results: hits, query: question, weight: anchorSpecificity(named) },
      { source: 'dense', results: index.vector.search(queryVector, RETRIEVAL_CANDIDATE_POOL), query: question },
      { source: 'bm25', results: index.bm25.search(question, RETRIEVAL_CANDIDATE_POOL), query: question },
    ]);
    trace.step('Fuse DRIFT + dense + BM25', 'RRF', fused.length);

    return dedupe(fused).slice(0, topK);
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  /** Communities most similar to the question, by summary embedding. */
  private async selectCommunities(
    question: string,
    index: GraphIndex,
    tracker: UsageTracker,
    limit = GLOBAL_COMMUNITY_FANOUT,
  ): Promise<GraphCommunity[]> {
    const withEmbeddings = index.graph.communities.filter((c) => c.embedding);
    if (withEmbeddings.length === 0) {
      // No embeddings (very small corpus) — fall back to graph importance.
      return [...index.graph.communities].sort((a, b) => b.rank - a.rank).slice(0, limit);
    }

    const queryVector = await this.openai.embedOne(question, tracker);
    return withEmbeddings
      .map((c) => ({ c, score: cosineSimilarity(c.embedding!, queryVector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.c);
  }

  /**
   * Entities the question mentions. Matches on whole-word containment of the
   * entity name in the question, longest name first so "Apex Reinsurance" wins
   * over "Apex".
   */
  /**
   * Rank text units by how strongly the in-scope entities point at them.
   *
   * The weight each entity contributes is damped by how many text units it
   * appears in, exactly like IDF. Without this a hub entity — "ASSURIO" occurs
   * in nearly every document of this corpus — adds the same score to hundreds
   * of units and flattens the ranking into noise, which is worse than no graph
   * signal at all. A rare entity naming one contract is the discriminative one.
   */
  private scoreUnits(
    graph: KnowledgeGraph,
    entityWeights: Map<string, number>,
  ): Map<string, number> {
    return scoreTextUnitsByEntities(graph, entityWeights);
  }

  private matchEntities(question: string, graph: KnowledgeGraph, limit: number): GraphEntity[] {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

    const haystack = ` ${normalize(question)} `;
    const scored: Array<{ entity: GraphEntity; score: number }> = [];

    for (const entity of graph.entities.values()) {
      const name = normalize(entity.name);
      // Two-character names ("AI", "US") produce far too many false anchors.
      if (name.length < 3) continue;
      if (!haystack.includes(` ${name} `)) continue;
      // Prefer longer, more specific names and better-connected entities.
      scored.push({ entity, score: name.length * 10 + entity.degree });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((m) => m.entity);
  }
}

/**
 * Text-unit scoring shared by local, global and DRIFT search.
 *
 * `entityWeights` maps entityId -> how much this query cares about that entity.
 * Each entity spreads its weight over the text units it was extracted from,
 * damped by an IDF factor so ubiquitous entities cannot dominate:
 *
 *     contribution = weight / log2(2 + unitsMentioningTheEntity)
 *
 * An entity found in 2 units contributes ~0.5x its weight; one found in 300
 * contributes ~0.12x. Without the damping, a corpus-wide entity adds a constant
 * to hundreds of units and the ranking degenerates to noise.
 */
export function scoreTextUnitsByEntities(
  graph: KnowledgeGraph,
  entityWeights: Map<string, number>,
): Map<string, number> {
  const unitScores = new Map<string, number>();

  for (const [entityId, weight] of entityWeights) {
    const entity = graph.entities.get(entityId);
    if (!entity) continue;

    const units = new Set(entity.textUnitIds);
    if (units.size === 0) continue;

    const idf = 1 / Math.log2(2 + units.size);
    const contribution = weight * idf;

    for (const unitId of units) {
      unitScores.set(unitId, (unitScores.get(unitId) ?? 0) + contribution);
    }
  }

  return unitScores;
}

/**
 * How much to trust a graph list built from these anchor entities, as an RRF
 * weight.
 *
 * An anchor mentioned in two text units pins the answer down; one mentioned in
 * two hundred says almost nothing. Averaging the per-anchor IDF and mapping it
 * onto [MIN_GRAPH_WEIGHT, MAX_GRAPH_WEIGHT] lets a precise entity match lead the
 * fusion while a hub match politely defers to dense retrieval.
 */
const MIN_GRAPH_WEIGHT = 0.6;
const MAX_GRAPH_WEIGHT = 1.6;

export function anchorSpecificity(anchors: GraphEntity[]): number {
  if (anchors.length === 0) return MIN_GRAPH_WEIGHT;

  // 1/log2(2+n): 1 unit -> 0.63, 10 -> 0.28, 225 -> 0.13.
  const meanIdf =
    anchors.reduce((sum, e) => sum + 1 / Math.log2(2 + new Set(e.textUnitIds).size), 0) /
    anchors.length;

  // 0.63 is the ceiling (an entity in a single text unit).
  const normalized = Math.min(1, meanIdf / 0.63);
  return MIN_GRAPH_WEIGHT + (MAX_GRAPH_WEIGHT - MIN_GRAPH_WEIGHT) * normalized;
}
