import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import { STRATEGY_COLOR, fmtCost, fmtDuration } from '../../lib/format';
import { ExperimentStore } from '../../store/experiment.store';
import { AnswerQualityChart } from './answer-quality-chart';
import { CostBreakdownChart } from './cost-breakdown-chart';
import { LatencyChart } from './latency-chart';
import { MetricsSummary } from './metrics-summary';
import { NdcgByTypeComparison } from './ndcg-by-type-comparison';
import { QuestionDetailDrawer } from './question-detail-drawer';
import { QuestionResultsTable } from './question-results-table';
import { RetrievalByTypeChart } from './retrieval-by-type-chart';
import { StrategyComparisonChart } from './strategy-comparison-chart';
import { TokenUsageChart } from './token-usage-chart';
import { TradeoffTable } from './tradeoff-table';

@Component({
  selector: 'app-results-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AnswerQualityChart,
    CostBreakdownChart,
    LatencyChart,
    MetricsSummary,
    NdcgByTypeComparison,
    QuestionDetailDrawer,
    QuestionResultsTable,
    RetrievalByTypeChart,
    StrategyComparisonChart,
    TokenUsageChart,
    TradeoffTable,
  ],
  templateUrl: './results-page.html',
})
export class ResultsPage {
  readonly reset = output<void>();

  protected readonly store = inject(ExperimentStore);

  protected readonly fmtCost = fmtCost;
  protected readonly fmtDuration = fmtDuration;

  /**
   * Keep the strategies in the order the user selected them, not completion
   * order — otherwise the tabs reshuffle between runs.
   */
  protected readonly ordered = computed<StrategySummary[]>(() => {
    const summaries = this.store.summaries();
    return this.store
      .selectedStrategies()
      .map((id) => summaries.find((s) => s.strategy === id))
      .filter((s): s is StrategySummary => !!s);
  });

  protected readonly focused = computed<StrategySummary | null>(() => {
    const ordered = this.ordered();
    const focusedStrategy = this.store.focusedStrategy();
    return ordered.find((s) => s.strategy === focusedStrategy) ?? ordered[0] ?? null;
  });

  /** Deltas are read against the first strategy of the run, never the best one. */
  protected readonly comparison = computed<StrategySummary | null>(() =>
    this.ordered().length > 1 ? (this.ordered()[0] ?? null) : null,
  );

  protected readonly drawerResult = computed(() => {
    const selection = this.store.selectedQuestion();
    if (!selection) return null;
    return (
      this.store
        .liveResults()
        .find((r) => r.itemId === selection.itemId && r.strategy === selection.strategy) ?? null
    );
  });

  protected readonly tabs = computed(() =>
    this.ordered().map((s) => ({
      strategy: s.strategy,
      label: s.label,
      color: STRATEGY_COLOR[s.strategy],
      active: s.strategy === this.focused()?.strategy,
    })),
  );

  protected tabBackground(color: string): string {
    return `color-mix(in srgb, ${color} var(--tint-wash), var(--surface-1))`;
  }

  protected tabRing(color: string): string {
    return `inset 0 0 0 1px color-mix(in srgb, ${color} var(--tint-edge), transparent)`;
  }
}
