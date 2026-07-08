import { Chunk, EmbeddedChunk } from '../common/types';
import { l2Normalize } from '../ingestion/text-utils';
import { Bm25Index } from './bm25';
import { dedupe, reciprocalRankFusion, toRetrieved } from './fusion';
import { VectorIndex, topK } from './vector-index';

function chunk(id: string, text: string): Chunk {
  return {
    id,
    docId: 'd',
    docTitle: 'd.md',
    category: 'c',
    ordinal: 0,
    text,
    embedText: text,
    headingPath: [],
    charStart: 0,
    charEnd: text.length,
    tokenEstimate: 1,
  };
}

function embedded(id: string, text: string, vec: number[]): EmbeddedChunk {
  return { ...chunk(id, text), embedding: l2Normalize(Float32Array.from(vec)) };
}

describe('topK', () => {
  it('returns the k largest in descending order', () => {
    const scores = Float64Array.from([0.1, 0.9, 0.5, 0.7, 0.3]);
    expect(topK(scores, 3).map((r) => r.index)).toEqual([1, 3, 2]);
  });

  it('handles k larger than the input', () => {
    expect(topK(Float64Array.from([1, 2]), 10)).toHaveLength(2);
  });

  it('handles k <= 0 and empty input', () => {
    expect(topK(Float64Array.from([1, 2]), 0)).toEqual([]);
    expect(topK(new Float64Array(0), 3)).toEqual([]);
  });

  it('agrees with a full sort', () => {
    const raw = Array.from({ length: 500 }, () => Math.random());
    const scores = Float64Array.from(raw);
    const expected = [...raw].sort((a, b) => b - a).slice(0, 7);
    expect(topK(scores, 7).map((r) => r.score)).toEqual(expected);
  });
});

