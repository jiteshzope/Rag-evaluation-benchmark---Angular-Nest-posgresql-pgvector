import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import {
  STRATEGY_COLOR,
  fmtCost,
  fmtDuration,
  fmtScore,
  fmtTokens,
  relativeDelta,
} from '../../lib/format';
import { MetricFamily, StatTile } from './stat-tile';

/**
 * The headline row.
 *
 * When more than one strategy ran, deltas are shown against the *first*
 * strategy in the run rather than against the best one — a stable reference
 * point makes the numbers comparable between runs.
 */
@Component({
  selector: 'app-metrics-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MetricFamily, StatTile],
  templateUrl: './metrics-summary.html',
})
export class MetricsSummary {
  readonly summary = input.required<StrategySummary>();
  readonly comparison = input<StrategySummary | null>(null);

  protected readonly fmtScore = fmtScore;
  protected readonly fmtCost = fmtCost;
  protected readonly fmtTokens = fmtTokens;
  protected readonly fmtDuration = fmtDuration;

  protected readonly color = computed(() => STRATEGY_COLOR[this.summary().strategy]);

  protected readonly comparisonLabel = computed(() => {
    const comparison = this.comparison();
    const summary = this.summary();
    return comparison && comparison.strategy !== summary.strategy ? comparison.label : null;
  });

  protected readonly chunkCount = computed(() =>
    this.summary().indexing.chunkCount.toLocaleString(),
  );

  protected readonly verdictsValue = computed(() => {
    const summary = this.summary();
    return `${summary.verdicts.pass}/${summary.questionCount}`;
  });

  protected readonly verdictsHint = computed(() => {
    const summary = this.summary();
    return `${summary.verdicts.partial} partial · ${summary.verdicts.fail} fail`;
  });

  /** Relative change against the reference strategy, or null when it is the reference. */
  protected d(get: (s: StrategySummary) => number): number | null {
    const comparison = this.comparison();
    const summary = this.summary();
    if (!comparison || comparison.strategy === summary.strategy) return null;
    return relativeDelta(get(summary), get(comparison));
  }

  // Accessors kept as named methods so the template stays readable and the
  // delta for a metric always sits beside the value it belongs to.
  protected readonly getComposite = (s: StrategySummary) => s.compositeScore;
  protected readonly getNdcg = (s: StrategySummary) => s.retrieval['ndcg'];
  protected readonly getMrr = (s: StrategySummary) => s.retrieval['reciprocalRank'];
  protected readonly getRecall = (s: StrategySummary) => s.retrieval['recall'];
  protected readonly getPrecision = (s: StrategySummary) => s.retrieval['precision'];
  protected readonly getHitRate = (s: StrategySummary) => s.retrieval['hitRate'];
  protected readonly getContextPrecision = (s: StrategySummary) => s.retrieval['contextPrecision'];
  protected readonly getContextRecall = (s: StrategySummary) => s.retrieval['contextRecall'];
  protected readonly getContextKeywords = (s: StrategySummary) =>
    s.retrieval['contextKeywordCoverage'];
  protected readonly getJudge = (s: StrategySummary) => s.answer['judgeScore'];
  protected readonly getFaithfulness = (s: StrategySummary) => s.answer['faithfulness'];
  protected readonly getCorrectness = (s: StrategySummary) => s.answer['factualCorrectness'];
  protected readonly getRelevance = (s: StrategySummary) => s.answer['answerRelevance'];
  protected readonly getAnswerKeywords = (s: StrategySummary) => s.answer['answerKeywordCoverage'];
  protected readonly getRefSimilarity = (s: StrategySummary) => s.answer['referenceSimilarity'];
  protected readonly getCostPerQuestion = (s: StrategySummary) => s.usagePerQuestion.costUsd;
  protected readonly getTokensPerQuestion = (s: StrategySummary) => s.usagePerQuestion.totalTokens;
  protected readonly getP95Latency = (s: StrategySummary) => s.latency.total.p95;
}
