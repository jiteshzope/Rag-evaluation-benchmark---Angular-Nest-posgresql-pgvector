import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import { fmtScore, questionTypeLabel } from '../../lib/format';
import { BarChart, type BarDatum, type BarSeries } from '../ui/bar-chart';
import { ChartLegend, EmptyChart } from '../ui/chart-bits';
import { ChartFrame, DataTable } from '../ui/chart-frame';

const SERIES: BarSeries[] = [
  { key: 'mrr', label: 'MRR', color: 'var(--series-1)' },
  { key: 'ndcg', label: 'nDCG@5', color: 'var(--series-2)' },
  { key: 'recall', label: 'Recall@5', color: 'var(--series-3)' },
];

/**
 * Retrieval quality broken out by question type, for one strategy.
 *
 * This is the chart that makes the benchmark worth building: an overall MRR of
 * 0.84 hides that a strategy may be excellent on direct facts and useless on
 * holistic questions. Grouping by type is what turns a single number into a
 * finding.
 */
@Component({
  selector: 'app-retrieval-by-type-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarChart, ChartFrame, ChartLegend, DataTable, EmptyChart],
  templateUrl: './retrieval-by-type-chart.html',
})
export class RetrievalByTypeChart {
  readonly summary = input.required<StrategySummary>();

  protected readonly series = SERIES;
  protected readonly legend = SERIES.map((s) => ({ label: s.label, color: s.color }));
  protected readonly scoreDomain: [number, number] = [0, 1];
  protected readonly scoreTicks = [0, 0.25, 0.5, 0.75, 1];

  protected readonly data = computed<BarDatum[]>(() =>
    this.summary().byQuestionType.map((row) => ({
      type: questionTypeLabel(row.questionType),
      count: row.count,
      mrr: row.mrr,
      ndcg: row.ndcg,
      recall: row.recall,
    })),
  );

  protected readonly minWidth = computed(() => Math.max(420, this.data().length * 130));

  protected readonly aside = computed(() => `${this.summary().label} · k=5`);

  protected readonly tableRows = computed(() =>
    this.data().map((r) => [
      String(r['type']),
      Number(r['count']),
      fmtScore(Number(r['mrr'])),
      fmtScore(Number(r['ndcg'])),
      fmtScore(Number(r['recall'])),
    ]),
  );

  protected readonly tickFormat = (v: number) => String(v);
  protected readonly tooltipFormat = (v: number) => fmtScore(v);

  /** Direct labels satisfy the relief rule for the light-mode series colours
      that sit below 3:1 contrast. */
  protected readonly labelFormat = (v: number) => (v >= 0.005 ? v.toFixed(2) : '');

  protected readonly tooltipFooter = (label: string): string | null => {
    const row = this.data().find((d) => d['type'] === label);
    if (!row) return null;
    const count = Number(row['count']);
    return `${count} question${count === 1 ? '' : 's'}`;
  };
}
