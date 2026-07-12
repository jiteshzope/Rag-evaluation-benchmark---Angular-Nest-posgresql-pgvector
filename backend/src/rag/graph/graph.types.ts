import { Chunk } from '../../common/types';

/**
 * Knowledge-graph structures, following the shape Microsoft's GraphRAG uses:
 * entities and relationships extracted from text units, grouped into a
 * hierarchy of communities, each with an LLM-written summary.
 */

export interface GraphEntity {
  /** Normalised upper-case name, used as the node key. */
  id: string;
  name: string;
  type: string;
  description: string;
  /** Text units this entity was found in. */
  textUnitIds: string[];
  /** Number of extractions that mentioned it — a crude importance signal. */
  degree: number;
}

export interface GraphRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  description: string;
  /** Extraction-reported strength, 1-10. */
  weight: number;
  textUnitIds: string[];
}

export interface GraphCommunity {
  id: string;
  /** Hierarchy level; 0 is the finest partition. */
  level: number;
  entityIds: string[];
  /** Communities at level-1 that merged into this one. */
  childIds: string[];
  parentId?: string;
  /** LLM-written report over the community's entities and relationships. */
  summary: string;
  title: string;
  /** Sum of member entity degrees — used to rank communities in global search. */
  rank: number;
  /** Embedding of the summary, for community-level vector search. */
  embedding?: Float32Array;
}

export interface KnowledgeGraph {
  entities: Map<string, GraphEntity>;
  relationships: GraphRelationship[];
  communities: GraphCommunity[];
  /** entityId -> connected entityIds. */
  adjacency: Map<string, Set<string>>;
  /** textUnitId -> chunk. */
  textUnits: Map<string, Chunk>;
  levels: number;
}

/** Serialisable form persisted to pgvector for the default knowledge base. */
export interface SerializedGraph {
  entities: Array<Omit<GraphEntity, 'id'> & { id: string }>;
  relationships: GraphRelationship[];
  communities: Array<Omit<GraphCommunity, 'embedding'> & { embedding?: number[] }>;
}

export function emptyGraph(): KnowledgeGraph {
  return {
    entities: new Map(),
    relationships: [],
    communities: [],
    adjacency: new Map(),
    textUnits: new Map(),
    levels: 0,
  };
}

/** Entity names are matched case-insensitively across extraction batches. */
export function entityKey(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}
