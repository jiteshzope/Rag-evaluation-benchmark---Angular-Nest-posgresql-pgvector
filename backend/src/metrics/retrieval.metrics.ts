import { RetrievalMetrics, RetrievedChunk } from '../common/types';
import { keywordPresent } from '../ingestion/text-utils';

/**
 * Ranking metrics over a graded relevance map.
 *
 * `relevance` maps chunkId -> graded relevance in [0,1]. A chunk counts as
 * binary-relevant at or above `binaryThreshold`. Graded values feed nDCG (which
 * is defined for graded relevance); binary values feed MRR / Recall / Precision
 * / HitRate, which are defined for binary relevance.
 */
export const BINARY_RELEVANCE_THRESHOLD = 0.5;

export function reciprocalRank(
  ranked: RetrievedChunk[],
  relevance: Record<string, number>,
  threshold = BINARY_RELEVANCE_THRESHOLD,
): number {
  for (let i = 0; i < ranked.length; i++) {
    if ((relevance[ranked[i].chunk.id] ?? 0) >= threshold) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with the standard log2 discount and graded gains.
 *
 * gain = 2^rel - 1 with rel in [0,1], so a perfectly relevant chunk gains 1 and
 * a half-relevant one gains ~0.41. The ideal ranking used for normalisation is
 * the top-k of ALL labelled chunks, not just the retrieved ones — otherwise a
 * retriever that returns nothing relevant would score 1.0.
 */
export function ndcgAtK(
  ranked: RetrievedChunk[],
  relevance: Record<string, number>,
  k: number,
): number {
  const gains = ranked.slice(0, k).map((r) => gain(relevance[r.chunk.id] ?? 0));
  const dcg = gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);

  const idealRels = Object.values(relevance)
    .filter((v) => v > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  const idcg = idealRels.reduce((sum, rel, i) => sum + gain(rel) / Math.log2(i + 2), 0);

  if (idcg === 0) return 0;
  return Math.min(1, dcg / idcg);
}

function gain(rel: number): number {
  return Math.pow(2, Math.min(1, Math.max(0, rel))) - 1;
}

export function recallAtK(
  ranked: RetrievedChunk[],
  relevance: Record<string, number>,
  k: number,
  threshold = BINARY_RELEVANCE_THRESHOLD,
): number {
  const relevantIds = Object.entries(relevance)
    .filter(([, v]) => v >= threshold)
    .map(([id]) => id);
  if (relevantIds.length === 0) return 0;

  const retrievedIds = new Set(ranked.slice(0, k).map((r) => r.chunk.id));
  const hits = relevantIds.filter((id) => retrievedIds.has(id)).length;
  return hits / relevantIds.length;
}

export function precisionAtK(
  ranked: RetrievedChunk[],
  relevance: Record<string, number>,
  k: number,
  threshold = BINARY_RELEVANCE_THRESHOLD,
): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter((r) => (relevance[r.chunk.id] ?? 0) >= threshold).length;
  return hits / top.length;
}

export function hitRateAtK(
  ranked: RetrievedChunk[],
  relevance: Record<string, number>,
  k: number,
  threshold = BINARY_RELEVANCE_THRESHOLD,
): number {
  return ranked.slice(0, k).some((r) => (relevance[r.chunk.id] ?? 0) >= threshold) ? 1 : 0;
}

/**
 * Context Precision (RAGAS-style, rank-weighted).
 *
 * Mean of Precision@i taken at every rank i that holds a relevant chunk. Rewards
 * putting relevant chunks early, which plain Precision@k does not.
 */
export function contextPrecision(
  ranked: RetrievedChunk[],
  relevance: Record<string, number>,
  k: number,
  threshold = BINARY_RELEVANCE_THRESHOLD,
): number {
  const top = ranked.slice(0, k);
  let relevantSoFar = 0;
  let sum = 0;

  for (let i = 0; i < top.length; i++) {
    const isRelevant = (relevance[top[i].chunk.id] ?? 0) >= threshold;
    if (isRelevant) {
      relevantSoFar++;
      sum += relevantSoFar / (i + 1);
    }
  }

  return relevantSoFar === 0 ? 0 : sum / relevantSoFar;
}

/**
 * Context Recall proxy: what share of the reference answer's claim-bearing
 * keywords is actually present in the retrieved context. Answers "did we give
 * the generator enough to reconstruct the reference answer?" without a second
 * LLM call per question.
 */
export function contextRecall(
  ranked: RetrievedChunk[],
  expectedKeywords: string[],
  k: number,
): number {
  if (expectedKeywords.length === 0) return 0;
  const haystack = ranked
    .slice(0, k)
    .map((r) => r.chunk.text)
    .join('\n');
  const hits = expectedKeywords.filter((kw) => keywordPresent(kw, haystack)).length;
  return hits / expectedKeywords.length;
}

/** Fraction of expected keywords found anywhere in the retrieved context. */
export function keywordCoverage(text: string, expectedKeywords: string[]): number {
  if (expectedKeywords.length === 0) return 0;
  const hits = expectedKeywords.filter((kw) => keywordPresent(kw, text)).length;
  return hits / expectedKeywords.length;
}

/** Per-keyword hit map, for the tick-list in the per-question drawer. */
export function keywordHits(text: string, expectedKeywords: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const kw of expectedKeywords) out[kw] = keywordPresent(kw, text);
  return out;
}

export function evaluateRetrieval(
  ranked: RetrievedChunk[],
  relevance: Record<string, number>,
  expectedKeywords: string[],
  k: number,
): RetrievalMetrics {
  const contextText = ranked
    .slice(0, k)
    .map((r) => r.chunk.text)
    .join('\n');

  const relevantTotal = Object.values(relevance).filter(
    (v) => v >= BINARY_RELEVANCE_THRESHOLD,
  ).length;
  const relevantRetrieved = ranked
    .slice(0, k)
    .filter((r) => (relevance[r.chunk.id] ?? 0) >= BINARY_RELEVANCE_THRESHOLD).length;

  return {
    reciprocalRank: reciprocalRank(ranked, relevance),
    ndcg: ndcgAtK(ranked, relevance, k),
    recall: recallAtK(ranked, relevance, k),
    precision: precisionAtK(ranked, relevance, k),
    hitRate: hitRateAtK(ranked, relevance, k),
    contextKeywordCoverage: keywordCoverage(contextText, expectedKeywords),
    contextPrecision: contextPrecision(ranked, relevance, k),
    contextRecall: contextRecall(ranked, expectedKeywords, k),
    relevantRetrieved,
    relevantTotal,
  };
}
