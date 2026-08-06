import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import { fmtTokens, questionTypeLabel } from '../../lib/format';
import { BarChart, type BarDatum, type BarSeries } from '../ui/bar-chart';
import { ChartLegend, EmptyChart } from '../ui/chart-bits';
import { ChartFrame, DataTable } from '../ui/chart-frame';

const SERIES: BarSeries[] = [
  { key: 'input', label: 'Input tokens', color: 'var(--series-1)' },
  { key: 'output', label: 'Output tokens', color: 'var(--series-2)' },
];

/** Average input vs output tokens per question, by question type. */
@Component({
  selector: 'app-token-usage-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarChart, ChartFrame, ChartLegend, DataTable, EmptyChart],
  templateUrl: './token-usage-chart.html',
})
export class TokenUsageChart {
  readonly summary = input.required<StrategySummary>();

  protected readonly series = SERIES;
  protected readonly legend = SERIES.map((s) => ({ label: s.label, color: s.color }));

  protected readonly data = computed<BarDatum[]>(() =>
    this.summary().byQuestionType.map((row) => ({
      type: questionTypeLabel(row.questionType),
      count: row.count,
      input: Math.round(row.avgInputTokens),
      output: Math.round(row.avgOutputTokens),
    })),
  );

  protected readonly minWidth = computed(() => Math.max(420, this.data().length * 120));

  protected readonly aside = computed(() => this.summary().label);

  protected readonly tableRows = computed(() =>
    this.data().map((r) => [
      String(r['type']),
      Number(r['count']),
      fmtTokens(Number(r['input'])),
      fmtTokens(Number(r['output'])),
    ]),
  );

  protected readonly tickFormat = (v: number) => fmtTokens(v);
  protected readonly tooltipFormat = (v: number) => `${Math.round(v).toLocaleString()} tok`;
  protected readonly labelFormat = (v: number) => fmtTokens(v);
}
