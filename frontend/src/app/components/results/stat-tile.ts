import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { fmtDelta } from '../../lib/format';

/**
 * A labelled family of metrics.
 *
 * The three families answer different questions — did retrieval find the right
 * passages, did the generator use them well, what did that cost — so they get
 * their own headings and their own colour rather than running together as three
 * anonymous rows of tiles.
 */
@Component({
  selector: 'app-metric-family',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [style.--family]="color()">
      <div class="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span
          aria-hidden="true"
          class="inline-block h-3 w-1 rounded-full"
          [style.background]="color()"
        ></span>
        <h3 class="text-xs font-semibold uppercase tracking-wide text-ink-primary">
          {{ title() }}
        </h3>
        <p class="text-2xs text-ink-muted">{{ blurb() }}</p>
      </div>
      <ng-content />
    </section>
  `,
})
export class MetricFamily {
  readonly title = input.required<string>();
  readonly blurb = input.required<string>();
  readonly color = input.required<string>();
}

/**
 * A single headline number. No plot, no colour-coded value — the number wears a
 * text token and the delta chip carries the only colour.
 */
@Component({
  selector: 'app-stat-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- The hero tile borrows the family's colour; the rest stay neutral so the
         eye lands on the headline number first. -->
    <div
      class="card card-pad flex min-w-0 flex-col gap-1"
      [class.ring-1]="hero()"
      [style.background]="
        hero() ? 'color-mix(in srgb, var(--family) var(--tint-wash), var(--surface-1))' : null
      "
      [style.borderColor]="
        hero() ? 'color-mix(in srgb, var(--family) var(--tint-edge), transparent)' : null
      "
    >
      <p class="label truncate" [title]="label()">{{ label() }}</p>
      <p
        class="font-semibold tabular-nums leading-none text-ink-primary"
        [class]="hero() ? 'text-3xl' : 'text-2xl'"
      >
        {{ value() }}
      </p>
      <div class="flex min-h-[18px] items-center gap-1.5">
        @if (showDelta()) {
          <span
            class="text-2xs font-medium tabular-nums"
            [class]="improved() ? 'text-status-good' : 'text-status-serious'"
          >
            {{ improved() ? '▲' : '▼' }} {{ deltaLabel() }}
          </span>
        }
        @if (hint()) {
          <span class="truncate text-2xs text-ink-muted">{{ hint() }}</span>
        }
      </div>
    </div>
  `,
})
export class StatTile {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  /** Signed change vs the comparison strategy, when there is one. */
  readonly delta = input<number | null>(null);
  /** For cost and latency, lower is better — flips the delta's colour. */
  readonly lowerIsBetter = input(false);
  readonly hint = input<string | null>(null);
  /** The one number that leads its family: larger, and tinted with `--family`. */
  readonly hero = input(false);

  protected readonly showDelta = computed(() => {
    const delta = this.delta();
    return delta !== null && delta !== undefined && Math.abs(delta) >= 0.0005;
  });

  protected readonly improved = computed(() => {
    const delta = this.delta();
    if (delta === null || delta === undefined) return null;
    return this.lowerIsBetter() ? delta < 0 : delta > 0;
  });

  protected readonly deltaLabel = computed(() => fmtDelta(this.delta()));
}
