import { ChangeDetectionStrategy, Component, input, TemplateRef } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

/**
 * One numbered step of the setup flow.
 *
 * Every step carries its own colour from the categorical ramp, applied through
 * a single `--step` custom property. The badge, the spine down the left edge,
 * the active tint and the selected-option rings inside all read that one value,
 * so a step is recognisable as a unit while you are scrolling past it.
 */
@Component({
  selector: 'app-step-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  template: `
    <section
      [attr.aria-labelledby]="headingId()"
      [style.--step]="color()"
      class="step-section card-pad animate-fade-in"
      [class.step-section-active]="active()"
    >
      <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden="true" class="step-badge" [class.step-badge-idle]="!active() && !done()">
          {{ done() ? '✓' : step() }}
        </span>

        <div class="min-w-0">
          <h2 [id]="headingId()" class="text-sm font-semibold text-ink-primary">{{ title() }}</h2>
          @if (hintTemplate()) {
            <p class="mt-0.5 text-xs leading-relaxed text-ink-secondary">
              <ng-container [ngTemplateOutlet]="hintTemplate()!" />
            </p>
          } @else if (hint()) {
            <p class="mt-0.5 text-xs leading-relaxed text-ink-secondary">{{ hint() }}</p>
          }
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-2">
          <ng-content select="[stepExtra]" />
          @if (statusLabel()) {
            <span class="chip-tinted" [style.--chip-color]="statusColor()">{{
              statusLabel()
            }}</span>
          }
        </div>
      </div>

      <ng-content />
    </section>
  `,
})
export class StepSection {
  readonly step = input.required<number>();
  readonly title = input.required<string>();
  /** Plain-text hint; use `hintTemplate` when the hint carries markup. */
  readonly hint = input<string | null>(null);
  readonly hintTemplate = input<TemplateRef<unknown> | null>(null);
  /** CSS colour for this step, usually `var(--step-N)`. */
  readonly color = input.required<string>();
  /** The step the user is working on now — gets the tint and the stronger spine. */
  readonly active = input(false);
  /** The step is satisfied; the badge becomes a tick. */
  readonly done = input(false);
  /** Short right-aligned summary, e.g. "20 questions ready". */
  readonly statusLabel = input<string | null>(null);
  /** Hue for the status pill; defaults to the step's own colour. */
  readonly statusColor = input('var(--step)');

  protected headingId(): string {
    return `step-${this.step()}-heading`;
  }
}
