import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Standard frame around every chart: a title that states the finding, a
 * recessive subtitle, and an optional table view.
 *
 * The table view is not decoration. Three of the light-mode series colours sit
 * below 3:1 contrast against the surface, so the palette's relief rule requires
 * that the same numbers be legible without relying on colour.
 */
@Component({
  selector: 'app-chart-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="card card-pad m-0 flex flex-col gap-3" [class]="extraClass()">
      <figcaption class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-ink-primary">{{ title() }}</h3>
          @if (subtitle()) {
            <p class="mt-0.5 text-xs text-ink-secondary">{{ subtitle() }}</p>
          }
        </div>
        @if (aside()) {
          <div class="shrink-0 text-2xs text-ink-muted">{{ aside() }}</div>
        }
      </figcaption>

      <div class="min-w-0"><ng-content /></div>

      @if (hasTable()) {
        <details class="group mt-1">
          <summary
            class="cursor-pointer list-none text-2xs font-medium text-ink-muted transition-colors hover:text-ink-secondary"
          >
            <span class="inline-flex items-center gap-1">
              <svg
                viewBox="0 0 12 12"
                class="h-3 w-3 transition-transform group-open:rotate-90"
                aria-hidden="true"
              >
                <path
                  d="M4 2l4 4-4 4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              View as table
            </span>
          </summary>
          <div class="scroll-x mt-2"><ng-content select="[chartTable]" /></div>
        </details>
      }
    </figure>
  `,
})
export class ChartFrame {
  readonly title = input.required<string>();
  /** One sentence saying what the reader should take from the chart. */
  readonly subtitle = input<string | null>(null);
  /** Rendered top-right — usually a unit note. */
  readonly aside = input<string | null>(null);
  readonly extraClass = input('');
  /** Whether a `[chartTable]` view has been projected. */
  readonly hasTable = input(true);
}

/** Plain data table used for the "view as table" disclosure under each chart. */
@Component({
  selector: 'app-data-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table class="w-full border-collapse text-2xs">
      <thead>
        <tr class="border-b border-line">
          @for (col of columns(); track col; let i = $index) {
            <th
              scope="col"
              class="whitespace-nowrap px-2 py-1.5 font-medium text-ink-secondary"
              [class.text-left]="i === 0"
              [class.text-right]="i !== 0"
            >
              {{ col }}
            </th>
          }
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track $index) {
          <tr class="border-b border-line/60 last:border-0">
            @for (cell of row; track $index; let c = $index) {
              <td
                class="whitespace-nowrap px-2 py-1.5 tabular-nums"
                [class]="
                  c === 0
                    ? 'text-left font-medium text-ink-primary'
                    : 'text-right text-ink-secondary'
                "
              >
                {{ cell }}
              </td>
            }
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class DataTable {
  readonly columns = input.required<string[]>();
  readonly rows = input.required<Array<Array<string | number>>>();
}
