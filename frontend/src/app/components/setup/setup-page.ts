import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { ApiError, ApiService } from '../../api/api.service';
import type { MetaResponse } from '../../api/types';
import { fmtNumber } from '../../lib/format';
import { ExperimentStore } from '../../store/experiment.store';
import { MetaStore } from '../../store/meta.store';
import { DatasetPicker } from './dataset-picker';
import { KnowledgeBasePicker } from './knowledge-base-picker';
import { StepSection } from './step-section';
import { StrategySelector } from './strategy-selector';

/**
 * Experiment setup: strategy, knowledge base, dataset, run.
 *
 * The experiment is created lazily on the first action that needs a server-side
 * id, so simply browsing the page costs nothing.
 */
@Component({
  selector: 'app-setup-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StrategySelector, KnowledgeBasePicker, DatasetPicker, StepSection],
  templateUrl: './setup-page.html',
})
export class SetupPage {
  readonly meta = input.required<MetaResponse>();

  protected readonly store = inject(ExperimentStore);
  private readonly api = inject(ApiService);
  private readonly metaStore = inject(MetaStore);

  protected readonly kbError = signal<string | null>(null);
  protected readonly datasetError = signal<string | null>(null);
  protected readonly runError = signal<string | null>(null);

  private readonly kbDefaultPending = signal(false);
  private readonly kbUploadPending = signal(false);
  private readonly kbTextPending = signal(false);

  private readonly datasetDefaultPending = signal(false);
  private readonly datasetUploadPending = signal(false);
  private readonly datasetPastePending = signal(false);
  private readonly datasetGeneratePending = signal(false);

  protected readonly runPending = signal(false);

  protected readonly fmtNumber = fmtNumber;

  protected readonly kbBusy = computed(
    () => this.kbUploadPending() || this.kbTextPending() || this.kbDefaultPending(),
  );

  protected readonly datasetBusy = computed(
    () =>
      this.datasetGeneratePending() ||
      this.datasetUploadPending() ||
      this.datasetPastePending() ||
      this.datasetDefaultPending(),
  );

  protected readonly runQuota = computed(() => this.meta().quotas.find((q) => q.action === 'run'));

  protected readonly canRun = computed(
    () =>
      !!this.store.knowledgeBase() &&
      !!this.store.dataset() &&
      this.store.selectedStrategies().length > 0,
  );

  protected readonly estimatedCalls = computed(
    () => (this.store.dataset()?.questionCount ?? 0) * this.store.selectedStrategies().length,
  );

  protected readonly runQuotaLabel = computed(() => {
    const quota = this.runQuota();
    return quota ? `${quota.remaining} of ${quota.limit} runs left today` : null;
  });

  protected readonly runQuotaColor = computed(() =>
    this.runQuota()?.remaining === 0 ? 'var(--status-critical)' : 'var(--step-4)',
  );

  constructor() {
    /**
     * The demo corpus and question set are pre-selected, so apply them once on
     * mount. Without this the UI shows both as chosen while the server holds
     * neither, and Run stays disabled with no obvious way to enable it.
     *
     * This also re-arms after a reset, which clears the experiment id.
     */
    effect(() => {
      const kbMode = this.store.kbMode();
      const knowledgeBase = this.store.knowledgeBase();
      this.store.experimentId();

      if (kbMode === 'default' && !knowledgeBase && !untracked(this.kbDefaultPending)) {
        void this.applyDefaultKnowledgeBase();
      }
    });

    effect(() => {
      // The default question set needs the default corpus applied first, so this
      // waits on knowledgeBase rather than firing alongside it.
      const datasetMode = this.store.datasetMode();
      const kbMode = this.store.kbMode();
      const knowledgeBase = this.store.knowledgeBase();
      const dataset = this.store.dataset();

      if (
        datasetMode === 'default' &&
        kbMode === 'default' &&
        knowledgeBase &&
        !dataset &&
        !untracked(this.datasetDefaultPending)
      ) {
        void this.applyDefaultDataset();
      }
    });
  }

  /** Creates the experiment if needed and returns its id. */
  private async ensureExperiment(): Promise<string> {
    const existing = this.store.experimentId();
    if (existing) return existing;

    const created = await this.api.createExperiment({
      strategies: this.store.selectedStrategies(),
    });
    this.store.setExperimentId(created.id);
    return created.id;
  }

  /**
   * Turns any error into the message the user should actually read.
   *
   * A 404 means the in-memory session expired or the server restarted — nothing
   * the user did, and nothing they can fix by repeating the same action. So the
   * dead session is discarded here, which lets the effects above re-apply the
   * demo corpus and questions on their own, and the message says whether that
   * leaves anything for the user to redo. An uploaded document cannot come back:
   * it only ever lived in the session that just died.
   */
  private explain(err: Error): string {
    if (!(err instanceof ApiError) || err.status !== 404) return err.message;

    const kbMode = this.store.kbMode();
    this.store.setExperimentId(null);
    this.store.setKnowledgeBase(null);
    this.store.setDataset(null);

    return kbMode === 'default'
      ? 'That evaluation session expired — sessions are held in memory and are dropped after a ' +
          'period of inactivity or when the server restarts. The demo corpus and questions have ' +
          'been reloaded, so you can go straight ahead.'
      : 'That evaluation session expired — sessions are held in memory and are dropped after a ' +
          'period of inactivity or when the server restarts. Your document was only ever held ' +
          'for that session, so please add your knowledge base and questions again.';
  }

