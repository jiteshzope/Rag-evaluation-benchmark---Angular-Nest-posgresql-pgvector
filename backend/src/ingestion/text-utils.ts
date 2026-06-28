/**
 * Small, dependency-free text helpers shared by chunking, BM25 and the metrics.
 * Deliberately pure so they can be unit tested without booting Nest.
 */

/**
 * Cheap token estimate. Only used for chunk sizing and UI display — every
 * reported cost figure comes from the usage block the API actually returns.
 * ~4 chars/token is the standard approximation for English with cl100k/o200k.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

const ENGLISH_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'of', 'in', 'on', 'at', 'to', 'from', 'by', 'for', 'with',
  'about', 'as', 'into', 'through', 'during', 'it', 'its', 'he', 'she', 'they', 'them',
  'his', 'her', 'their', 'we', 'our', 'you', 'your', 'i', 'me', 'my', 'what', 'which',
  'who', 'whom', 'how', 'when', 'where', 'why', 'can', 'will', 'would', 'should', 'could',
  'there', 'here', 'so', 'not', 'no', 'all', 'any', 'each', 'more', 'most', 'other', 'some',
]);

/** Lowercase, strip punctuation, split on whitespace. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Tokenize + drop stopwords + drop 1-char tokens. Used for BM25 and keywords. */
export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1 && !ENGLISH_STOPWORDS.has(t));
}

/** Normalised form used when testing whether a keyword appears in a passage. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s'%$.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Very small suffix-stripping stemmer — enough to bridge plural/possessive forms. */
export function stem(word: string): string {
  let w = word;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

function stemEq(a: string, b: string): boolean {
  return a === b || stem(a) === stem(b);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Substring search that will not match inside a larger word, so the keyword
 * "2015" does not fire on "2015000" and "IQ" does not fire on "IQTest".
 */
function includesAtWordBoundary(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return false;
    const before = i === 0 ? undefined : haystack[i - 1];
    const after = haystack[i + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = i + 1;
  }
}

/**
 * Does `keyword` occur in `haystack`?
 *
 * Multi-word keywords are matched as a phrase first; if that fails we accept the
 * keyword when every word is present within a short span (handles "Avery
 * Lancaster" vs "Lancaster, Avery"). Single words match on a word boundary so
 * "2015" does not match "2015000", with a light stem fallback so "contracts"
 * matches "contract".
 */
export function keywordPresent(keyword: string, haystack: string): boolean {
  const k = normalizeForMatch(keyword);
  if (!k) return false;
  const h = normalizeForMatch(haystack);
  if (!h) return false;

  if (includesAtWordBoundary(h, k)) return true;

  const kWords = k.split(' ').filter(Boolean);
  const hWords = h.split(' ');

  if (kWords.length > 1) {
    const positions = kWords.map((w) => hWords.findIndex((hw) => stemEq(hw, w)));
    if (positions.every((p) => p >= 0)) {
      const span = Math.max(...positions) - Math.min(...positions);
      return span <= kWords.length * 4;
    }
    return false;
  }

  return hWords.some((hw) => stemEq(hw, k));
}

/** Collapse the whitespace noise that PDF and DOCX extraction leaves behind. */
export function cleanExtractedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Trim to a character budget on a paragraph/sentence boundary so the tail of the
 * corpus is not cut mid-word.
 */
export function trimToChars(text: string, maxChars: number): { text: string; trimmed: boolean } {
  if (text.length <= maxChars) return { text, trimmed: false };
  const slice = text.slice(0, maxChars);
  const breakAt = Math.max(
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('\n'),
  );
  const cut = breakAt > maxChars * 0.8 ? breakAt : maxChars;
  return { text: slice.slice(0, cut).trim(), trimmed: true };
}

/** Stand-in for a period inside a known abbreviation, so it never ends a sentence. */
const ABBREVIATION_DOT = '<!DOT!>';

/** Split into sentences. Handles the common abbreviation traps well enough. */
export function splitSentences(text: string): string[] {
  const guarded = text.replace(
    /\b(Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Co|Corp|St|vs|etc|e\.g|i\.e|No|Fig|Jr|Sr|U\.S)\./gi,
    (m) => m.replace(/\./g, ABBREVIATION_DOT),
  );

  return guarded
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\[])|\n{2,}/)
    .map((s) => s.split(ABBREVIATION_DOT).join('.').trim())
    .filter((s) => s.length > 0);
}

export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  let dotProduct = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dotProduct += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dotProduct / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Dot product — equivalent to cosine when both vectors are L2-normalised. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );

  return results;
}

/** Deterministic short id from a string — keeps chunk ids stable across runs. */
export function hashId(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (((h2 >>> 0) * 4294967296 + (h1 >>> 0)) >>> 0).toString(36) +
    ((h2 >>> 0) % 46656).toString(36).padStart(3, '0');
}
