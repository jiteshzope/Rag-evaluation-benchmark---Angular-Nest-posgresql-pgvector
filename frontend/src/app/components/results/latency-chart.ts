import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import { fmtDuration } from '../../lib/format';
import { BarChart, type BarDatum, type BarSeries } from '../ui/bar-chart';
import { ChartLegend } from '../ui/chart-bits';
import { ChartFrame, DataTable } from '../ui/chart-frame';

const SERIES: BarSeries[] = [
  { key: 'mean', label: 'Mean', color: 'var(--series-1)' },
  { key: 'p95', label: 'p95', color: 'var(--series-2)' },
];

/** Latency split by pipeline phase, with p50/p95 for the total. */
@Component({
  selector: 'app-latency-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarChart, ChartFrame, ChartLegend, DataTable],
  templateUrl: './latency-chart.html',
})
export class LatencyChart {
  readonly summary = input.required<StrategySummary>();

  protected readonly series = SERIES;
  protected readonly legend = SERIES.map((s) => ({ label: s.label, color: s.color }));

  protected readonly data = computed<BarDatum[]>(() => {
    const latency = this.summary().latency;
    return [
      { phase: 'Retrieval', mean: latency.retrieval.mean, p95: latency.retrieval.p95 },
      { phase: 'Answer LLM', mean: latency.answer.mean, p95: latency.answer.p95 },
      { phase: 'Judge LLM', mean: latency.judge.mean, p95: latency.judge.p95 },
    ];
  });

  protected readonly aside = computed(() => {
    const total = this.summary().latency.total;
    return `total p50 ${fmtDuration(total.median)} · p95 ${fmtDuration(total.p95)}`;
  });

  protected readonly tableRows = computed(() => {
    const l = this.summary().latency;
    return [
      [
        'Retrieval',
        fmtDuration(l.retrieval.mean),
        fmtDuration(l.retrieval.median),
        fmtDuration(l.retrieval.p95),
        fmtDuration(l.retrieval.max),
      ],
      [
        'Answer LLM',
        fmtDuration(l.answer.mean),
        fmtDuration(l.answer.median),
        fmtDuration(l.answer.p95),
        fmtDuration(l.answer.max),
      ],
      [
        'Judge LLM',
        fmtDuration(l.judge.mean),
        fmtDuration(l.judge.median),
        fmtDuration(l.judge.p95),
        fmtDuration(l.judge.max),
      ],
      [
        'End to end',
        fmtDuration(l.total.mean),
        fmtDuration(l.total.median),
        fmtDuration(l.total.p95),
        fmtDuration(l.total.max),
      ],
    ];
  });

  protected readonly tickFormat = (v: number) => fmtDuration(v);
  protected readonly tooltipFormat = (v: number) => fmtDuration(v);
  protected readonly labelFormat = (v: number) => fmtDuration(v);
}
