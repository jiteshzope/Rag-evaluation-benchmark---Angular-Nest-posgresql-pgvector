import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Shared axis/grid values so every chart in the app reads as one system. */
export const AXIS_TICK_FILL = 'var(--text-secondary)';
export const AXIS_TICK_FONT_SIZE = 11;
export const AXIS_LINE_STROKE = 'var(--border)';
export const GRID_STROKE = 'var(--grid)';

/** 4px rounded data-end, anchored flat to the baseline. */
export const BAR_RADIUS = 4;

/** 2px surface gap between adjacent bars in a group. */
export const BAR_GAP = 2;

/** Share of each category band left empty between groups. */
export const BAR_CATEGORY_GAP = 0.22;

export interface LegendItem {
  label: string;
  color: string;
  note?: string;
}

/**
 * Legend rendered outside the SVG so it can wrap and stay legible on narrow
 * screens. Always present when a chart has two or more series — identity is
 * never conveyed by colour alone.
 */
@Component({
  selector: 'app-chart-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
      @for (item of items(); track item.label) {
        <li class="flex items-center gap-1.5 text-2xs text-ink-secondary">
          <span
            aria-hidden="true"
            class="h-2.5 w-2.5 shrink-0 rounded-sm"
            [style.background]="item.color"
          ></span>
          <span class="font-medium text-ink-primary">{{ item.label }}</span>
          @if (item.note) {
            <span class="text-ink-muted">{{ item.note }}</span>
          }
        </li>
      }
    </ul>
  `,
})
export class ChartLegend {
  readonly items = input.required<LegendItem[]>();
}

/** Shown in place of a chart when a run produced no rows for it. */
@Component({
  selector: 'app-empty-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex h-[220px] items-center justify-center rounded-lg border border-dashed border-line"
    >
      <p class="max-w-xs text-center text-xs text-ink-muted">{{ message() }}</p>
    </div>
  `,
})
export class EmptyChart {
  readonly message = input.required<string>();
}
