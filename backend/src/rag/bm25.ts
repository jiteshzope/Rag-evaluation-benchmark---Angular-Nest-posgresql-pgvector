import { Chunk } from '../common/types';
import { contentTokens, stem } from '../ingestion/text-utils';
import { ScoredChunk, topK } from './vector-index';

/**
 * Okapi BM25 lexical index.
 *
 * This is the half of hybrid retrieval that dense vectors are bad at: exact
 * identifiers, rare proper nouns, contract numbers, dates. An embedding of
 * "Contract with Apex Reinsurance" and one of "Contract with Belvedere
 * Insurance" sit almost on top of each other; BM25 separates them cleanly.
 *
 * Standard parameters: k1 controls term-frequency saturation, b controls
 * length normalisation.
 */
const K1 = 1.5;
const B = 0.75;

interface Posting {
  docIndex: number;
  termFreq: number;
}

export class Bm25Index {
  private readonly chunks: Chunk[] = [];
  private readonly postings = new Map<string, Posting[]>();
  private readonly docLengths: number[] = [];
  private avgDocLength = 0;

  static from(chunks: Chunk[]): Bm25Index {
    const index = new Bm25Index();
    index.build(chunks);
    return index;
  }

  build(chunks: Chunk[]): void {
    this.chunks.length = 0;
    this.postings.clear();
    this.docLengths.length = 0;

    chunks.forEach((chunk, docIndex) => {
      this.chunks.push(chunk);

      // Index the embedText so advanced-pro's contextual header is lexically
      // searchable too — otherwise the enrichment helps dense retrieval only.
      const terms = contentTokens(chunk.embedText).map(stem);
      this.docLengths.push(terms.length);

      const freqs = new Map<string, number>();
      for (const t of terms) freqs.set(t, (freqs.get(t) ?? 0) + 1);

      for (const [term, termFreq] of freqs) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push({ docIndex, termFreq });
      }
    });

    const total = this.docLengths.reduce((a, b) => a + b, 0);
    this.avgDocLength = this.docLengths.length > 0 ? total / this.docLengths.length : 0;
  }

  get size(): number {
    return this.chunks.length;
  }

  get vocabularySize(): number {
    return this.postings.size;
  }

  search(query: string, k: number): ScoredChunk[] {
    if (this.chunks.length === 0) return [];

    const queryTerms = contentTokens(query).map(stem);
    if (queryTerms.length === 0) return [];

    const scores = new Float64Array(this.chunks.length);
    const N = this.chunks.length;
    // De-duplicate so a term repeated in the query is not counted twice.
    const uniqueTerms = new Set(queryTerms);

    for (const term of uniqueTerms) {
      const list = this.postings.get(term);
      if (!list) continue;

      const df = list.length;
      // Robertson/Sparck-Jones IDF with the +0.5 smoothing that keeps it
      // non-negative even for terms present in every document.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (const { docIndex, termFreq } of list) {
        const norm = 1 - B + (B * this.docLengths[docIndex]) / (this.avgDocLength || 1);
        scores[docIndex] += idf * ((termFreq * (K1 + 1)) / (termFreq + K1 * norm));
      }
    }

    return topK(scores, k)
      .filter((r) => r.score > 0)
      .map(({ index, score }) => ({ chunk: this.chunks[index], score }));
  }
}
