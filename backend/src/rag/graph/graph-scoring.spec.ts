import { anchorSpecificity, scoreTextUnitsByEntities } from './graph-rag.service';
import { KnowledgeGraph, emptyGraph } from './graph.types';

function graphWith(entities: Array<{ id: string; units: string[] }>): KnowledgeGraph {
  const graph = emptyGraph();
  for (const e of entities) {
    graph.entities.set(e.id, {
      id: e.id,
      name: e.id,
      type: 'CONCEPT',
      description: '',
      textUnitIds: e.units,
      degree: e.units.length,
    });
  }
  return graph;
}

describe('scoreTextUnitsByEntities', () => {
  it('scores the units an entity was extracted from', () => {
    const graph = graphWith([{ id: 'A', units: ['u1', 'u2'] }]);
    const scores = scoreTextUnitsByEntities(graph, new Map([['A', 1]]));
    expect(scores.get('u1')).toBeGreaterThan(0);
    expect(scores.get('u2')).toBeGreaterThan(0);
    expect(scores.get('u3')).toBeUndefined();
  });

  it('damps a ubiquitous entity below a rare one', () => {
    // "HUB" appears everywhere; "RARE" names one unit.
    const hubUnits = Array.from({ length: 200 }, (_, i) => `u${i}`);
    const graph = graphWith([
      { id: 'HUB', units: hubUnits },
      { id: 'RARE', units: ['u5'] },
    ]);

    const scores = scoreTextUnitsByEntities(graph, new Map([['HUB', 1], ['RARE', 1]]));

    // u5 carries both; every other unit carries only the damped hub.
    const hubOnly = scores.get('u0')!;
    const both = scores.get('u5')!;
    expect(both).toBeGreaterThan(hubOnly);
    // The rare entity must contribute more than the hub does, otherwise the hub
    // would flatten the ranking.
    expect(both - hubOnly).toBeGreaterThan(hubOnly);
  });

  it('ranks the unit named by a rare entity first', () => {
    const hubUnits = Array.from({ length: 100 }, (_, i) => `u${i}`);
    const graph = graphWith([
      { id: 'HUB', units: hubUnits },
      { id: 'RARE', units: ['u42'] },
    ]);

    const scores = scoreTextUnitsByEntities(graph, new Map([['HUB', 1], ['RARE', 1]]));
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    expect(ranked[0][0]).toBe('u42');
  });

  it('respects the caller-supplied entity weight', () => {
    const graph = graphWith([
      { id: 'A', units: ['u1'] },
      { id: 'B', units: ['u2'] },
    ]);
    const scores = scoreTextUnitsByEntities(graph, new Map([['A', 1], ['B', 0.4]]));
    expect(scores.get('u1')!).toBeGreaterThan(scores.get('u2')!);
  });

  it('accumulates when several entities point at one unit', () => {
    const graph = graphWith([
      { id: 'A', units: ['u1'] },
      { id: 'B', units: ['u1'] },
      { id: 'C', units: ['u2'] },
    ]);
    const scores = scoreTextUnitsByEntities(graph, new Map([['A', 1], ['B', 1], ['C', 1]]));
    expect(scores.get('u1')!).toBeGreaterThan(scores.get('u2')!);
  });

  it('ignores entities missing from the graph', () => {
    const graph = graphWith([{ id: 'A', units: ['u1'] }]);
    const scores = scoreTextUnitsByEntities(graph, new Map([['A', 1], ['GHOST', 5]]));
    expect(scores.size).toBe(1);
  });

  it('ignores an entity with no text units', () => {
    const graph = graphWith([{ id: 'A', units: [] }]);
    expect(scoreTextUnitsByEntities(graph, new Map([['A', 1]])).size).toBe(0);
  });

  it('handles an empty weight map', () => {
    const graph = graphWith([{ id: 'A', units: ['u1'] }]);
    expect(scoreTextUnitsByEntities(graph, new Map()).size).toBe(0);
  });

  it('de-duplicates repeated text unit ids', () => {
    const single = graphWith([{ id: 'A', units: ['u1'] }]);
    const repeated = graphWith([{ id: 'A', units: ['u1', 'u1', 'u1'] }]);
    expect(scoreTextUnitsByEntities(repeated, new Map([['A', 1]])).get('u1')).toBeCloseTo(
      scoreTextUnitsByEntities(single, new Map([['A', 1]])).get('u1')!,
      10,
    );
  });
});

describe('anchorSpecificity', () => {
  const entity = (id: string, units: number) => ({
    id,
    name: id,
    type: 'CONCEPT',
    description: '',
    textUnitIds: Array.from({ length: units }, (_, i) => `u${i}`),
    degree: units,
  });

  it('gives a rare anchor a strong weight', () => {
    expect(anchorSpecificity([entity('RARE', 1)])).toBeGreaterThan(1.4);
  });

  it('gives a hub anchor a weak weight', () => {
    expect(anchorSpecificity([entity('HUB', 225)])).toBeLessThan(0.9);
  });

  it('is monotonic in anchor rarity', () => {
    const weights = [1, 5, 25, 100, 225].map((n) => anchorSpecificity([entity('E', n)]));
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThan(weights[i - 1]);
    }
  });

  it('stays inside the configured band', () => {
    for (const n of [1, 2, 10, 500, 5000]) {
      const w = anchorSpecificity([entity('E', n)]);
      expect(w).toBeGreaterThanOrEqual(0.6);
      expect(w).toBeLessThanOrEqual(1.6);
    }
  });

  it('falls back to the minimum with no anchors', () => {
    expect(anchorSpecificity([])).toBe(0.6);
  });

  it('averages across mixed anchors', () => {
    const mixed = anchorSpecificity([entity('RARE', 1), entity('HUB', 225)]);
    expect(mixed).toBeGreaterThan(anchorSpecificity([entity('HUB', 225)]));
    expect(mixed).toBeLessThan(anchorSpecificity([entity('RARE', 1)]));
  });
});
