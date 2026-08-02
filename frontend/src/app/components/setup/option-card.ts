import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * One selectable source in steps 2 and 3.
 *
 * `disabled` covers two different situations that must not look alike: an option
 * that is merely unavailable, and one the demo corpus has locked. Passing
 * `lockReason` is what turns the greyed card into an explained one.
 */
@Component({
  selector: 'app-option-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="option-card"
      [class.option-card-selected]="selected() && !disabled()"
      [class.option-card-locked]="disabled()"
    >
      <button
        type="button"
        (click)="select.emit()"
        [disabled]="disabled()"
        [attr.aria-pressed]="selected()"
        class="mb-2 flex items-center gap-2 text-left disabled:cursor-not-allowed"
      >
        <span aria-hidden="true" class="radio-dot" [class.radio-dot-on]="selected() && !disabled()">
          @if (selected() && !disabled()) {
            <span class="h-2 w-2 rounded-full" style="background: var(--step)"></span>
          }
        </span>
        <h3 class="text-sm font-semibold text-ink-primary">{{ title() }}</h3>
        <ng-content select="[optionBadge]" />
      </button>

      @if (lockReason()) {
        <p class="mb-2 text-2xs font-medium text-ink-muted">
          <span aria-hidden="true">🔒</span> {{ lockReason() }}
        </p>
      }

      <ng-content />
    </div>
  `,
})
export class OptionCard {
  readonly selected = input.required<boolean>();
  readonly disabled = input(false);
  /** Shown in place of the radio when the option is locked, not merely unavailable. */
  readonly lockReason = input<string | null>(null);
  readonly title = input.required<string>();
  readonly select = output<void>();
}
