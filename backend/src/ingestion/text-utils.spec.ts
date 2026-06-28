import {
  contentTokens,
  cosineSimilarity,
  estimateTokens,
  hashId,
  keywordPresent,
  l2Normalize,
  mapWithConcurrency,
  splitSentences,
  stem,
  trimToChars,
} from './text-utils';

describe('estimateTokens', () => {
  it('is zero for empty and positive otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });
});

describe('keywordPresent', () => {
  it('matches a plain substring', () => {
    expect(keywordPresent('IIOTY', 'won the IIOTY award in 2023')).toBe(true);
  });

  it('matches a multi-word keyword as a phrase', () => {
    expect(keywordPresent('Avery Lancaster', 'Assurio was founded by Avery Lancaster in 2015')).toBe(
      true,
    );
  });

  it('matches a multi-word keyword when the words are reordered but close', () => {
    expect(keywordPresent('Avery Lancaster', 'Lancaster, Avery — Chief Executive Officer')).toBe(
      true,
    );
  });

  it('rejects a multi-word keyword whose words are far apart', () => {
    const haystack = `Avery joined early. ${'filler word '.repeat(30)} Lancaster Street is nearby.`;
    expect(keywordPresent('Avery Lancaster', haystack)).toBe(false);
  });

  it('respects word boundaries for numbers', () => {
    expect(keywordPresent('2015', 'revenue of 2015000 dollars')).toBe(false);
    expect(keywordPresent('2015', 'founded in 2015 by two engineers')).toBe(true);
  });

  it('bridges simple plural forms', () => {
    expect(keywordPresent('contracts', 'holds one active contract')).toBe(true);
  });

  it('is false for an empty keyword or empty haystack', () => {
    expect(keywordPresent('', 'anything')).toBe(false);
    expect(keywordPresent('thing', '')).toBe(false);
  });
});

describe('stem', () => {
  it('strips common suffixes without destroying short words', () => {
    expect(stem('contracts')).toBe('contract');
    expect(stem('policies')).toBe('policy');
    expect(stem('ss')).toBe('ss');
    expect(stem('is')).toBe('is');
  });
});

describe('splitSentences', () => {
  it('does not split on abbreviations', () => {
    const out = splitSentences('Dr. Smith joined Inc. in 2015. He left in 2020.');
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Dr. Smith');
    expect(out[0]).toContain('Inc. in 2015.');
  });

  it('splits on blank lines', () => {
    expect(splitSentences('para one\n\npara two')).toHaveLength(2);
  });
});

describe('trimToChars', () => {
  it('does not trim when under budget', () => {
    const r = trimToChars('short', 100);
    expect(r.trimmed).toBe(false);
    expect(r.text).toBe('short');
  });

  it('trims on a boundary and flags it', () => {
    const r = trimToChars('aaaa. bbbb. cccc. dddd. eeee.', 20);
    expect(r.trimmed).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20);
  });
});

describe('contentTokens', () => {
  it('drops stopwords and single characters', () => {
    expect(contentTokens('The quick brown fox and a dog')).toEqual(['quick', 'brown', 'fox', 'dog']);
  });
});

describe('vector helpers', () => {
  it('cosineSimilarity is 1 for identical and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('cosineSimilarity handles a zero vector without NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('l2Normalize produces a unit vector', () => {
    const v = l2Normalize(new Float32Array([3, 4]));
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
  });
});

describe('hashId', () => {
  it('is deterministic and distinguishes near-identical input', () => {
    expect(hashId('abc')).toBe(hashId('abc'));
    expect(hashId('abc')).not.toBe(hashId('abd'));
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and bounds parallelism', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty input', async () => {
    await expect(mapWithConcurrency([], 4, async (x) => x)).resolves.toEqual([]);
  });
});
