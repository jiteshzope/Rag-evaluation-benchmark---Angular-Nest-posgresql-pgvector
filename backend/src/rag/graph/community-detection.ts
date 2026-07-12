/**
 * Hierarchical community detection by modularity optimisation (Louvain).
 *
 * GraphRAG's global search works by summarising *communities* of densely
 * connected entities rather than individual passages — that is what lets it
 * answer "what themes run across the whole corpus?", which no top-k retriever
 * can do. Finding those communities is this file's job.
 *
 * Louvain, two phases repeated until modularity stops improving:
 *   1. Local moving   — repeatedly move each node to the neighbouring community
 *                       that yields the largest modularity gain.
 *   2. Aggregation    — collapse each community into a single node and repeat,
 *                       which produces the level hierarchy GraphRAG needs.
 *
 * Modularity gain for moving isolated node i into community C:
 *
 *     dQ = (k_i,in / 2m) - (sum_tot * k_i) / (2 * m^2)
 *
 * where k_i,in is the summed weight of edges from i into C, sum_tot the total
 * degree of C, k_i the degree of i and m the total edge weight.
 *
 * Deterministic: nodes are visited in a fixed order and ties resolved by lowest
 * community id, so two runs over the same corpus produce identical communities.
 * Reproducibility matters when the point is comparing strategies.
 */

export interface WeightedEdge {
  source: string;
  target: string;
  weight: number;
}

export interface CommunityLevel {
  /** nodeId -> community id at this level. */
  membership: Map<string, string>;
  /** community id -> member node ids. */
  communities: Map<string, string[]>;
  modularity: number;
}

interface InternalGraph {
  /** node index -> list of [neighbourIndex, weight]. */
  adjacency: Array<Array<[number, number]>>;
  /** Self-loop weight accumulated by aggregation. */
  selfLoops: number[];
  degrees: number[];
  totalWeight: number;
  size: number;
}

const MAX_LEVELS = 4;
const MIN_IMPROVEMENT = 1e-6;

export function detectCommunities(
  nodeIds: string[],
  edges: WeightedEdge[],
  maxLevels = MAX_LEVELS,
): CommunityLevel[] {
  if (nodeIds.length === 0) return [];

  const indexOf = new Map(nodeIds.map((id, i) => [id, i]));
  let graph = buildGraph(nodeIds.length, edges, indexOf);

  // Level 0 starts with every original node in its own community.
  let currentMembers: string[][] = nodeIds.map((id) => [id]);
  const levels: CommunityLevel[] = [];

  for (let level = 0; level < maxLevels; level++) {
    if (graph.size <= 1 || graph.totalWeight === 0) break;

    const assignment = localMoving(graph);
    const communityCount = new Set(assignment).size;

    // No further coarsening possible.
    if (communityCount === graph.size) break;

    const grouped = groupBy(assignment);
    const nextMembers: string[][] = [];
    const membership = new Map<string, string>();
    const communities = new Map<string, string[]>();

    let ordinal = 0;
    for (const [, nodeIndices] of grouped) {
      const communityId = `c${level}_${ordinal++}`;
      const members: string[] = [];
      for (const idx of nodeIndices) members.push(...currentMembers[idx]);

      for (const nodeId of members) membership.set(nodeId, communityId);
      communities.set(communityId, members);
      nextMembers.push(members);
    }

    levels.push({ membership, communities, modularity: modularity(graph, assignment) });

    graph = aggregate(graph, assignment, grouped);
    currentMembers = nextMembers;

    if (grouped.size <= 1) break;
  }

  return levels;
}

function buildGraph(
  size: number,
  edges: WeightedEdge[],
  indexOf: Map<string, number>,
): InternalGraph {
  const adjacency: Array<Array<[number, number]>> = Array.from({ length: size }, () => []);
  const selfLoops = new Array<number>(size).fill(0);
  const degrees = new Array<number>(size).fill(0);
  let totalWeight = 0;

  for (const edge of edges) {
    const s = indexOf.get(edge.source);
    const t = indexOf.get(edge.target);
    if (s === undefined || t === undefined) continue;
    const w = edge.weight > 0 ? edge.weight : 1;

    if (s === t) {
      selfLoops[s] += w;
      degrees[s] += 2 * w;
    } else {
      adjacency[s].push([t, w]);
      adjacency[t].push([s, w]);
      degrees[s] += w;
      degrees[t] += w;
    }
    totalWeight += w;
  }

  return { adjacency, selfLoops, degrees, totalWeight, size };
}

