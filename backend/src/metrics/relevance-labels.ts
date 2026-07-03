import { Chunk, EvaluationItem } from '../common/types';
import { contentTokens, keywordPresent, normalizeForMatch, stem } from '../ingestion/text-utils';

/**
 * MRR and nDCG are ranking metrics: they need to know which chunks *should*
 * have been retrieved. The shipped QA set has no gold chunk ids (and a user's
 * uploaded set will not either), so we derive graded relevance labels from the
 * evidence each item already carries.
 *
 * A chunk's relevance combines two independent signals:
 *
 *   keywordScore  fraction of the item's expectedKeywords present in the chunk
 *   answerScore   fraction of the reference answer's content words present
 *
 * relevance = 0.6 * keywordScore + 0.4 * answerScore, clamped to [0,1].
 *
 * Using both matters. Keywords alone are few and would make the labels a
 * near-tautology with the keyword-coverage metric; reference-answer overlap
 * alone is noisy because answers share common vocabulary with the whole corpus.
 * Together they identify the passages that actually carry the evidence.
 *
 * When an item *does* carry goldChunkIds (auto-generated datasets record the
 * chunk that produced the question) those are authoritative and score 1.0.
 *
 * Labels are computed once per (index, dataset) pair and reused for every
 * strategy, so all strategies are scored against identical ground truth.
 */

const KEYWORD_WEIGHT = 0.6;
const ANSWER_WEIGHT = 0.4;

/** A chunk is treated as relevant at or above this graded score. */
export const RELEVANCE_THRESHOLD = 0.5;

/** Rescue threshold — see `label()`. */
const FALLBACK_THRESHOLD = 0.25;
const FALLBACK_MAX_CHUNKS = 2;

export interface LabelledItem {
  /** chunkId -> graded relevance in [0,1]. Only non-zero entries are kept. */
  relevance: Record<string, number>;
  /** True when no chunk carried enough evidence to be labelled relevant. */
  unsupported: boolean;
}

interface PreparedChunk {
  id: string;
  normalizedText: string;
  stemSet: Set<string>;
}

/**
 * Precomputes the per-chunk work once, then labels each question cheaply.
 * Labelling 100 questions against ~1500 chunks is ~150k comparisons, so the
 * normalisation must not be repeated per question.
 */
export class RelevanceLabeler {
  private readonly prepared: PreparedChunk[];

  constructor(chunks: Chunk[]) {
    this.prepared = chunks.map((c) => ({
      id: c.id,
      normalizedText: normalizeForMatch(c.text),
      stemSet: new Set(contentTokens(c.text).map(stem)),
    }));
  }

  labelAll(items: EvaluationItem[]): Map<string, LabelledItem> {
    const out = new Map<string, LabelledItem>();
    for (const item of items) out.set(item.id, this.label(item));
    return out;
  }

  label(item: EvaluationItem): LabelledItem {
    // Explicit ground truth wins outright.
    if (item.goldChunkIds && item.goldChunkIds.length > 0) {
      const relevance: Record<string, number> = {};
      for (const id of item.goldChunkIds) relevance[id] = 1;
      return { relevance, unsupported: false };
    }

    const answerStems = new Set(contentTokens(item.referenceAnswer).map(stem));
    const scored: Array<{ id: string; score: number }> = [];

    for (const chunk of this.prepared) {
      const keywordScore = this.keywordScore(item.expectedKeywords, chunk);
      const answerScore = this.answerScore(answerStems, chunk);
      const score = KEYWORD_WEIGHT * keywordScore + ANSWER_WEIGHT * answerScore;
      if (score > 0) scored.push({ id: chunk.id, score: Math.min(1, score) });
    }

    const relevance: Record<string, number> = {};
    let anyRelevant = false;

    for (const { id, score } of scored) {
      relevance[id] = score;
      if (score >= RELEVANCE_THRESHOLD) anyRelevant = true;
    }

    if (anyRelevant) return { relevance, unsupported: false };

    // Nothing cleared the bar. Rather than scoring the question 0 for every
    // strategy — which would say more about the labeller than the retrievers —
    // promote the best few chunks that still carry meaningful evidence.
    const rescued = scored
      .filter((s) => s.score >= FALLBACK_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, FALLBACK_MAX_CHUNKS);

    if (rescued.length === 0) {
      return { relevance, unsupported: true };
    }

    for (const r of rescued) relevance[r.id] = Math.max(relevance[r.id] ?? 0, RELEVANCE_THRESHOLD);
    return { relevance, unsupported: false };
  }

  private keywordScore(keywords: string[], chunk: PreparedChunk): number {
    if (keywords.length === 0) return 0;
    let hits = 0;
    for (const kw of keywords) {
      if (keywordPresent(kw, chunk.normalizedText)) hits++;
    }
    return hits / keywords.length;
  }

  /** Containment of the reference answer's content words in the chunk. */
  private answerScore(answerStems: Set<string>, chunk: PreparedChunk): number {
    if (answerStems.size === 0) return 0;
    let hits = 0;
    for (const s of answerStems) {
      if (chunk.stemSet.has(s)) hits++;
    }
    return hits / answerStems.size;
  }
}
