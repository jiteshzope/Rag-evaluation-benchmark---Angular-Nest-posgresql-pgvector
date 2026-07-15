import { BadRequestException } from '@nestjs/common';

import { EvaluationItem, KNOWN_QUESTION_TYPES, QuestionType } from '../common/types';
import { MAX_QUESTIONS } from '../config/limits';

export interface ParsedDataset {
  items: EvaluationItem[];
  /** Rows that could not be understood, with the reason. */
  skipped: Array<{ line: number; reason: string }>;
  truncated: boolean;
  format: 'json' | 'jsonl' | 'csv';
}

/**
 * Accepts the shapes a user is realistically going to paste or upload:
 * JSON array, JSONL, or CSV. Field names are matched leniently — a dataset
 * calling the field `answer` or `reference_answer` or `referenceAnswer` all
 * work, because rejecting a dataset over a naming convention is a pointless
 * failure mode.
 */
export function parseDataset(raw: string): ParsedDataset {
  const text = raw.trim();
  if (!text) {
    throw new BadRequestException(
      'The evaluation dataset is empty. Provide questions as a JSON array, as JSONL ' +
        '(one object per line), or as CSV with a header row.',
    );
  }

  if (text.startsWith('[')) return finish(parseJsonArray(text), 'json');
  if (text.startsWith('{')) return finish(parseJsonLines(text), 'jsonl');
  if (looksLikeCsv(text)) return finish(parseCsv(text), 'csv');

  // A file of JSON objects one per line does not start with '{' if it has a
  // leading blank line; try JSONL before giving up.
  try {
    return finish(parseJsonLines(text), 'jsonl');
  } catch {
    throw new BadRequestException(
      'Could not parse the dataset. Provide a JSON array, JSONL (one object per line), or CSV ' +
        'with a header row containing at least "question" and "reference_answer".',
    );
  }
}

interface Accumulator {
  items: EvaluationItem[];
  skipped: Array<{ line: number; reason: string }>;
}

function finish(acc: Accumulator, format: ParsedDataset['format']): ParsedDataset {
  if (acc.items.length === 0) {
    const first = acc.skipped[0];
    throw new BadRequestException(
      acc.skipped.length
        ? `None of the ${acc.skipped.length} row(s) in this dataset could be used. Every row needs ` +
            `a question and a reference answer to grade against. ` +
            `First problem — line ${first.line}: ${first.reason}.`
        : 'This dataset contains no rows. Each row needs a question and a reference answer.',
    );
  }

  const truncated = acc.items.length > MAX_QUESTIONS;
  return {
    items: truncated ? acc.items.slice(0, MAX_QUESTIONS) : acc.items,
    skipped: acc.skipped,
    truncated,
    format,
  };
}

function parseJsonArray(text: string): Accumulator {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BadRequestException(
      `This dataset is not valid JSON: ${(err as Error).message}. ` +
        'A trailing comma or an unclosed bracket is the usual cause.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new BadRequestException(
      'This is one JSON object, not a list of questions. Wrap them in an array — ' +
        '[ { "question": …, "reference_answer": … } ] — or put one object on each line.',
    );
  }

  const acc: Accumulator = { items: [], skipped: [] };
  parsed.forEach((row, i) => absorb(acc, row, i + 1));
  return acc;
}

function parseJsonLines(text: string): Accumulator {
  const acc: Accumulator = { items: [], skipped: [] };
  const lines = text.split('\n');
  let unparseable = 0;
  let nonEmpty = 0;

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    nonEmpty++;
    try {
      absorb(acc, JSON.parse(trimmed), i + 1);
    } catch {
      unparseable++;
      acc.skipped.push({ line: i + 1, reason: 'not valid JSON' });
    }
  });

  // Only blame the JSON when the JSON is actually what failed. Lines that parsed
  // fine but lacked a question or an answer fall through to finish(), which can
  // name the real problem and the line it is on.
  if (nonEmpty > 0 && unparseable === nonEmpty) {
    throw new BadRequestException(
      'None of these lines could be read as JSON. JSONL needs one complete JSON object per ' +
        'line, each on a single line and with no trailing commas.',
    );
  }
  return acc;
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text.split('\n')[0]?.toLowerCase() ?? '';
  return firstLine.includes(',') && firstLine.includes('question');
}

function parseCsv(text: string): Accumulator {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (!header) {
    throw new BadRequestException(
      'This CSV has no header row. The first line must name the columns, and has to include ' +
        'at least "question" and "reference_answer".',
    );
  }

  const columns = header.map((h) => normalizeKey(h));
  const acc: Accumulator = { items: [], skipped: [] };

  rows.forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return;
    const row: Record<string, string> = {};
    columns.forEach((col, ci) => {
      row[col] = cells[ci] ?? '';
    });
    absorb(acc, row, i + 2);
  });

  return acc;
}

