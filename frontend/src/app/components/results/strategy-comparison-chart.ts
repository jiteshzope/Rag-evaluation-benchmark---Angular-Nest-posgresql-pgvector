import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import { STRATEGY_COLOR, STRATEGY_SHORT, fmtScore } from '../../lib/format';
import { BarChart, type BarDatum, type BarSeries } from '../ui/bar-chart';
import { ChartLegend, EmptyChart } from '../ui/chart-bits';
import { ChartFrame, DataTable } from '../ui/chart-frame';

const METRICS = [
  { key: 'ndcg', label: 'nDCG@5', get: (s: StrategySummary) => s.retrieval['ndcg'] },
  { key: 'mrr', label: 'MRR', get: (s: StrategySummary) => s.retrieval['reciprocalRank'] },
  { key: 'recall', label: 'Recall@5', get: (s: StrategySummary) => s.retrieval['recall'] },
  {
    key: 'faithfulness',
    label: 'Faithfulness',
    get: (s: StrategySummary) => s.answer['faithfulness'],
  },
  {
    key: 'correctness',
    label: 'Correctness',
    get: (s: StrategySummary) => s.answer['factualCorrectness'],
  },
  { key: 'judge', label: 'Judge', get: (s: StrategySummary) => s.answer['judgeScore'] },
] as const;

/**
 * Head-to-head across every strategy in the run.
 *
 * Metrics on the x-axis and strategies as series (rather than the reverse):
 * the reader's question here is "which strategy wins on this metric", so the
 * bars that need to sit side by side are the strategies.
 */
@Component({
  selector: 'app-strategy-comparison-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarChart, ChartFrame, ChartLegend, DataTable, EmptyChart],
  templateUrl: './strategy-comparison-chart.html',
})
export class StrategyComparisonChart {
  readonly summaries = input.required<StrategySummary[]>();

  protected readonly scoreDomain: [number, number] = [0, 1];
  protected readonly scoreTicks = [0, 0.25, 0.5, 0.75, 1];
  protected readonly comparisonMargin = { top: 18, right: 8, bottom: 4, left: 0 };
  protected readonly minWidth = Math.max(480, METRICS.length * 92);

  protected readonly series = computed<BarSeries[]>(() =>
    this.summaries().map((s) => ({
      key: s.strategy,
      label: STRATEGY_SHORT[s.strategy],
      color: STRATEGY_COLOR[s.strategy],
    })),
  );

  protected readonly legend = computed(() =>
    this.summaries().map((s) => ({
      label: STRATEGY_SHORT[s.strategy],
      color: STRATEGY_COLOR[s.strategy],
    })),
  );

  protected readonly data = computed<BarDatum[]>(() =>
    METRICS.map((metric) => {
      const row: BarDatum = { metric: metric.label };
      for (const s of this.summaries()) row[s.strategy] = metric.get(s);
      return row;
    }),
  );

  protected readonly aside = computed(
    () => `${this.summaries()[0]?.questionCount ?? 0} questions each`,
  );

  protected readonly tableColumns = computed(() => [
    'Metric',
    ...this.summaries().map((s) => STRATEGY_SHORT[s.strategy]),
  ]);

  protected readonly tableRows = computed(() =>
    METRICS.map((m) => [m.label, ...this.summaries().map((s) => fmtScore(m.get(s)))]),
  );

  protected readonly tickFormat = (v: number) => String(v);
  protected readonly tooltipFormat = (v: number) => fmtScore(v);
  protected readonly labelFormat = (v: number) => (v >= 0.005 ? v.toFixed(2) : '');
}
