import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { KnowledgeBaseInfo, MetaResponse } from '../../api/types';
import type { KbMode } from '../../store/experiment.store';
import { fmtNumber } from '../../lib/format';
import { StepSection } from './step-section';

/**
 * Knowledge base source.
 *
 * The demo corpus is presented first and pre-selected on purpose: it is
 * pre-embedded in pgvector, so choosing it means a run makes zero ingestion API
 * calls, starts instantly, and comes with a matching 150-question ground-truth
 * set. That is the path a recruiter should land on.
 *
 * This choice also decides step 3 — see DatasetPicker for why the pairing is
 * fixed in both directions.
 */
@Component({
  selector: 'app-knowledge-base-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StepSection],
  templateUrl: './knowledge-base-picker.html',
})
export class KnowledgeBasePicker {
  readonly meta = input.required<MetaResponse>();
  readonly mode = input.required<KbMode>();
  readonly knowledgeBase = input.required<KnowledgeBaseInfo | null>();
  readonly busy = input.required<boolean>();
  readonly error = input.required<string | null>();

  readonly modeChange = output<KbMode>();
  readonly upload = output<File>();
  readonly pasteText = output<string>();

  protected readonly dragging = signal(false);
  protected readonly pasted = signal('');

  protected readonly limits = computed(() => this.meta().limits);
  protected readonly defaultKb = computed(() => this.meta().defaultKnowledgeBase);
  protected readonly maxMb = computed(() =>
    (this.limits().maxFileSizeBytes / 1024 / 1024).toFixed(0),
  );

  protected readonly statusLabel = computed(() => {
    const kb = this.knowledgeBase();
    if (!kb) return null;
    const plural = kb.documentCount === 1 ? '' : 's';
    return `${kb.documentCount} doc${plural} · ${fmtNumber(kb.totalChars)} chars`;
  });

  protected readonly fmtNumber = fmtNumber;

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      this.modeChange.emit('upload');
      this.upload.emit(file);
    }
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
