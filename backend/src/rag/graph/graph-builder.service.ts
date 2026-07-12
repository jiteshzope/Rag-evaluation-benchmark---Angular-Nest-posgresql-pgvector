import { Injectable, Logger } from '@nestjs/common';

import { AppConfig } from '../../config/app-config';
import {
  GRAPH_EXTRACTION_BATCH_SIZE,
  LLM_CONCURRENCY,
  MAX_GRAPH_COMMUNITY_SUMMARIES,
  MAX_GRAPH_EXTRACTION_UNITS,
  MAX_GRAPH_EXTRACTION_OUTPUT_TOKENS,
  MAX_SUMMARY_OUTPUT_TOKENS,
} from '../../config/limits';
import { Chunk } from '../../common/types';
import { OpenAiService } from '../../llm/openai.service';
import { UsageTracker } from '../../llm/usage-tracker';
import { mapWithConcurrency } from '../../ingestion/text-utils';
import {
  COMMUNITY_SUMMARY_SCHEMA,
  COMMUNITY_SUMMARY_SYSTEM_PROMPT,
  ENTITY_EXTRACTION_SCHEMA,
  ENTITY_EXTRACTION_SYSTEM_PROMPT,
  buildCommunitySummaryPrompt,
} from './graph-prompts';
import { WeightedEdge, detectCommunities } from './community-detection';
import {
  GraphCommunity,
  GraphEntity,
  GraphRelationship,
  KnowledgeGraph,
  SerializedGraph,
  emptyGraph,
  entityKey,
} from './graph.types';

interface ExtractionResult {
  entities: Array<{ name: string; type: string; description: string }>;
  relationships: Array<{ source: string; target: string; description: string; weight: number }>;
}

const schema = (s: unknown) => s as unknown as { name: string; schema: Record<string, unknown> };

/**
 * Builds the knowledge graph: extract -> merge -> detect communities ->
 * summarise -> embed summaries.
 *
 * This is the expensive part of GraphRAG and the reason the shipped knowledge
 * base is indexed once, offline, into pgvector. An anonymous upload gets a
 * budgeted version of the same pipeline.
 */
@Injectable()
export class GraphBuilderService {
  private readonly logger = new Logger(GraphBuilderService.name);

  constructor(
    private readonly openai: OpenAiService,
    private readonly config: AppConfig,
  ) {}

  async build(
    chunks: Chunk[],
    tracker: UsageTracker,
    onProgress?: (message: string) => void,
    limits = {
      maxUnits: MAX_GRAPH_EXTRACTION_UNITS,
      maxSummaries: MAX_GRAPH_COMMUNITY_SUMMARIES,
    },
  ): Promise<KnowledgeGraph> {
    const graph = emptyGraph();
    for (const c of chunks) graph.textUnits.set(c.id, c);

    // ── 1. Extract entities and relationships from text units ───────────────
    const units = selectTextUnits(chunks, limits.maxUnits);
    const batches: Chunk[][] = [];
    for (let i = 0; i < units.length; i += GRAPH_EXTRACTION_BATCH_SIZE) {
      batches.push(units.slice(i, i + GRAPH_EXTRACTION_BATCH_SIZE));
    }

    onProgress?.(`Extracting entities from ${units.length} text units`);
    this.logger.log(`Graph extraction: ${units.length} units in ${batches.length} batches`);

    const extractions = await mapWithConcurrency(batches, LLM_CONCURRENCY, (batch) =>
      this.extractBatch(batch, tracker),
    );

    // ── 2. Merge into a single graph ────────────────────────────────────────
    batches.forEach((batch, i) => {
      const result = extractions[i];
      if (result) this.mergeExtraction(graph, result, batch);
    });

    this.buildAdjacency(graph);
    onProgress?.(`Graph has ${graph.entities.size} entities, ${graph.relationships.length} relationships`);

    if (graph.entities.size === 0) {
      this.logger.warn('Entity extraction produced no entities; graph search will fall back to vectors.');
      return graph;
    }

    // ── 3. Detect communities ───────────────────────────────────────────────
    const edges: WeightedEdge[] = graph.relationships.map((r) => ({
      source: r.sourceId,
      target: r.targetId,
      weight: r.weight,
    }));
    const levels = detectCommunities([...graph.entities.keys()], edges);
    graph.levels = levels.length;

    const communities: GraphCommunity[] = [];
    levels.forEach((level, levelIndex) => {
      for (const [communityId, entityIds] of level.communities) {
        // Singletons carry no cross-entity insight and are not worth a summary.
        if (entityIds.length < 2) continue;
        communities.push({
          id: communityId,
          level: levelIndex,
          entityIds,
          childIds: [],
          summary: '',
          title: '',
          rank: entityIds.reduce((sum, id) => sum + (graph.entities.get(id)?.degree ?? 0), 0),
        });
      }
    });

    // Link each community to its parent one level up.
    for (const community of communities) {
      if (community.level + 1 >= levels.length) continue;
      const parentLevel = levels[community.level + 1];
      const parentId = parentLevel.membership.get(community.entityIds[0]);
      if (!parentId) continue;
      community.parentId = parentId;
      const parent = communities.find((c) => c.id === parentId);
      if (parent) parent.childIds.push(community.id);
    }

    // ── 4. Summarise the most important communities ─────────────────────────
    const ranked = [...communities].sort((a, b) => b.rank - a.rank).slice(0, limits.maxSummaries);
    onProgress?.(`Summarising ${ranked.length} communities`);

    const summaries = await mapWithConcurrency(ranked, LLM_CONCURRENCY, (community) =>
      this.summariseCommunity(graph, community, tracker),
    );

    ranked.forEach((community, i) => {
      const result = summaries[i];
      if (result) {
        community.title = result.title;
        community.summary = result.summary;
      }
    });

    graph.communities = communities.filter((c) => c.summary.length > 0);

    // ── 5. Embed community summaries for community-level vector search ──────
    if (graph.communities.length > 0) {
      onProgress?.(`Embedding ${graph.communities.length} community summaries`);
      const vectors = await this.openai.embed(
        graph.communities.map((c) => `${c.title}\n${c.summary}`),
        tracker,
      );
      graph.communities.forEach((c, i) => {
        c.embedding = vectors[i];
      });
    }

    this.logger.log(
      `Graph built: ${graph.entities.size} entities, ${graph.relationships.length} relationships, ` +
        `${graph.communities.length} summarised communities across ${graph.levels} level(s)`,
    );

    return graph;
  }