/** Phase 1: greedily move nodes to the best neighbouring community. */
function localMoving(graph: InternalGraph): number[] {
  const assignment = Array.from({ length: graph.size }, (_, i) => i);
  const communityTotalDegree = [...graph.degrees];
  const m2 = 2 * graph.totalWeight;
  if (m2 === 0) return assignment;

  let improved = true;
  let sweeps = 0;

  while (improved && sweeps < 20) {
    improved = false;
    sweeps++;

    for (let node = 0; node < graph.size; node++) {
      const currentCommunity = assignment[node];
      const nodeDegree = graph.degrees[node];

      // Weight from this node into each neighbouring community.
      const weightToCommunity = new Map<number, number>();
      weightToCommunity.set(currentCommunity, 0);
      for (const [neighbour, w] of graph.adjacency[node]) {
        const c = assignment[neighbour];
        weightToCommunity.set(c, (weightToCommunity.get(c) ?? 0) + w);
      }

      // Remove the node from its community before evaluating alternatives.
      communityTotalDegree[currentCommunity] -= nodeDegree;

      let bestCommunity = currentCommunity;
      let bestGain =
        (weightToCommunity.get(currentCommunity) ?? 0) -
        (communityTotalDegree[currentCommunity] * nodeDegree) / m2;

      // Iterate in ascending community id for deterministic tie-breaking.
      for (const community of [...weightToCommunity.keys()].sort((a, b) => a - b)) {
        if (community === currentCommunity) continue;
        const gain =
          (weightToCommunity.get(community) ?? 0) -
          (communityTotalDegree[community] * nodeDegree) / m2;
        if (gain > bestGain + MIN_IMPROVEMENT) {
          bestGain = gain;
          bestCommunity = community;
        }
      }

      communityTotalDegree[bestCommunity] += nodeDegree;
      if (bestCommunity !== currentCommunity) {
        assignment[node] = bestCommunity;
        improved = true;
      }
    }
  }

  return relabel(assignment);
}

/** Phase 2: collapse each community into one node. */
function aggregate(
  graph: InternalGraph,
  assignment: number[],
  grouped: Map<number, number[]>,
): InternalGraph {
  const communityIds = [...grouped.keys()].sort((a, b) => a - b);
  const newIndexOf = new Map(communityIds.map((c, i) => [c, i]));
  const size = communityIds.length;

  const adjacency: Array<Array<[number, number]>> = Array.from({ length: size }, () => []);
  const selfLoops = new Array<number>(size).fill(0);
  const degrees = new Array<number>(size).fill(0);
  const edgeWeights = new Map<string, number>();

  for (let node = 0; node < graph.size; node++) {
    const from = newIndexOf.get(assignment[node])!;
    selfLoops[from] += graph.selfLoops[node];

    for (const [neighbour, w] of graph.adjacency[node]) {
      const to = newIndexOf.get(assignment[neighbour])!;
      if (from === to) {
        // Each intra-community edge is seen twice; halve it.
        selfLoops[from] += w / 2;
      } else if (from < to) {
        const key = `${from}:${to}`;
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + w);
      }
    }
  }

  let totalWeight = 0;
  for (const [key, w] of edgeWeights) {
    const [a, b] = key.split(':').map(Number);
    adjacency[a].push([b, w]);
    adjacency[b].push([a, w]);
    degrees[a] += w;
    degrees[b] += w;
    totalWeight += w;
  }
  for (let i = 0; i < size; i++) {
    degrees[i] += 2 * selfLoops[i];
    totalWeight += selfLoops[i];
  }

  return { adjacency, selfLoops, degrees, totalWeight, size };
}

export function modularity(graph: InternalGraph, assignment: number[]): number {
  const m = graph.totalWeight;
  if (m === 0) return 0;

  const internal = new Map<number, number>();
  const total = new Map<number, number>();

  for (let node = 0; node < graph.size; node++) {
    const c = assignment[node];
    total.set(c, (total.get(c) ?? 0) + graph.degrees[node]);
    internal.set(c, (internal.get(c) ?? 0) + graph.selfLoops[node]);

    for (const [neighbour, w] of graph.adjacency[node]) {
      if (assignment[neighbour] === c) internal.set(c, (internal.get(c) ?? 0) + w / 2);
    }
  }

  let q = 0;
  for (const [c, tot] of total) {
    q += (internal.get(c) ?? 0) / m - Math.pow(tot / (2 * m), 2);
  }
  return q;
}

function groupBy(assignment: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  assignment.forEach((community, node) => {
    const list = out.get(community) ?? [];
    list.push(node);
    out.set(community, list);
  });
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

/** Compact community labels to 0..n-1 while preserving order. */
function relabel(assignment: number[]): number[] {
  const mapping = new Map<number, number>();
  return assignment.map((c) => {
    let next = mapping.get(c);
    if (next === undefined) {
      next = mapping.size;
      mapping.set(c, next);
    }
    return next;
  });
}
