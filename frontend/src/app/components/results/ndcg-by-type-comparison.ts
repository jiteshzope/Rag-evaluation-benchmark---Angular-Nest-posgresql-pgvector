import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import { STRATEGY_COLOR, STRATEGY_SHORT, fmtScore, questionTypeLabel } from '../../lib/format';
import { BarChart, type BarDatum, type BarSeries } from '../ui/bar-chart';
import { ChartLegend, EmptyChart } from '../ui/chart-bits';
import { ChartFrame, DataTable } from '../ui/chart-frame';

/**
 * nDCG by question type across strategies — the "which question types benefit"
 * view. This is the chart that usually carries the actual finding.
 */
@Component({
  selector: 'app-ndcg-by-type-comparison',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarChart, ChartFrame, ChartLegend, DataTable, EmptyChart],
  templateUrl: './ndcg-by-type-comparison.html',
})
export class NdcgByTypeComparison {
  readonly summaries = input.required<StrategySummary[]>();

  protected readonly scoreDomain: [number, number] = [0, 1];
  protected readonly scoreTicks = [0, 0.25, 0.5, 0.75, 1];
  protected readonly comparisonMargin = { top: 18, right: 8, bottom: 4, left: 0 };

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

  protected readonly data = computed<BarDatum[]>(() => {
    const summaries = this.summaries();
    const types = new Set<string>();
    for (const s of summaries) for (const t of s.byQuestionType) types.add(t.questionType);

    return [...types].map((type) => {
      const row: BarDatum = { type: questionTypeLabel(type) };
      for (const s of summaries) {
        row[s.strategy] = s.byQuestionType.find((t) => t.questionType === type)?.ndcg ?? 0;
      }
      return row;
    });
  });

  protected readonly minWidth = computed(() => Math.max(480, this.data().length * 120));

  protected readonly tableColumns = computed(() => [
    'Question type',
    ...this.summaries().map((s) => STRATEGY_SHORT[s.strategy]),
  ]);

  protected readonly tableRows = computed(() =>
    this.data().map((r) => [
      String(r['type']),
      ...this.summaries().map((s) => fmtScore(Number(r[s.strategy]))),
    ]),
  );

  protected readonly tickFormat = (v: number) => String(v);
  protected readonly tooltipFormat = (v: number) => fmtScore(v);
  protected readonly labelFormat = (v: number) => (v >= 0.005 ? v.toFixed(2) : '');
}