  private async extractBatch(batch: Chunk[], tracker: UsageTracker): Promise<ExtractionResult | null> {
    const text = batch
      .map((c) => {
        const where = c.headingPath.length ? `${c.docTitle} > ${c.headingPath.join(' > ')}` : c.docTitle;
        return `[source: ${where}]\n${c.text}`;
      })
      .join('\n\n---\n\n');

    try {
      return await this.openai.chatJson<ExtractionResult>(this.config.utilityModel, {
        system: ENTITY_EXTRACTION_SYSTEM_PROMPT,
        user: text,
        maxOutputTokens: MAX_GRAPH_EXTRACTION_OUTPUT_TOKENS,
        stage: 'graph',
        tracker,
        reasoningEffort: 'minimal',
        jsonSchema: schema(ENTITY_EXTRACTION_SCHEMA),
      });
    } catch (err) {
      this.logger.warn(`Entity extraction failed for a batch: ${(err as Error).message}`);
      return null;
    }
  }

  private mergeExtraction(graph: KnowledgeGraph, result: ExtractionResult, batch: Chunk[]): void {
    const textUnitIds = batch.map((c) => c.id);

    for (const raw of result.entities ?? []) {
      if (!raw?.name?.trim()) continue;
      const id = entityKey(raw.name);
      const existing = graph.entities.get(id);

      if (existing) {
        existing.degree++;
        existing.textUnitIds.push(...textUnitIds);
        // Keep the richer description rather than the most recent one.
        if ((raw.description ?? '').length > existing.description.length) {
          existing.description = raw.description;
        }
      } else {
        graph.entities.set(id, {
          id,
          name: raw.name.trim(),
          type: raw.type ?? 'CONCEPT',
          description: raw.description ?? '',
          textUnitIds: [...textUnitIds],
          degree: 1,
        });
      }
    }

    for (const raw of result.relationships ?? []) {
      if (!raw?.source?.trim() || !raw?.target?.trim()) continue;
      const sourceId = entityKey(raw.source);
      const targetId = entityKey(raw.target);
      // Drop relationships pointing at entities the model did not extract.
      if (sourceId === targetId) continue;
      if (!graph.entities.has(sourceId) || !graph.entities.has(targetId)) continue;

      const key = [sourceId, targetId].sort().join('||');
      const existing = graph.relationships.find(
        (r) => [r.sourceId, r.targetId].sort().join('||') === key,
      );

      if (existing) {
        existing.weight = Math.max(existing.weight, clampWeight(raw.weight));
        existing.textUnitIds.push(...textUnitIds);
      } else {
        graph.relationships.push({
          id: `rel_${graph.relationships.length}`,
          sourceId,
          targetId,
          description: raw.description ?? '',
          weight: clampWeight(raw.weight),
          textUnitIds: [...textUnitIds],
        });
      }
    }
  }

