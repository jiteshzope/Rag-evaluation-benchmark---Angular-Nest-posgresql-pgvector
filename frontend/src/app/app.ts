import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { ApiService } from './api/api.service';
import { connectEvaluationStream } from './api/evaluation-stream';
import { EvaluationProgress } from './components/progress/evaluation-progress';
import { ResultsPage } from './components/results/results-page';
import { SetupPage } from './components/setup/setup-page';
import { ExperimentStore, type Screen } from './store/experiment.store';
import { MetaStore } from './store/meta.store';

type Theme = 'light' | 'dark' | 'system';

const PHASE_ORDER: Screen[] = ['setup', 'progress', 'results'];

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };

interface PhaseChip {
  label: string;
  n: number;
  phase: Screen;
  active: boolean;
  done: boolean;
  color: string;
  pulse: boolean;
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SetupPage, EvaluationProgress, ResultsPage],
  templateUrl: './app.html',
})
export class App {
  protected readonly store = inject(ExperimentStore);
  protected readonly meta = inject(MetaStore);
  private readonly api = inject(ApiService);

  protected readonly theme = signal<Theme>(readStoredTheme());
  protected readonly resetting = signal(false);

  constructor() {
    effect(() => {
      const theme = this.theme();
      const root = document.documentElement;
      if (theme === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', theme);
      try {
        localStorage.setItem('ragbench-theme', theme);
      } catch {
        // Private windows can refuse storage; the theme still applies for this session.
      }
    });

    void this.meta.load();

    // Subscribe while a run is in flight. The backend replays its buffered events
    // to every subscriber, so connecting a moment late loses nothing.
    connectEvaluationStream(
      this.store.experimentId,
      this.store.streamEnabled,
      this.store.applyEvent,
    );
  }

  protected readonly themeIcon = computed(() => THEME_ICON[this.theme()]);
  protected readonly nextTheme = computed(() => NEXT_THEME[this.theme()]);

  protected readonly pgvectorReady = computed(() => this.meta.data()?.pgvector.available ?? false);

  protected readonly metaErrorMessage = computed(() => this.meta.error()?.message ?? '');

  /**
   * The header stepper.
   *
   * Numbered and colour-coded so the current phase is obvious at a glance;
   * completed phases keep a tick rather than going grey, which reads as progress
   * rather than as something switched off.
   */
  protected readonly phases = computed<PhaseChip[]>(() => {
    const current = this.store.screen();
    const running = this.store.running();
    const currentIndex = PHASE_ORDER.indexOf(current);

    return (
      [
        { label: 'Setup', n: 1, phase: 'setup' as Screen, pulse: false },
        { label: 'Run', n: 2, phase: 'progress' as Screen, pulse: running },
        { label: 'Results', n: 3, phase: 'results' as Screen, pulse: false },
      ] satisfies Array<{ label: string; n: number; phase: Screen; pulse: boolean }>
    ).map((entry) => ({
      ...entry,
      active: entry.phase === current,
      done: PHASE_ORDER.indexOf(entry.phase) < currentIndex,
      color: `var(--step-${entry.n})`,
    }));
  });

  protected phaseBackground(color: string): string {
    return `color-mix(in srgb, ${color} var(--tint-wash), var(--surface-1))`;
  }

  protected phaseRing(color: string): string {
    return `inset 0 0 0 1px color-mix(in srgb, ${color} var(--tint-edge), transparent)`;
  }

  protected phaseClass(chip: PhaseChip): string {
    return chip.active
      ? 'font-semibold text-ink-primary'
      : chip.done
        ? 'text-ink-secondary'
        : 'text-ink-muted';
  }

  protected railDone(index: number): boolean {
    const current = this.store.screen();
    return index === 0 ? current !== 'setup' : current === 'results';
  }

  protected cycleTheme(): void {
    this.theme.set(NEXT_THEME[this.theme()]);
  }

  protected cancelRun(): void {
    const id = this.store.experimentId();
    if (id) void this.api.cancel(id);
  }

  /**
   * Start over, stopping anything in flight first.
   *
   * The cancel has to land *before* the reset releases the experiment: the reset
   * deletes it server-side, and a cancel that arrives afterwards finds nothing
   * to stop, leaving the run to finish in the background on real credit.
   */
  protected async startOver(): Promise<void> {
    const id = this.store.experimentId();

    if (this.store.running() && id) {
      // A run in flight has already been paid for out of the daily quota, so
      // make throwing it away deliberate.
      const proceed = window.confirm(
        'This evaluation is still running. Cancel it and start over? The run it used is not refunded.',
      );
      if (!proceed) return;

      this.resetting.set(true);
      try {
        await this.api.cancel(id);
      } catch {
        // Already finished or evicted — nothing left to cancel.
      } finally {
        this.resetting.set(false);
      }
    }

    this.store.resetWorkflow();
  }
}

function readStoredTheme(): Theme {
  try {
    return (localStorage.getItem('ragbench-theme') as Theme | null) ?? 'system';
  } catch {
    return 'system';
  }
}