describe('VectorIndex', () => {
  const index = VectorIndex.from([
    embedded('a', 'alpha', [1, 0, 0]),
    embedded('b', 'beta', [0, 1, 0]),
    embedded('c', 'gamma', [0.9, 0.1, 0]),
  ]);

  it('reports size and dimensions', () => {
    expect(index.size).toBe(3);
    expect(index.dimensions).toBe(3);
    expect(index.byteSize).toBeGreaterThan(0);
  });

  it('ranks by cosine similarity', () => {
    const q = l2Normalize(Float32Array.from([1, 0, 0]));
    const hits = index.search(q, 3);
    expect(hits[0].chunk.id).toBe('a');
    expect(hits[1].chunk.id).toBe('c');
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it('respects k', () => {
    expect(index.search(l2Normalize(Float32Array.from([1, 0, 0])), 2)).toHaveLength(2);
  });

  it('returns nothing from an empty index', () => {
    expect(new VectorIndex().search(Float32Array.from([1]), 5)).toEqual([]);
  });

  it('looks up a chunk by id', () => {
    expect(index.getChunk('b')?.text).toBe('beta');
    expect(index.getChunk('zz')).toBeUndefined();
  });
});

describe('Bm25Index', () => {
  const index = Bm25Index.from([
    chunk('a', 'Contract with Apex Reinsurance for ReinsureIQ platform'),
    chunk('b', 'Contract with Belvedere Insurance for MarketIQ platform'),
    chunk('c', 'Avery Lancaster founded the company in 2015'),
  ]);

  it('separates near-identical titles by their rare term', () => {
    expect(index.search('Apex Reinsurance', 3)[0].chunk.id).toBe('a');
    expect(index.search('Belvedere', 3)[0].chunk.id).toBe('b');
  });

  it('matches rare proper nouns exactly', () => {
    expect(index.search('Avery Lancaster', 3)[0].chunk.id).toBe('c');
  });

  it('returns nothing for a query with no indexed terms', () => {
    expect(index.search('zzzz qqqq', 3)).toEqual([]);
  });

  it('ignores stopword-only queries', () => {
    expect(index.search('the and of', 3)).toEqual([]);
  });

  it('builds a vocabulary', () => {
    expect(index.vocabularySize).toBeGreaterThan(5);
    expect(index.size).toBe(3);
  });

  it('does not double-count a term repeated in the query', () => {
    const once = index.search('Apex', 3)[0].score;
    const twice = index.search('Apex Apex', 3)[0].score;
    expect(twice).toBeCloseTo(once, 10);
  });
});

describe('reciprocalRankFusion', () => {
  const dense = [
    { chunk: chunk('a', ''), score: 0.9 },
    { chunk: chunk('b', ''), score: 0.8 },
  ];
  const lexical = [
    { chunk: chunk('b', ''), score: 14.2 },
    { chunk: chunk('c', ''), score: 9.1 },
  ];

  it('promotes a chunk that both retrievers found', () => {
    const fused = reciprocalRankFusion([
      { source: 'dense', results: dense },
      { source: 'bm25', results: lexical },
    ]);
    expect(fused[0].chunk.id).toBe('b');
  });

  it('records provenance from every contributing list', () => {
    const fused = reciprocalRankFusion([
      { source: 'dense', results: dense, query: 'q1' },
      { source: 'bm25', results: lexical, query: 'q1' },
    ]);
    const b = fused.find((f) => f.chunk.id === 'b')!;
    expect(b.provenance.map((p) => p.source).sort()).toEqual(['bm25', 'dense']);
    expect(b.provenance.every((p) => p.query === 'q1')).toBe(true);
  });

  it('is unaffected by raw score scale', () => {
    const scaled = lexical.map((r) => ({ ...r, score: r.score * 1000 }));
    const a = reciprocalRankFusion([
      { source: 'dense', results: dense },
      { source: 'bm25', results: lexical },
    ]);
    const b = reciprocalRankFusion([
      { source: 'dense', results: dense },
      { source: 'bm25', results: scaled },
    ]);
    expect(a.map((r) => r.chunk.id)).toEqual(b.map((r) => r.chunk.id));
  });

  it('honours list weights', () => {
    // 'a' is exclusive to the dense list, 'c' exclusive to the lexical one, so
    // their relative order is decided purely by the weights.
    const denseHeavy = reciprocalRankFusion([
      { source: 'dense', results: dense, weight: 5 },
      { source: 'bm25', results: lexical, weight: 0.1 },
    ]).map((r) => r.chunk.id);
    expect(denseHeavy.indexOf('a')).toBeLessThan(denseHeavy.indexOf('c'));

    const lexicalHeavy = reciprocalRankFusion([
      { source: 'dense', results: dense, weight: 0.1 },
      { source: 'bm25', results: lexical, weight: 5 },
    ]).map((r) => r.chunk.id);
    expect(lexicalHeavy.indexOf('c')).toBeLessThan(lexicalHeavy.indexOf('a'));
  });

  it('keeps a chunk found by both lists ahead of either exclusive chunk', () => {
    // The k=60 damping means agreement between retrievers outweighs a single
    // list's top rank — the property that makes RRF robust.
    const fused = reciprocalRankFusion([
      { source: 'dense', results: dense },
      { source: 'bm25', results: lexical },
    ]).map((r) => r.chunk.id);
    expect(fused[0]).toBe('b');
  });

  it('assigns contiguous ranks', () => {
    const fused = reciprocalRankFusion([
      { source: 'dense', results: dense },
      { source: 'bm25', results: lexical },
    ]);
    expect(fused.map((f) => f.rank)).toEqual([1, 2, 3]);
  });

  it('handles empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ source: 'dense', results: [] }])).toEqual([]);
  });
});

describe('dedupe / toRetrieved', () => {
  it('toRetrieved numbers ranks from 1', () => {
    const out = toRetrieved([{ chunk: chunk('a', ''), score: 1 }], 'dense');
    expect(out[0].rank).toBe(1);
    expect(out[0].provenance[0].source).toBe('dense');
  });

  it('dedupe keeps the first occurrence and renumbers', () => {
    const out = dedupe([
      { chunk: chunk('a', ''), score: 1, provenance: [], rank: 1 },
      { chunk: chunk('a', ''), score: 0.5, provenance: [], rank: 2 },
      { chunk: chunk('b', ''), score: 0.4, provenance: [], rank: 3 },
    ]);
    expect(out.map((c) => c.chunk.id)).toEqual(['a', 'b']);
    expect(out.map((c) => c.rank)).toEqual([1, 2]);
    expect(out[0].score).toBe(1);
  });
});
