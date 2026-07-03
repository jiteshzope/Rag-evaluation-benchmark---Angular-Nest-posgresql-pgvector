import { Chunk, RetrievedChunk } from '../common/types';
import {
  contextPrecision,
  contextRecall,
  evaluateRetrieval,
  hitRateAtK,
  keywordCoverage,
  keywordHits,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from './retrieval.metrics';

function chunk(id: string, text = ''): Chunk {
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

function ranked(ids: string[], texts: Record<string, string> = {}): RetrievedChunk[] {
  return ids.map((id, i) => ({
    chunk: chunk(id, texts[id] ?? ''),
    score: 1 - i * 0.1,
    provenance: [],
    rank: i + 1,
  }));
}

describe('reciprocalRank', () => {
  it('is 1 when the first result is relevant', () => {
    expect(reciprocalRank(ranked(['a', 'b', 'c']), { a: 1 })).toBe(1);
  });

  it('is 1/rank of the first relevant result', () => {
    expect(reciprocalRank(ranked(['a', 'b', 'c']), { c: 1 })).toBeCloseTo(1 / 3, 6);
  });

  it('is 0 when nothing relevant was retrieved', () => {
    expect(reciprocalRank(ranked(['a', 'b']), { z: 1 })).toBe(0);
  });

  it('ignores chunks below the binary threshold', () => {
    expect(reciprocalRank(ranked(['a', 'b']), { a: 0.3, b: 1 })).toBeCloseTo(0.5, 6);
  });
});

describe('ndcgAtK', () => {
  it('is 1 for the ideal ranking', () => {
    expect(ndcgAtK(ranked(['a', 'b']), { a: 1, b: 1 }, 5)).toBeCloseTo(1, 6);
  });

  it('penalises a relevant result placed lower', () => {
    const good = ndcgAtK(ranked(['a', 'x', 'y']), { a: 1 }, 5);
    const bad = ndcgAtK(ranked(['x', 'y', 'a']), { a: 1 }, 5);
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeCloseTo(1, 6);
  });

  it('is 0 when nothing relevant is retrieved', () => {
    expect(ndcgAtK(ranked(['x', 'y']), { a: 1 }, 5)).toBe(0);
  });

  it('is 0 (not 1) when there are no labels at all', () => {
    expect(ndcgAtK(ranked(['x']), {}, 5)).toBe(0);
  });

  it('normalises against all labelled chunks, not just retrieved ones', () => {
    // Two relevant chunks exist; only the second-best was retrieved.
    const score = ndcgAtK(ranked(['b']), { a: 1, b: 1 }, 5);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('rewards higher graded relevance earlier', () => {
    const better = ndcgAtK(ranked(['a', 'b']), { a: 1, b: 0.5 }, 5);
    const worse = ndcgAtK(ranked(['b', 'a']), { a: 1, b: 0.5 }, 5);
    expect(better).toBeGreaterThan(worse);
  });

  it('never exceeds 1', () => {
    expect(ndcgAtK(ranked(['a', 'b', 'c']), { a: 1, b: 1, c: 1 }, 5)).toBeLessThanOrEqual(1);
  });
});

describe('recall / precision / hitRate', () => {
  it('recall counts relevant chunks found over relevant chunks that exist', () => {
    expect(recallAtK(ranked(['a', 'x']), { a: 1, b: 1 }, 5)).toBeCloseTo(0.5, 6);
  });

  it('precision counts relevant chunks over chunks returned', () => {
    expect(precisionAtK(ranked(['a', 'x']), { a: 1 }, 5)).toBeCloseTo(0.5, 6);
  });

  it('precision respects the k cutoff', () => {
    expect(precisionAtK(ranked(['a', 'x', 'y', 'z']), { a: 1 }, 2)).toBeCloseTo(0.5, 6);
  });

  it('hitRate is binary', () => {
    expect(hitRateAtK(ranked(['x', 'a']), { a: 1 }, 5)).toBe(1);
    expect(hitRateAtK(ranked(['x', 'y']), { a: 1 }, 5)).toBe(0);
  });

  it('handles an empty retrieval without NaN', () => {
    expect(precisionAtK([], { a: 1 }, 5)).toBe(0);
    expect(recallAtK([], { a: 1 }, 5)).toBe(0);
    expect(hitRateAtK([], { a: 1 }, 5)).toBe(0);
  });
});

describe('contextPrecision', () => {
  it('rewards relevant chunks placed early', () => {
    const early = contextPrecision(ranked(['a', 'x', 'y']), { a: 1 }, 5);
    const late = contextPrecision(ranked(['x', 'y', 'a']), { a: 1 }, 5);
    expect(early).toBe(1);
    expect(late).toBeCloseTo(1 / 3, 6);
  });

  it('is 0 when nothing relevant is present', () => {
    expect(contextPrecision(ranked(['x']), { a: 1 }, 5)).toBe(0);
  });

  it('averages precision at each relevant rank', () => {
    // relevant at ranks 1 and 3 -> (1/1 + 2/3) / 2
    expect(contextPrecision(ranked(['a', 'x', 'b']), { a: 1, b: 1 }, 5)).toBeCloseTo(
      (1 + 2 / 3) / 2,
      6,
    );
  });
});

describe('keyword metrics', () => {
  const texts = { a: 'Avery Lancaster founded the company in 2015.' };

  it('keywordCoverage is the fraction of keywords present', () => {
    expect(keywordCoverage(texts.a, ['Avery Lancaster', '2015'])).toBe(1);
    expect(keywordCoverage(texts.a, ['Avery Lancaster', '2020'])).toBeCloseTo(0.5, 6);
    expect(keywordCoverage(texts.a, [])).toBe(0);
  });

  it('keywordHits reports each keyword individually', () => {
    expect(keywordHits(texts.a, ['2015', 'IIOTY'])).toEqual({ '2015': true, IIOTY: false });
  });

  it('contextRecall looks only at the top k chunks', () => {
    const r = ranked(['a', 'b'], { a: 'mentions 2015', b: 'mentions Avery Lancaster' });
    expect(contextRecall(r, ['2015', 'Avery Lancaster'], 2)).toBe(1);
    expect(contextRecall(r, ['2015', 'Avery Lancaster'], 1)).toBeCloseTo(0.5, 6);
  });
});

describe('evaluateRetrieval', () => {
  it('produces a complete, in-range metric set', () => {
    const r = ranked(['a', 'x'], { a: 'founded in 2015 by Avery Lancaster', x: 'unrelated' });
    const m = evaluateRetrieval(r, { a: 1, b: 1 }, ['2015'], 5);

    expect(m.reciprocalRank).toBe(1);
    expect(m.hitRate).toBe(1);
    expect(m.recall).toBeCloseTo(0.5, 6);
    expect(m.precision).toBeCloseTo(0.5, 6);
    expect(m.contextKeywordCoverage).toBe(1);
    expect(m.relevantRetrieved).toBe(1);
    expect(m.relevantTotal).toBe(2);

    for (const [key, value] of Object.entries(m)) {
      if (key === 'relevantRetrieved' || key === 'relevantTotal') continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('is all-zero but not NaN when retrieval returns nothing', () => {
    const m = evaluateRetrieval([], { a: 1 }, ['x'], 5);
    expect(Object.values(m).every((v) => Number.isFinite(v))).toBe(true);
    expect(m.reciprocalRank).toBe(0);
  });
});