  private buildAdjacency(graph: KnowledgeGraph): void {
    graph.adjacency.clear();
    for (const entityId of graph.entities.keys()) graph.adjacency.set(entityId, new Set());
    for (const rel of graph.relationships) {
      graph.adjacency.get(rel.sourceId)?.add(rel.targetId);
      graph.adjacency.get(rel.targetId)?.add(rel.sourceId);
    }
  }

  private async summariseCommunity(
    graph: KnowledgeGraph,
    community: GraphCommunity,
    tracker: UsageTracker,
  ): Promise<{ title: string; summary: string } | null> {
    // Cap what goes into one summary prompt — a large community would otherwise
    // blow past a sensible input size.
    const memberIds = new Set(community.entityIds.slice(0, 25));
    const entities = [...memberIds]
      .map((id) => graph.entities.get(id))
      .filter((e): e is GraphEntity => Boolean(e))
      .map((e) => ({ name: e.name, type: e.type, description: e.description }));

    const relationships = graph.relationships
      .filter((r) => memberIds.has(r.sourceId) && memberIds.has(r.targetId))
      .slice(0, 30)
      .map((r) => ({
        source: graph.entities.get(r.sourceId)?.name ?? r.sourceId,
        target: graph.entities.get(r.targetId)?.name ?? r.targetId,
        description: r.description,
      }));

    if (entities.length === 0) return null;

    try {
      return await this.openai.chatJson<{ title: string; summary: string }>(
        this.config.utilityModel,
        {
          system: COMMUNITY_SUMMARY_SYSTEM_PROMPT,
          user: buildCommunitySummaryPrompt({ entities, relationships }),
          maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
          stage: 'graph',
          tracker,
          reasoningEffort: 'minimal',
          jsonSchema: schema(COMMUNITY_SUMMARY_SCHEMA),
        },
      );
    } catch (err) {
      this.logger.warn(`Community summary failed for ${community.id}: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Persistence helpers (default knowledge base only) ────────────────────

  serialize(graph: KnowledgeGraph): SerializedGraph {
    return {
      entities: [...graph.entities.values()],
      relationships: graph.relationships,
      communities: graph.communities.map((c) => ({
        ...c,
        embedding: c.embedding ? Array.from(c.embedding) : undefined,
      })),
    };
  }

  deserialize(payload: SerializedGraph, chunks: Chunk[]): KnowledgeGraph {
    const graph = emptyGraph();
    for (const c of chunks) graph.textUnits.set(c.id, c);
    for (const e of payload.entities) graph.entities.set(e.id, e);
    graph.relationships = payload.relationships;
    graph.communities = payload.communities.map((c) => ({
      ...c,
      embedding: c.embedding ? Float32Array.from(c.embedding) : undefined,
    }));
    graph.levels = graph.communities.reduce((max, c) => Math.max(max, c.level + 1), 0);
    this.buildAdjacency(graph);
    return graph;
  }
}

function clampWeight(weight: unknown): number {
  const n = typeof weight === 'number' && Number.isFinite(weight) ? weight : 5;
  return Math.min(10, Math.max(1, n));
}

/**
 * Choose which text units to extract from when the corpus exceeds the budget.
 * Spreads the sample evenly across documents rather than taking a prefix, so the
 * graph covers the whole corpus instead of only its first few files.
 */
export function selectTextUnits(chunks: Chunk[], maxUnits: number): Chunk[] {
  if (chunks.length <= maxUnits) return chunks;

  const byDoc = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const list = byDoc.get(c.docId) ?? [];
    list.push(c);
    byDoc.set(c.docId, list);
  }

  const selected: Chunk[] = [];
  const docs = [...byDoc.values()];
  let round = 0;

  // Round-robin across documents until the budget is spent.
  while (selected.length < maxUnits) {
    let addedThisRound = false;
    for (const docChunks of docs) {
      if (selected.length >= maxUnits) break;
      if (round < docChunks.length) {
        selected.push(docChunks[round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round++;
  }

  return selected;
}