  // ── Knowledge base ────────────────────────────────────────────────────────

  protected async applyDefaultKnowledgeBase(): Promise<void> {
    this.kbDefaultPending.set(true);
    try {
      const id = await this.ensureExperiment();
      const data = await this.api.useDefaultKnowledgeBase(id);
      this.store.setKnowledgeBase(data.knowledgeBase);
      this.kbError.set(null);
    } catch (err) {
      this.kbError.set(this.explain(err as Error));
    } finally {
      this.kbDefaultPending.set(false);
    }
  }

  protected async uploadKnowledgeBase(file: File): Promise<void> {
    this.kbUploadPending.set(true);
    try {
      const id = await this.ensureExperiment();
      const data = await this.api.uploadKnowledgeBase(id, file);
      this.store.setKnowledgeBase(data.knowledgeBase);
      this.kbError.set(null);
      this.metaStore.refresh();
    } catch (err) {
      this.kbError.set(this.explain(err as Error));
    } finally {
      this.kbUploadPending.set(false);
    }
  }

  protected async setKnowledgeBaseText(text: string): Promise<void> {
    this.kbTextPending.set(true);
    try {
      const id = await this.ensureExperiment();
      const data = await this.api.setKnowledgeBaseText(id, text);
      this.store.setKnowledgeBase(data.knowledgeBase);
      this.kbError.set(null);
      this.metaStore.refresh();
    } catch (err) {
      this.kbError.set(this.explain(err as Error));
    } finally {
      this.kbTextPending.set(false);
    }
  }

  protected onKbModeChange(mode: 'default' | 'upload' | 'paste'): void {
    this.store.setKbMode(mode);
    this.kbError.set(null);
    if (mode === 'default') void this.applyDefaultKnowledgeBase();
  }

  // ── Dataset ───────────────────────────────────────────────────────────────

  protected async applyDefaultDataset(): Promise<void> {
    this.datasetDefaultPending.set(true);
    try {
      const id = await this.ensureExperiment();
      const data = await this.api.useDefaultDataset(id, this.store.questionCount());
      this.store.setDataset(data.dataset);
      this.datasetError.set(null);
    } catch (err) {
      this.datasetError.set(this.explain(err as Error));
    } finally {
      this.datasetDefaultPending.set(false);
    }
  }

  protected async uploadDataset(file: File): Promise<void> {
    this.datasetUploadPending.set(true);
    try {
      const id = await this.ensureExperiment();
      const data = await this.api.uploadDataset(id, file);
      this.store.setDataset(data.dataset);
      this.datasetError.set(null);
    } catch (err) {
      this.datasetError.set(this.explain(err as Error));
    } finally {
      this.datasetUploadPending.set(false);
    }
  }

  protected async pasteDataset(content: string): Promise<void> {
    this.datasetPastePending.set(true);
    try {
      const id = await this.ensureExperiment();
      const data = await this.api.setDataset(id, content);
      this.store.setDataset(data.dataset);
      this.datasetError.set(null);
    } catch (err) {
      this.datasetError.set(this.explain(err as Error));
    } finally {
      this.datasetPastePending.set(false);
    }
  }

  protected async generateDataset(): Promise<void> {
    this.datasetGeneratePending.set(true);
    try {
      const id = await this.ensureExperiment();
      const data = await this.api.generateDataset(id, this.store.questionCount());
      this.store.setDataset(data.dataset, data.items);
      this.datasetError.set(null);
      this.metaStore.refresh();
    } catch (err) {
      this.datasetError.set(this.explain(err as Error));
    } finally {
      this.datasetGeneratePending.set(false);
    }
  }

  protected onDatasetModeChange(mode: 'default' | 'upload' | 'paste' | 'generate'): void {
    this.store.setDatasetMode(mode);
    this.datasetError.set(null);
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  protected async run(): Promise<void> {
    this.runPending.set(true);
    try {
      const id = await this.ensureExperiment();

      // The experiment was created on the first setup action, with whatever was
      // selected then. Anything ticked since lives only in the browser, so push
      // the current selection before running rather than refusing to run.
      await this.api.setStrategies(id, this.store.selectedStrategies());
      await this.api.run(id);

      this.runError.set(null);
      this.store.beginRun();
    } catch (err) {
      this.runError.set(this.explain(err as Error));
    } finally {
      this.runPending.set(false);
    }
  }
}
