import { asStringArray, normalizeQuestionType, parseCsvRows, parseDataset } from './dataset-parser';

describe('parseDataset', () => {
  it('parses a JSON array', () => {
    const out = parseDataset(
      JSON.stringify([
        { question: 'Q1?', reference_answer: 'A1', keywords: ['k1'], category: 'direct_fact' },
      ]),
    );
    expect(out.format).toBe('json');
    expect(out.items).toHaveLength(1);
    expect(out.items[0].question).toBe('Q1?');
    expect(out.items[0].referenceAnswer).toBe('A1');
    expect(out.items[0].expectedKeywords).toEqual(['k1']);
    expect(out.items[0].questionType).toBe('direct_fact');
  });

  it('parses JSONL in the shipped default format', () => {
    const jsonl = [
      '{"question":"Who founded it?","keywords":["Avery"],"reference_answer":"Avery did.","category":"direct_fact"}',
      '{"question":"When?","keywords":["2015"],"reference_answer":"In 2015.","category":"temporal"}',
    ].join('\n');
    const out = parseDataset(jsonl);
    expect(out.format).toBe('jsonl');
    expect(out.items).toHaveLength(2);
    expect(out.items[1].questionType).toBe('temporal');
  });

  it('parses CSV with quoted fields containing commas', () => {
    const csv = [
      'question,reference_answer,keywords,type',
      '"What, exactly?","It is, indeed, complex","a;b",factual',
    ].join('\n');
    const out = parseDataset(csv);
    expect(out.format).toBe('csv');
    expect(out.items[0].question).toBe('What, exactly?');
    expect(out.items[0].referenceAnswer).toBe('It is, indeed, complex');
    expect(out.items[0].expectedKeywords).toEqual(['a', 'b']);
    expect(out.items[0].questionType).toBe('direct_fact');
  });

  it('accepts alternative field names', () => {
    const out = parseDataset(JSON.stringify([{ query: 'Q?', answer: 'A', terms: 'x|y' }]));
    expect(out.items[0].question).toBe('Q?');
    expect(out.items[0].referenceAnswer).toBe('A');
    expect(out.items[0].expectedKeywords).toEqual(['x', 'y']);
  });

  it('skips unusable rows but keeps the good ones', () => {
    const out = parseDataset(
      JSON.stringify([
        { question: 'Good?', answer: 'Yes' },
        { question: 'No answer?' },
        { answer: 'No question' },
      ]),
    );
    expect(out.items).toHaveLength(1);
    expect(out.skipped).toHaveLength(2);
    expect(out.skipped[0].reason).toContain('reference_answer');
  });

  it('enforces MAX_QUESTIONS and flags the truncation', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ question: `Q${i}?`, answer: `A${i}` }));
    const out = parseDataset(JSON.stringify(many));
    expect(out.items).toHaveLength(100);
    expect(out.truncated).toBe(true);
  });

  it('assigns ids when the dataset has none', () => {
    const out = parseDataset(JSON.stringify([{ question: 'Q?', answer: 'A' }]));
    expect(out.items[0].id).toBeTruthy();
  });

  it('preserves supplied ids and gold chunk ids', () => {
    const out = parseDataset(
      JSON.stringify([{ id: 'custom-1', question: 'Q?', answer: 'A', goldChunkIds: ['c1', 'c2'] }]),
    );
    expect(out.items[0].id).toBe('custom-1');
    expect(out.items[0].goldChunkIds).toEqual(['c1', 'c2']);
  });

  it('rejects an empty dataset', () => {
    expect(() => parseDataset('   ')).toThrow(/empty/i);
  });

  it('rejects a dataset with no usable rows', () => {
    expect(() => parseDataset(JSON.stringify([{ nope: 1 }]))).toThrow(
      /needs a question and a reference answer/i,
    );
  });

  // The lenient field matching is invisible from outside, so a rejection has to
  // name the field spellings that would have worked.
  it('names the accepted field spellings when a row has no question', () => {
    expect(() => parseDataset(JSON.stringify([{ reference_answer: 'just an answer' }]))).toThrow(
      /"question", "query", "prompt" or "input"/,
    );
  });

  it('names the accepted field spellings when a row has no reference answer', () => {
    expect(() => parseDataset(JSON.stringify([{ question: 'just a question' }]))).toThrow(
      /"reference_answer", "answer" or "expected_answer"/,
    );
  });

  it('points at the offending line', () => {
    const jsonl = [
      '{"question":"Q1?","reference_answer":""}',
      '{"question":"","reference_answer":"A2"}',
    ].join('\n');
    expect(() => parseDataset(jsonl)).toThrow(/line 1/);
  });

  /**
   * Valid JSON that simply lacks the fields is a different mistake from text
   * that is not JSON at all, and saying the wrong one sends the user hunting
   * for a syntax error that does not exist.
   */
  it('does not blame JSON syntax when the lines parse but lack fields', () => {
    const jsonl = ['{"foo":1}', '{"bar":2}'].join('\n');
    expect(() => parseDataset(jsonl)).not.toThrow(/could be read as JSON/i);
    expect(() => parseDataset(jsonl)).toThrow(/needs a question and a reference answer/i);
  });

  it('does blame JSON syntax when no line is JSON', () => {
    expect(() => parseDataset('{not json\n{also not json')).toThrow(/could be read as JSON/i);
  });

  it('rejects unparseable input', () => {
    expect(() => parseDataset('this is just prose')).toThrow(/Could not parse/i);
  });
});

describe('parseCsvRows', () => {
  it('handles escaped double quotes', () => {
    expect(parseCsvRows('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']]);
  });

  it('handles newlines inside quoted fields', () => {
    expect(parseCsvRows('a,"line1\nline2"')).toEqual([['a', 'line1\nline2']]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsvRows('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('asStringArray', () => {
  it('accepts arrays, JSON strings and delimited strings', () => {
    expect(asStringArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(asStringArray('["a","b"]')).toEqual(['a', 'b']);
    expect(asStringArray('a, b')).toEqual(['a', 'b']);
    expect(asStringArray('a;b|c')).toEqual(['a', 'b', 'c']);
    expect(asStringArray('')).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
  });
});

describe('normalizeQuestionType', () => {
  it('passes through known types', () => {
    expect(normalizeQuestionType('direct_fact')).toBe('direct_fact');
    expect(normalizeQuestionType('holistic')).toBe('holistic');
  });

  it('maps synonyms and formatting variants', () => {
    expect(normalizeQuestionType('Multi-Hop')).toBe('multi_hop');
    expect(normalizeQuestionType('factual')).toBe('direct_fact');
    expect(normalizeQuestionType('comparison')).toBe('comparative');
    expect(normalizeQuestionType('summary')).toBe('summarization');
  });

  it('falls back to other rather than dropping the row', () => {
    expect(normalizeQuestionType('bespoke-label')).toBe('other');
    expect(normalizeQuestionType('')).toBe('other');
  });
});
