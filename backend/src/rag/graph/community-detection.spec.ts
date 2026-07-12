import { WeightedEdge, detectCommunities } from './community-detection';

/** Two tight triangles joined by a single weak bridge. */
const BARBELL_NODES = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'];
const BARBELL_EDGES: WeightedEdge[] = [
  { source: 'a1', target: 'a2', weight: 10 },
  { source: 'a2', target: 'a3', weight: 10 },
  { source: 'a3', target: 'a1', weight: 10 },
  { source: 'b1', target: 'b2', weight: 10 },
  { source: 'b2', target: 'b3', weight: 10 },
  { source: 'b3', target: 'b1', weight: 10 },
  { source: 'a1', target: 'b1', weight: 1 },
];

describe('detectCommunities', () => {
  it('separates two densely connected clusters', () => {
    const levels = detectCommunities(BARBELL_NODES, BARBELL_EDGES);
    expect(levels.length).toBeGreaterThan(0);

    const { membership } = levels[0];
    expect(membership.get('a1')).toBe(membership.get('a2'));
    expect(membership.get('a2')).toBe(membership.get('a3'));
    expect(membership.get('b1')).toBe(membership.get('b2'));
    expect(membership.get('b2')).toBe(membership.get('b3'));
    expect(membership.get('a1')).not.toBe(membership.get('b1'));
  });

  it('assigns every node to exactly one community', () => {
    const [level] = detectCommunities(BARBELL_NODES, BARBELL_EDGES);
    expect(level.membership.size).toBe(BARBELL_NODES.length);

    const assigned = [...level.communities.values()].flat().sort();
    expect(assigned).toEqual([...BARBELL_NODES].sort());
  });

  it('reports positive modularity for a clustered graph', () => {
    const [level] = detectCommunities(BARBELL_NODES, BARBELL_EDGES);
    expect(level.modularity).toBeGreaterThan(0.3);
  });

  it('is deterministic across runs', () => {
    const a = detectCommunities(BARBELL_NODES, BARBELL_EDGES);
    const b = detectCommunities(BARBELL_NODES, BARBELL_EDGES);
    expect([...a[0].membership.entries()]).toEqual([...b[0].membership.entries()]);
  });

  it('produces a hierarchy on a graph of many clusters', () => {
    // Six triangles chained by weak links -> level 0 finds triangles, a higher
    // level should merge some of them.
    const nodes: string[] = [];
    const edges: WeightedEdge[] = [];
    for (let g = 0; g < 6; g++) {
      const [x, y, z] = [`g${g}n0`, `g${g}n1`, `g${g}n2`];
      nodes.push(x, y, z);
      edges.push(
        { source: x, target: y, weight: 20 },
        { source: y, target: z, weight: 20 },
        { source: z, target: x, weight: 20 },
      );
      if (g > 0) edges.push({ source: `g${g - 1}n0`, target: x, weight: 1 });
    }

    const levels = detectCommunities(nodes, edges);
    expect(levels.length).toBeGreaterThanOrEqual(1);
    expect(levels[0].communities.size).toBeGreaterThanOrEqual(4);
    if (levels.length > 1) {
      expect(levels[1].communities.size).toBeLessThan(levels[0].communities.size);
      // Higher levels still cover every node.
      expect([...levels[1].communities.values()].flat().sort()).toEqual([...nodes].sort());
    }
  });

  it('handles an empty graph', () => {
    expect(detectCommunities([], [])).toEqual([]);
  });

  it('handles nodes with no edges', () => {
    expect(detectCommunities(['x', 'y'], [])).toEqual([]);
  });

  it('ignores edges referencing unknown nodes', () => {
    const levels = detectCommunities(BARBELL_NODES, [
      ...BARBELL_EDGES,
      { source: 'ghost', target: 'a1', weight: 5 },
    ]);
    expect(levels[0].membership.has('ghost')).toBe(false);
    expect(levels[0].membership.size).toBe(BARBELL_NODES.length);
  });

  it('tolerates self-loops', () => {
    const levels = detectCommunities(BARBELL_NODES, [
      ...BARBELL_EDGES,
      { source: 'a1', target: 'a1', weight: 3 },
    ]);
    expect(levels[0].membership.get('a1')).toBe(levels[0].membership.get('a2'));
  });
});
