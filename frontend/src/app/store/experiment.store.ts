import { computed, inject, Injectable, signal } from '@angular/core';

import { ApiService } from '../api/api.service';
import type {
  DatasetInfo,
  EvaluationEvent,
  EvaluationItem,
  ExperimentStatus,
  KnowledgeBaseInfo,
  QuestionResult,
  StrategyId,
  StrategySummary,
} from '../api/types';

export type Screen = 'setup' | 'progress' | 'results';

/** Which source the user chose for each half of the experiment. */
export type KbMode = 'default' | 'upload' | 'paste';
export type DatasetMode = 'default' | 'upload' | 'paste' | 'generate';

export interface IndexingState {
  strategy: StrategyId;
  message: string;
  chunkCount?: number;
  indexingMs?: number;
  fromCache?: boolean;
  graph?: { entities: number; relationships: number; communities: number; levels: number };
  done: boolean;
}

export interface ProgressState {
  overallCompleted: number;
  overallTotal: number;
  perStrategy: Record<string, { completed: number; total: number }>;
  currentQuestion: string;
  currentStrategy: StrategyId | null;
}

export interface QuestionSelection {
  itemId: string;
  strategy: StrategyId;
}

/** Selections the app opens with, and the ones "Start over" returns to. */
const INITIAL_SELECTIONS = {
  selectedStrategies: ['baseline', 'advanced'] as StrategyId[],
  kbMode: 'default' as KbMode,
  datasetMode: 'default' as DatasetMode,
  questionCount: 20,
};

const EMPTY_PROGRESS: ProgressState = {
  overallCompleted: 0,
  overallTotal: 0,
  perStrategy: {},
  currentQuestion: '',
  currentStrategy: null,
};

/**
 * The whole client-side model of an experiment: what the user picked, what the
 * run is doing, and what came back.
 *
 * Signals throughout, so the app runs zoneless — nothing here needs to know that
 * a view exists, and every write schedules exactly the change detection it
 * caused.
 */
@Injectable({ providedIn: 'root' })
export class ExperimentStore {
  private readonly api = inject(ApiService);

  // ── Setup selections ──────────────────────────────────────────────────────
  readonly screen = signal<Screen>('setup');
  readonly experimentId = signal<string | null>(null);
  readonly selectedStrategies = signal<StrategyId[]>(INITIAL_SELECTIONS.selectedStrategies);
  readonly kbMode = signal<KbMode>(INITIAL_SELECTIONS.kbMode);
  readonly datasetMode = signal<DatasetMode>(INITIAL_SELECTIONS.datasetMode);
  readonly questionCount = signal<number>(INITIAL_SELECTIONS.questionCount);

  readonly knowledgeBase = signal<KnowledgeBaseInfo | null>(null);
  readonly dataset = signal<DatasetInfo | null>(null);
  readonly datasetItems = signal<EvaluationItem[]>([]);

  // ── Run state ─────────────────────────────────────────────────────────────
  readonly status = signal<ExperimentStatus>('created');
  readonly indexing = signal<Record<string, IndexingState>>({});
  readonly progress = signal<ProgressState>(EMPTY_PROGRESS);
  readonly liveResults = signal<QuestionResult[]>([]);
  readonly summaries = signal<StrategySummary[]>([]);
  readonly totalCostUsd = signal(0);
  readonly durationMs = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly startedAt = signal<number | null>(null);

  // ── Results UI ────────────────────────────────────────────────────────────
  readonly focusedStrategy = signal<StrategyId | null>(null);
  readonly selectedQuestion = signal<QuestionSelection | null>(null);

  /**
   * Bumped by resetWorkflow. Used to key the setup screen's block in the
   * template so a reset also destroys state the components own rather than the
   * store — pasted textareas, open disclosures and error banners.
   */
  readonly resetNonce = signal(0);

  /** True while the backend is either indexing or evaluating. */
  readonly running = computed(() => this.status() === 'evaluating' || this.status() === 'indexing');

