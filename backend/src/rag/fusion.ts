import { Chunk, RetrievalProvenance, RetrievalSource, RetrievedChunk } from '../common/types';
import { ScoredChunk } from './vector-index';

/**
 * Reciprocal Rank Fusion.
 *
 *   RRF(d) = sum over lists L of  weight_L / (k + rank_L(d))
 *
 * Fusing on *rank* rather than score is the whole point: a cosine similarity of
 * 0.82 and a BM25 score of 14.3 are not comparable quantities, and normalising
 * them (min-max, z-score) makes fusion depend on the score distribution of
 * whatever else happened to be retrieved. Rank is scale-free.
 *
 * k=60 is the constant from the original Cormack et al. paper; it damps the
 * influence of the very top ranks just enough that one list cannot dominate.
 */
export const RRF_K = 60;

export interface RankedList {
  source: RetrievalSource;
  results: ScoredChunk[];
  /** Relative influence of this list. Defaults to 1. */
  weight?: number;
  /** Sub-query that produced this list, recorded in provenance. */
  query?: string;
}

export function reciprocalRankFusion(lists: RankedList[], k = RRF_K): RetrievedChunk[] {
  const scores = new Map<string, number>();
  const chunks = new Map<string, Chunk>();
  const provenance = new Map<string, RetrievalProvenance[]>();

  for (const list of lists) {
    const weight = list.weight ?? 1;

    list.results.forEach((result, i) => {
      const rank = i + 1;
      const id = result.chunk.id;

      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
      chunks.set(id, result.chunk);

      const entries = provenance.get(id) ?? [];
      entries.push({ source: list.source, rank, score: result.score, query: list.query });
      provenance.set(id, entries);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score], i) => ({
      chunk: chunks.get(id)!,
      score,
      provenance: provenance.get(id) ?? [],
      rank: i + 1,
    }));
}

/** Wrap a plain scored list as RetrievedChunks, for single-retriever strategies. */
export function toRetrieved(
  results: ScoredChunk[],
  source: RetrievalSource,
  query?: string,
): RetrievedChunk[] {
  return results.map((r, i) => ({
    chunk: r.chunk,
    score: r.score,
    provenance: [{ source, rank: i + 1, score: r.score, query }],
    rank: i + 1,
  }));
}

/** Re-number ranks after a reorder or a slice, keeping the array self-consistent. */
export function renumber(chunks: RetrievedChunk[]): RetrievedChunk[] {
  return chunks.map((c, i) => ({ ...c, rank: i + 1 }));
}

/** Drop duplicate chunk ids, keeping the earliest occurrence. */
export function dedupe(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  const out: RetrievedChunk[] = [];
  for (const c of chunks) {
    if (seen.has(c.chunk.id)) continue;
    seen.add(c.chunk.id);
    out.push(c);
  }
  return renumber(out);
}
