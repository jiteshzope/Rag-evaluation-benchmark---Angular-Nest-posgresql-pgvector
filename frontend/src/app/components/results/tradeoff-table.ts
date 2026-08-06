import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import { STRATEGY_COLOR, fmtCost, fmtDuration, fmtScore } from '../../lib/format';

interface TradeoffRow {
  strategy: string;
  label: string;
  color: string;
  bestQuality: boolean;
  cheapest: boolean;
  composite: string;
  ndcg: string;
  faithfulness: string;
  cost: string;
  latency: string;
  chunks: string;
  entities: number | null;
}

/**
 * The trade-off table: quality against cost and latency.
 *
 * Deliberately a table, not a scatter plot. With three or four strategies a
 * scatter would show a handful of dots and force the reader to hunt for labels;
 * the numbers themselves are what the comparison is about.
 */
@Component({
  selector: 'app-tradeoff-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tradeoff-table.html',
})
export class TradeoffTable {
  readonly summaries = input.required<StrategySummary[]>();

  protected readonly rows = computed<TradeoffRow[]>(() => {
    const summaries = this.summaries();
    const bestQuality = [...summaries].sort((a, b) => b.compositeScore - a.compositeScore)[0]
      ?.strategy;
    const cheapest = [...summaries].sort(
      (a, b) => a.usagePerQuestion.costUsd - b.usagePerQuestion.costUsd,
    )[0]?.strategy;

    return summaries.map((s) => ({
      strategy: s.strategy,
      label: s.label,
      color: STRATEGY_COLOR[s.strategy],
      bestQuality: s.strategy === bestQuality,
      cheapest: s.strategy === cheapest && s.strategy !== bestQuality,
      composite: fmtScore(s.compositeScore),
      ndcg: fmtScore(s.retrieval['ndcg']),
      faithfulness: fmtScore(s.answer['faithfulness']),
      cost: fmtCost(s.usagePerQuestion.costUsd),
      latency: fmtDuration(s.latency.total.p95),
      chunks: s.indexing.chunkCount.toLocaleString(),
      entities: s.indexing.graph?.entities ?? null,
    }));
  });
}
