import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { DatasetInfo, EvaluationItem, MetaResponse } from '../../api/types';
import type { DatasetMode } from '../../store/experiment.store';
import { questionTypeLabel } from '../../lib/format';
import { OptionCard } from './option-card';
import { StepSection } from './step-section';

const SAMPLE_DATASET = `[
  {
    "question": "Who founded Assurio and in what year?",
    "reference_answer": "Avery Lancaster founded Assurio in 2015.",
    "keywords": ["Avery Lancaster", "2015"],
    "category": "direct_fact"
  }
]`;

/**
 * Evaluation dataset source.
 *
 * The demo corpus and the demo question set are a fixed pairing. The 150 shipped
 * questions carry reference answers taken from the Assurio documents, so they
 * measure nothing against anything else — and swapping different questions onto
 * the demo corpus throws away the only hand-written ground truth the app has.
 * Choosing the demo corpus therefore decides this step: the other three sources
 * are locked out, and the lock is repeated on the server.
 */
@Component({
  selector: 'app-dataset-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StepSection, OptionCard],
  templateUrl: './dataset-picker.html',
})
export class DatasetPicker {
  readonly meta = input.required<MetaResponse>();
  readonly mode = input.required<DatasetMode>();
  readonly dataset = input.required<DatasetInfo | null>();
  readonly items = input.required<EvaluationItem[]>();
  readonly questionCount = input.required<number>();
  /** True when step 2 is on the demo corpus, which locks this step. */
  readonly defaultKbSelected = input.required<boolean>();
  readonly knowledgeBaseReady = input.required<boolean>();
  readonly busy = input.required<boolean>();
  readonly error = input.required<string | null>();

  readonly modeChange = output<DatasetMode>();
  readonly questionCountChange = output<number>();
  readonly useDefault = output<void>();
  readonly upload = output<File>();
  readonly paste = output<string>();
  readonly generate = output<void>();

  protected readonly pasted = signal('');
  protected readonly showItems = signal(false);
  protected readonly samplePlaceholder = SAMPLE_DATASET;
  protected readonly questionTypeLabel = questionTypeLabel;

  protected readonly limits = computed(() => this.meta().limits);
  protected readonly defaultQa = computed(() => this.meta().defaultDataset);
  protected readonly generateQuota = computed(() =>
    this.meta().quotas.find((q) => q.action === 'generate'),
  );

  // With the demo corpus chosen there is exactly one valid question source, so
  // the other three are shown locked rather than hidden — a visitor can still
  // see what the app supports for their own documents.
  protected readonly lockedToDefault = computed(
    () => this.defaultKbSelected() && !!this.defaultQa(),
  );

  protected readonly hint = computed(() =>
    this.lockedToDefault()
      ? 'Fixed by your knowledge base choice — the demo corpus ships with its own ground-truth questions.'
      : 'Each item needs a question, a reference answer and the keywords a correct answer must contain.',
  );

  protected readonly statusLabel = computed(() => {
    const dataset = this.dataset();
    if (!dataset) return null;
    return `${dataset.questionCount} question${dataset.questionCount === 1 ? '' : 's'} ready`;
  });

  /** The demo set caps the slider at whatever the shipped set actually holds. */
  protected readonly defaultCountMax = computed(() =>
    Math.min(this.limits().maxQuestions, this.defaultQa()?.questionCount ?? 0),
  );

  protected readonly generateCount = computed(() =>
    Math.min(this.questionCount(), this.limits().maxGeneratedQuestions),
  );

  protected readonly lockReason = computed(() =>
    this.lockedToDefault() ? 'Locked by the demo knowledge base' : null,
  );

  protected onSelectDefault(): void {
    this.modeChange.emit('default');
    this.useDefault.emit();
  }

  protected onDefaultCountInput(event: Event): void {
    this.questionCountChange.emit(Number((event.target as HTMLInputElement).value));
    this.useDefault.emit();
  }

  protected onGenerateCountInput(event: Event): void {
    this.questionCountChange.emit(Number((event.target as HTMLInputElement).value));
  }

  protected onFileChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.modeChange.emit('upload');
      this.upload.emit(file);
    }
    input.value = '';
  }
}
