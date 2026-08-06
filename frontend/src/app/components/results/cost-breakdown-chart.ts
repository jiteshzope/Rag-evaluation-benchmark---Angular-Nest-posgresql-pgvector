import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary, UsageStage } from '../../api/types';
import { USAGE_STAGE_LABEL, fmtCost, fmtTokens } from '../../lib/format';
import { BarChart, type BarDatum, type BarSeries } from '../ui/bar-chart';
import { EmptyChart } from '../ui/chart-bits';
import { ChartFrame, DataTable } from '../ui/chart-frame';

const STAGE_ORDER: UsageStage[] = [
  'embedding',
  'query-transform',
  'rerank',
  'graph',
  'answer',
  'judge',
];

const SERIES: BarSeries[] = [{ key: 'cost', label: 'Cost / question', color: 'var(--series-1)' }];

/** Sequential blue ramp, darkest for the largest contributor. */
const RAMP = ['#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#86b6ef'];

/**
 * Where the money goes, per question, by pipeline stage.
 *
 * A single sequential hue: this is one measure (cost) split by category, and the
 * bars are sorted, so magnitude — not identity — is what the reader is reading.
 */
@Component({
  selector: 'app-cost-breakdown-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarChart, ChartFrame, DataTable, EmptyChart],
  templateUrl: './cost-breakdown-chart.html',
})
export class CostBreakdownChart {
  readonly summary = input.required<StrategySummary>();

  protected readonly series = SERIES;
  protected readonly ramp = RAMP;
  protected readonly rowsMargin = { top: 4, right: 64, bottom: 4, left: 4 };

  protected readonly data = computed<BarDatum[]>(() => {
    const per = this.summary().usagePerQuestion;
    return STAGE_ORDER.map((stage) => ({
      stage: USAGE_STAGE_LABEL[stage] ?? stage,
      cost: per.costByStage[stage] ?? 0,
      tokens: per.tokensByStage[stage] ?? 0,
    }))
      .filter((row) => row.cost > 0 || row.tokens > 0)
      .sort((a, b) => b.cost - a.cost);
  });

  protected readonly chartHeight = computed(() => Math.max(160, this.data().length * 34 + 30));

  protected readonly aside = computed(
    () => `${this.summary().label} · ${fmtCost(this.summary().usagePerQuestion.costUsd)}/question`,
  );

  protected readonly tableRows = computed(() =>
    this.data().map((r) => [
      String(r['stage']),
      fmtCost(Number(r['cost'])),
      fmtTokens(Number(r['tokens'])),
    ]),
  );

  protected readonly totalCost = computed(() => fmtCost(this.summary().usage.costUsd));

  protected readonly tickFormat = (v: number) => fmtCost(v);
  protected readonly tooltipFormat = (v: number) => fmtCost(v);
  protected readonly labelFormat = (v: number) => fmtCost(v);
}
