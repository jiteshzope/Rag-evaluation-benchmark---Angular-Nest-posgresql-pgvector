import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
} from '@angular/core';

import type { QuestionResult, RetrievalProvenance } from '../../api/types';
import {
  RETRIEVAL_SOURCE_LABEL,
  STRATEGY_COLOR,
  fmtCost,
  fmtDuration,
  fmtScore,
  fmtTokens,
  questionTypeLabel,
} from '../../lib/format';

const VERDICT_STYLE: Record<string, string> = {
  pass: 'border-status-good/40 text-status-good',
  partial: 'border-status-warning/40 text-status-warning',
  fail: 'border-status-critical/40 text-status-critical',
};

interface ChunkRow {
  id: string;
  rank: number;
  score: string;
  docTitle: string;
  heading: string;
  text: string;
  isRelevant: boolean;
  relevance: string;
  provenance: Array<{ label: string; rank: string }>;
}

/**
 * Everything that happened for one question: the pipeline trace, the retrieved
 * chunks with their provenance, the keyword tick-list, both answers and the
 * judge's reasoning.
 *
 * For debugging retrieval this view matters more than any chart — it is where
 * "nDCG dropped on multi-hop" becomes "the reranker demoted the only chunk that
 * had the answer".
 */
@Component({
  selector: 'app-question-detail-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './question-detail-drawer.html',
})
export class QuestionDetailDrawer {
  readonly result = input.required<QuestionResult>();
  readonly close = output<void>();

  protected readonly fmtScore = fmtScore;
  protected readonly fmtCost = fmtCost;
  protected readonly fmtTokens = fmtTokens;
  protected readonly fmtDuration = fmtDuration;

  constructor() {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.close.emit();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';

    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    });
  }

  protected readonly strategyColor = computed(() => STRATEGY_COLOR[this.result().strategy]);
  protected readonly typeLabel = computed(() => questionTypeLabel(this.result().questionType));
  protected readonly verdictClass = computed(
    () => VERDICT_STYLE[this.result().answer.verdict] ?? '',
  );

  protected readonly keywordHitCount = computed(
    () => Object.values(this.result().keywordHits).filter(Boolean).length,
  );

  protected readonly relevantFound = computed(() => {
    const retrieval = this.result().retrieval;
    return `${retrieval.relevantRetrieved} / ${retrieval.relevantTotal}`;
  });

  protected readonly chunks = computed<ChunkRow[]>(() =>
    this.result().retrieved.map((item) => {
      const relevance = this.result().relevanceLabels[item.chunk.id] ?? 0;
      return {
        id: item.chunk.id,
        rank: item.rank,
        score: item.score.toFixed(3),
        docTitle: item.chunk.docTitle,
        heading:
          item.chunk.headingPath.length > 0 ? ` › ${item.chunk.headingPath.join(' › ')}` : '',
        text: item.chunk.text,
        isRelevant: relevance >= 0.5,
        relevance: relevance.toFixed(2),
        provenance: dedupeProvenance(item.provenance).map((p) => ({
          label: RETRIEVAL_SOURCE_LABEL[p.source] ?? p.source,
          rank: p.rank !== undefined ? ` #${p.rank}` : '',
        })),
      };
    }),
  );

  protected keywordHit(keyword: string): boolean {
    return !!this.result().keywordHits[keyword];
  }
}

/** One chip per source, keeping the best rank seen for it. */
function dedupeProvenance(provenance: RetrievalProvenance[]): RetrievalProvenance[] {
  const bySource = new Map<string, RetrievalProvenance>();
  for (const p of provenance) {
    const existing = bySource.get(p.source);
    if (!existing || (p.rank ?? Infinity) < (existing.rank ?? Infinity)) bySource.set(p.source, p);
  }
  return [...bySource.values()];
}
