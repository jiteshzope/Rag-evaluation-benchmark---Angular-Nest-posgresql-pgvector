import { Chunk, EmbeddedChunk } from '../common/types';
import { dot } from '../ingestion/text-utils';

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/**
 * Flat in-memory vector index with exact cosine search.
 *
 * Exact search is the right call here, not a shortcut: the corpora are at most a
 * few thousand chunks, and an approximate index (HNSW/IVF) would introduce
 * recall loss that is indistinguishable from a retrieval-strategy difference —
 * which is the exact thing this benchmark exists to measure.
 *
 * Vectors are stored L2-normalised, so cosine similarity is a plain dot product.
 * They are packed into one contiguous Float32Array so a search is a linear scan
 * over cache-friendly memory rather than a walk over N separate objects.
 */
export class VectorIndex {
  private readonly chunks: Chunk[] = [];
  private matrix: Float32Array = new Float32Array(0);
  private dim = 0;

  static from(embedded: EmbeddedChunk[]): VectorIndex {
    const index = new VectorIndex();
    index.build(embedded);
    return index;
  }

  build(embedded: EmbeddedChunk[]): void {
    this.chunks.length = 0;
    this.dim = embedded[0]?.embedding.length ?? 0;
    this.matrix = new Float32Array(embedded.length * this.dim);

    embedded.forEach((e, i) => {
      const { embedding, ...rest } = e;
      this.chunks.push(rest);
      this.matrix.set(embedding, i * this.dim);
    });
  }

  get size(): number {
    return this.chunks.length;
  }

  get dimensions(): number {
    return this.dim;
  }

  /** Approximate heap footprint of the vectors plus chunk text. */
  get byteSize(): number {
    const textBytes = this.chunks.reduce((sum, c) => sum + c.text.length * 2 + c.embedText.length * 2, 0);
    return this.matrix.byteLength + textBytes;
  }

  allChunks(): readonly Chunk[] {
    return this.chunks;
  }

  /** Top-k by cosine similarity. `queryVector` must be L2-normalised. */
  search(queryVector: Float32Array, k: number): ScoredChunk[] {
    if (this.chunks.length === 0 || this.dim === 0) return [];

    const scores = new Float64Array(this.chunks.length);
    for (let i = 0; i < this.chunks.length; i++) {
      const offset = i * this.dim;
      let s = 0;
      for (let d = 0; d < this.dim; d++) s += this.matrix[offset + d] * queryVector[d];
      scores[i] = s;
    }

    return topK(scores, k).map(({ index, score }) => ({ chunk: this.chunks[index], score }));
  }

  /** Similarity between one stored chunk and a query vector. */
  scoreOf(chunkId: string, queryVector: Float32Array): number {
    const i = this.chunks.findIndex((c) => c.id === chunkId);
    if (i < 0) return 0;
    return dot(this.matrix.subarray(i * this.dim, (i + 1) * this.dim), queryVector);
  }

  getChunk(id: string): Chunk | undefined {
    return this.chunks.find((c) => c.id === id);
  }
}

/**
 * Partial selection of the k highest scores. Avoids sorting the whole score
 * array, which matters when k is 5 and the corpus is thousands of chunks.
 */
export function topK(scores: Float64Array, k: number): Array<{ index: number; score: number }> {
  const limit = Math.min(k, scores.length);
  if (limit <= 0) return [];

  const best: Array<{ index: number; score: number }> = [];

  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];

    if (best.length < limit) {
      best.push({ index: i, score });
      if (best.length === limit) best.sort((a, b) => b.score - a.score);
      continue;
    }

    if (score <= best[limit - 1].score) continue;

    // Insert into the sorted window, dropping the current worst.
    let pos = limit - 1;
    while (pos > 0 && best[pos - 1].score < score) {
      best[pos] = best[pos - 1];
      pos--;
    }
    best[pos] = { index: i, score };
  }

  if (best.length < limit) best.sort((a, b) => b.score - a.score);
  return best;
}