/** RFC4180-ish CSV reader: handles quoted fields, embedded commas and newlines. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** `"a", "b" or "c"` — for listing accepted field names in an error. */
function quoted(names: string[]): string {
  const q = names.map((n) => `"${n}"`);
  return q.length > 1 ? `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}` : q[0];
}

/** Field aliases, normalised (lowercase, no separators). */
const FIELD_ALIASES: Record<string, string[]> = {
  question: ['question', 'query', 'prompt', 'input'],
  referenceAnswer: [
    'referenceanswer',
    'answer',
    'groundtruth',
    'expectedanswer',
    'gold',
    'goldanswer',
    'response',
  ],
  expectedKeywords: ['expectedkeywords', 'keywords', 'keyword', 'expectedterms', 'terms'],
  questionType: ['questiontype', 'type', 'category', 'kind', 'class'],
  goldChunkIds: ['goldchunkids', 'goldchunks', 'relevantchunks', 'chunkids'],
  id: ['id', 'questionid', 'itemid'],
};

function pick(row: Record<string, unknown>, field: keyof typeof FIELD_ALIASES): unknown {
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) normalized[normalizeKey(k)] = v;
  for (const alias of FIELD_ALIASES[field]) {
    if (normalized[alias] !== undefined && normalized[alias] !== '') return normalized[alias];
  }
  return undefined;
}

function absorb(acc: Accumulator, raw: unknown, line: number): void {
  if (!raw || typeof raw !== 'object') {
    acc.skipped.push({ line, reason: 'not an object' });
    return;
  }

  const row = raw as Record<string, unknown>;
  const question = asString(pick(row, 'question'));
  const referenceAnswer = asString(pick(row, 'referenceAnswer'));

  // Name the aliases in the reason. Lenient field matching is invisible from the
  // outside, so "missing question" reads as a lie to someone who wrote "q".
  if (!question) {
    acc.skipped.push({
      line,
      reason: `no question field (use ${quoted(FIELD_ALIASES.question)})`,
    });
    return;
  }
  if (!referenceAnswer) {
    acc.skipped.push({
      line,
      reason: `no reference answer (use ${quoted(['reference_answer', 'answer', 'expected_answer'])})`,
    });
    return;
  }

  acc.items.push({
    id: asString(pick(row, 'id')) || `q${acc.items.length + 1}`,
    question,
    referenceAnswer,
    expectedKeywords: asStringArray(pick(row, 'expectedKeywords')),
    questionType: normalizeQuestionType(asString(pick(row, 'questionType'))),
    goldChunkIds: asStringArray(pick(row, 'goldChunkIds')),
  });
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Accepts a real array, a JSON-encoded array, or a delimited string. */
export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v)).filter(Boolean);
  }
  const s = asString(value);
  if (!s) return [];

  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((v) => asString(v)).filter(Boolean);
    } catch {
      /* fall through to delimiter splitting */
    }
  }

  return s
    .split(/[;,|]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Maps a free-text type onto the taxonomy. Unrecognised values become "other"
 * rather than being dropped, so a dataset with its own labels still runs and
 * still groups sensibly in the by-question-type charts.
 */
export function normalizeQuestionType(value: string): QuestionType {
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!v) return 'other';

  if ((KNOWN_QUESTION_TYPES as string[]).includes(v)) return v as QuestionType;

  const synonyms: Record<string, QuestionType> = {
    fact: 'direct_fact',
    factual: 'direct_fact',
    direct: 'direct_fact',
    simple: 'direct_fact',
    lookup: 'direct_fact',
    multihop: 'multi_hop',
    multi: 'multi_hop',
    reasoning: 'multi_hop',
    inference: 'multi_hop',
    compare: 'comparative',
    comparison: 'comparative',
    time: 'temporal',
    date: 'temporal',
    chronological: 'temporal',
    number: 'numerical',
    numeric: 'numerical',
    quantity: 'numerical',
    count: 'numerical',
    aggregation: 'numerical',
    relation: 'relationship',
    relational: 'relationship',
    connection: 'relationship',
    entity: 'relationship',
    span: 'spanning',
    spanning_docs: 'spanning',
    crossdocument: 'spanning',
    multidoc: 'spanning',
    global: 'holistic',
    overall: 'holistic',
    thematic: 'holistic',
    theme: 'holistic',
    summary: 'summarization',
    summarize: 'summarization',
    summarisation: 'summarization',
    define: 'definition',
    what_is: 'definition',
    procedure: 'procedural',
    howto: 'procedural',
    process: 'procedural',
    steps: 'procedural',
  };

  return synonyms[v] ?? 'other';
}