  /** Whether the SSE stream should be connected. */
  readonly streamEnabled = computed(
    () => this.screen() === 'progress' || this.status() === 'evaluating',
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  setScreen(screen: Screen): void {
    this.screen.set(screen);
  }

  toggleStrategy(id: StrategyId, max: number): void {
    const current = this.selectedStrategies();
    if (current.includes(id)) {
      // Never allow an empty selection — a run needs at least one strategy.
      if (current.length === 1) return;
      this.selectedStrategies.set(current.filter((s) => s !== id));
      return;
    }
    if (current.length >= max) return;
    this.selectedStrategies.set([...current, id]);
  }

  setKbMode(kbMode: KbMode): void {
    const previousDatasetMode = this.datasetMode();
    this.kbMode.set(kbMode);
    this.knowledgeBase.set(null);
    // The demo corpus and its question set are one pairing, so switching the
    // corpus decides the dataset too: the demo corpus always runs the demo
    // questions, and any other corpus can never use them.
    this.datasetMode.set(
      kbMode === 'default'
        ? 'default'
        : previousDatasetMode === 'default'
          ? 'generate'
          : previousDatasetMode,
    );
    this.dataset.set(null);
    this.datasetItems.set([]);
  }

  setDatasetMode(datasetMode: DatasetMode): void {
    // The demo corpus admits no other question source; the picker disables
    // those options, and this keeps the rule true however state is reached.
    if (this.kbMode() === 'default' && datasetMode !== 'default') return;
    this.datasetMode.set(datasetMode);
    this.dataset.set(null);
    this.datasetItems.set([]);
  }

  setQuestionCount(questionCount: number): void {
    this.questionCount.set(questionCount);
  }

  setExperimentId(id: string | null): void {
    this.experimentId.set(id);
  }

  setKnowledgeBase(kb: KnowledgeBaseInfo | null): void {
    this.knowledgeBase.set(kb);
  }

  setDataset(dataset: DatasetInfo | null, items?: EvaluationItem[]): void {
    this.dataset.set(dataset);
    this.datasetItems.set(items ?? []);
  }

  beginRun(): void {
    this.clearRunState();
    this.status.set('evaluating');
    this.startedAt.set(Date.now());
    this.screen.set('progress');
    this.selectedQuestion.set(null);
    this.focusedStrategy.set(null);
  }

  setError(message: string | null): void {
    this.error.set(message);
  }

  focusStrategy(id: StrategyId | null): void {
    this.focusedStrategy.set(id);
  }

  selectQuestion(selection: QuestionSelection | null): void {
    this.selectedQuestion.set(selection);
  }

  applyEvent = (event: EvaluationEvent): void => {
    switch (event.type) {
      case 'status':
        this.status.set(event.status);
        return;

      case 'indexing':
        this.indexing.update((state) => ({
          ...state,
          [event.strategy]: {
            ...(state[event.strategy] ?? { strategy: event.strategy, done: false }),
            strategy: event.strategy,
            message: event.message,
            done: false,
          },
        }));
        return;

      case 'indexed':
        this.indexing.update((state) => ({
          ...state,
          [event.strategy]: {
            strategy: event.strategy,
            message: `${event.chunkCount} chunks indexed`,
            chunkCount: event.chunkCount,
            indexingMs: event.indexingMs,
            fromCache: event.fromCache,
            graph: event.graph,
            done: true,
          },
        }));
        return;

      case 'progress':
        this.progress.update((state) => ({
          overallCompleted: event.overallCompleted,
          overallTotal: event.overallTotal,
          perStrategy: {
            ...state.perStrategy,
            [event.strategy]: { completed: event.completed, total: event.total },
          },
          currentQuestion: event.currentQuestion,
          currentStrategy: event.strategy,
        }));
        return;

      case 'question':
        this.liveResults.update((results) => [...results, event.result]);
        return;

      case 'strategy-complete':
        // Replace on re-delivery so a replayed event never duplicates a row.
        this.summaries.update((summaries) => [
          ...summaries.filter((s) => s.strategy !== event.strategy),
          event.summary,
        ]);
        return;

      case 'complete':
        this.status.set('complete');
        this.summaries.set(event.summaries);
        this.totalCostUsd.set(event.totalCostUsd);
        this.durationMs.set(event.durationMs);
        this.screen.set('results');
        this.focusedStrategy.update((focused) => focused ?? event.summaries[0]?.strategy ?? null);
        return;

      case 'error':
        this.status.set('failed');
        this.error.set(event.message);
        return;
    }
  };

  /** Clears results and the server experiment, keeping the current selections. */
  reset(): void {
    this.releaseExperiment(this.experimentId());
    this.clearExperiment();
  }

  /** Full restart: selections back to defaults and the server experiment released. */
  resetWorkflow(): void {
    this.releaseExperiment(this.experimentId());
    this.clearExperiment();
    this.selectedStrategies.set(INITIAL_SELECTIONS.selectedStrategies);
    this.kbMode.set(INITIAL_SELECTIONS.kbMode);
    this.datasetMode.set(INITIAL_SELECTIONS.datasetMode);
    this.questionCount.set(INITIAL_SELECTIONS.questionCount);
    this.resetNonce.update((n) => n + 1);
  }

  /** Everything a reset drops: the run, its results, and what it was run against. */
  private clearExperiment(): void {
    this.screen.set('setup');
    this.experimentId.set(null);
    this.knowledgeBase.set(null);
    this.dataset.set(null);
    this.datasetItems.set([]);
    this.focusedStrategy.set(null);
    this.selectedQuestion.set(null);
    this.clearRunState();
  }

  private clearRunState(): void {
    this.status.set('created');
    this.indexing.set({});
    this.progress.set(EMPTY_PROGRESS);
    this.liveResults.set([]);
    this.summaries.set([]);
    this.totalCostUsd.set(0);
    this.durationMs.set(null);
    this.error.set(null);
    this.startedAt.set(null);
  }

  /**
   * Drops the server-side experiment behind a reset.
   *
   * Uploaded documents live in the experiment's memory until it is evicted, so
   * telling the server we are done is what actually discards them — and it keeps
   * a browsing session from pinning slots in the store's capacity cap. Failure
   * is ignored on purpose: the local reset has already happened, and a stale
   * server experiment expires on its own TTL.
   */
  private releaseExperiment(id: string | null): void {
    if (!id) return;
    void this.api.deleteExperiment(id).catch(() => {
      // Already evicted, or the API is unreachable — nothing useful to do here.
    });
  }
}
