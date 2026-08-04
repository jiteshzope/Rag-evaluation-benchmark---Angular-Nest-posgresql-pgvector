import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import type { QuestionResult, StrategyId } from '../../api/types';
import { STRATEGY_COLOR, STRATEGY_SHORT, fmtCost, fmtDuration, fmtScore } from '../../lib/format';
import { ExperimentStore } from '../../store/experiment.store';

interface StrategyCardModel {
  id: StrategyId;
  color: string;
  label: string;
  indexing: {
    message: string;
    chunkCount?: number;
    indexingMs?: number;
    fromCache?: boolean;
    graph?: { entities: number; relationships: number; communities: number; levels: number };
    done: boolean;
  } | null;
  progress: { completed: number; total: number } | null;
  progressPct: number;
  done: boolean;
  avgNdcg: number | null;
}

interface LatestRow {
  key: string;
  color: string;
  question: string;
  ndcg: string;
  verdict: string;
  verdictClass: string;
}

/**
 * Live run view.
 *
 * Results stream in per question, so this screen shows real numbers building up
 * rather than an opaque spinner — which also makes it obvious the evaluation is
 * genuinely executing rather than replaying a cached result.
 */
@Component({
  selector: 'app-evaluation-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './evaluation-progress.html',
})
export class EvaluationProgress {
  readonly cancel = output<void>();

  protected readonly store = inject(ExperimentStore);

  protected readonly fmtCost = fmtCost;
  protected readonly fmtScore = fmtScore;
  protected readonly fmtDuration = fmtDuration;
  protected readonly STRATEGY_SHORT = STRATEGY_SHORT;

  /**
   * Elapsed time ticks on its own clock. The React build re-rendered on every
   * streamed event and read Date.now() as it went; a signal driven by an
   * interval keeps that visible progress without depending on events arriving.
   */
  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected readonly pct = computed(() => {
    const progress = this.store.progress();
    return progress.overallTotal > 0 ? progress.overallCompleted / progress.overallTotal : 0;
  });

  protected readonly pctLabel = computed(() => (this.pct() * 100).toFixed(0));

  protected readonly barWidth = computed(() => Math.max(2, this.pct() * 100));

  protected readonly elapsed = computed(() => {
    const startedAt = this.store.startedAt();
    return startedAt ? this.now() - startedAt : 0;
  });

  protected readonly spentSoFar = computed(() =>
    this.store.liveResults().reduce((sum, r) => sum + r.usage.costUsd, 0),
  );

  protected readonly heading = computed(() => {
    const status = this.store.status();
    return status === 'evaluating'
      ? 'Running evaluation'
      : status === 'failed'
        ? 'Evaluation failed'
        : 'Preparing';
  });

  protected readonly currentStrategyLabel = computed(() => {
    const current = this.store.progress().currentStrategy;
    return current ? STRATEGY_SHORT[current] : '';
  });

  protected readonly cards = computed<StrategyCardModel[]>(() => {
    const indexing = this.store.indexing();
    const progress = this.store.progress().perStrategy;
    const summaries = this.store.summaries();
    const results = this.store.liveResults();

    return this.store.selectedStrategies().map((id) => {
      const forStrategy = results.filter((r) => r.strategy === id);
      const strategyProgress = progress[id] ?? null;

      return {
        id,
        color: STRATEGY_COLOR[id],
        label: STRATEGY_SHORT[id],
        indexing: indexing[id] ?? null,
        progress: strategyProgress,
        progressPct:
          strategyProgress && strategyProgress.total > 0
            ? Math.max(2, (strategyProgress.completed / strategyProgress.total) * 100)
            : 2,
        done: summaries.some((s) => s.strategy === id),
        avgNdcg: averageNdcg(forStrategy),
      };
    });
  });

  protected readonly latest = computed<LatestRow[]>(() =>
    [...this.store.liveResults()]
      .slice(-8)
      .reverse()
      .map((r) => ({
        key: `${r.strategy}:${r.itemId}`,
        color: STRATEGY_COLOR[r.strategy],
        question: r.question,
        ndcg: fmtScore(r.retrieval.ndcg),
        verdict: r.answer.verdict,
        verdictClass:
          r.answer.verdict === 'pass'
            ? 'text-status-good'
            : r.answer.verdict === 'partial'
              ? 'text-status-warning'
              : 'text-status-critical',
      })),
  );

  protected chunkCountLabel(count: number | undefined): string {
    return count?.toLocaleString() ?? '';
  }
}

function averageNdcg(results: QuestionResult[]): number | null {
  if (results.length === 0) return null;
  return results.reduce((sum, r) => sum + r.retrieval.ndcg, 0) / results.length;
}
