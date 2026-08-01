import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import {
  AXIS_LINE_STROKE,
  AXIS_TICK_FILL,
  AXIS_TICK_FONT_SIZE,
  BAR_CATEGORY_GAP,
  BAR_GAP,
  BAR_RADIUS,
  GRID_STROKE,
} from './chart-bits';

export interface BarSeries {
  key: string;
  label: string;
  color: string;
}

export type BarDatum = Record<string, string | number>;

export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface RenderedBar {
  key: string;
  path: string;
  fill: string;
  label: string;
  labelX: number;
  labelY: number;
  labelAnchor: 'start' | 'middle';
}

interface RenderedCategory {
  key: string;
  label: string;
  /** Centre of the band along the category axis. */
  center: number;
  /** Band rectangle, used for the hover cursor and hit-testing. */
  bandStart: number;
  bandSize: number;
  bars: RenderedBar[];
}

interface AxisTick {
  value: number;
  offset: number;
  label: string;
}

interface Geometry {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  valueTicks: AxisTick[];
  categories: RenderedCategory[];
}

interface TooltipRow {
  label: string;
  color: string;
  value: string;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  rows: TooltipRow[];
  footer: string | null;
  cursorStart: number;
  cursorSize: number;
}

const CATEGORY_AXIS_HEIGHT = 30;

/**
 * The chart primitive the whole results screen is drawn with.
 *
 * The React build used Recharts, which has no Angular equivalent that renders
 * the same marks, so the geometry is computed here and emitted as plain SVG:
 * grouped columns or sorted rows, a recessive horizontal grid, direct value
 * labels on every bar, and one tooltip design shared by every chart. Sizing
 * follows the container through a ResizeObserver, which is what Recharts'
 * ResponsiveContainer did.
 */
@Component({
  selector: 'app-bar-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './bar-chart.html',
  host: { class: 'relative block w-full' },
})
export class BarChart {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly data = input.required<BarDatum[]>();
  readonly categoryKey = input.required<string>();
  readonly series = input.required<BarSeries[]>();

  /** `columns` draws vertical bars; `rows` draws horizontal ones. */
  readonly orientation = input<'columns' | 'rows'>('columns');
  readonly chartHeight = input.required<number>();
  readonly margin = input<ChartMargin>({ top: 16, right: 8, bottom: 4, left: 0 });

  /** Fixed value-axis domain; omit to scale to the data. */
  readonly valueDomain = input<[number, number] | null>(null);
  readonly valueTicks = input<number[] | null>(null);
  /** Space reserved for the value axis (`columns`) or the category axis (`rows`). */
  readonly axisWidth = input(44);
  readonly maxBarSize = input(26);

  /** Per-category fills, used where magnitude rather than identity is the point. */
  readonly cellColors = input<string[] | null>(null);

  readonly tickFormat = input<(value: number) => string>((v) => String(v));
  readonly tooltipFormat = input<(value: number) => string>((v) => v.toFixed(3));
  /** Returns '' to suppress a bar's direct label; omit the input for no labels. */
  readonly labelFormat = input<((value: number) => string) | null>(null);
  readonly labelFill = input('fill-ink-muted');
  readonly labelFontSize = input(9);
  readonly tooltipFooter = input<((categoryLabel: string) => string | null) | null>(null);

  readonly axisTickFill = AXIS_TICK_FILL;
  readonly axisTickFontSize = AXIS_TICK_FONT_SIZE;
  readonly axisLineStroke = AXIS_LINE_STROKE;
  readonly gridStroke = GRID_STROKE;

  private readonly containerWidth = signal(0);
  protected readonly tooltip = signal<TooltipState | null>(null);

  constructor() {
    const element = this.host.nativeElement as HTMLElement;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      this.containerWidth.set(Math.round(width));
    });
    observer.observe(element);
    this.containerWidth.set(Math.round(element.getBoundingClientRect().width));

    effect((onCleanup) => {
      onCleanup(() => observer.disconnect());
    });
  }

  protected readonly isRows = computed(() => this.orientation() === 'rows');

  protected readonly geometry = computed<Geometry | null>(() => {
    const width = this.containerWidth();
    const height = this.chartHeight();
    const rows = this.data();
    const series = this.series();
    if (width <= 0 || rows.length === 0 || series.length === 0) return null;

    const margin = this.margin();
    const rowLayout = this.isRows();

    const plotLeft = margin.left + (rowLayout ? this.axisWidth() : this.axisWidth());
    const plotRight = Math.max(plotLeft + 1, width - margin.right);
    const plotTop = margin.top;
    const plotBottom = Math.max(plotTop + 1, height - margin.bottom - CATEGORY_AXIS_HEIGHT);

    // ── Value scale ─────────────────────────────────────────────────────────
    const values = rows.flatMap((row) =>
      series.map((s) => {
        const raw = row[s.key];
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      }),
    );
    const dataMax = values.length > 0 ? Math.max(...values) : 0;

    const fixedDomain = this.valueDomain();
    const explicitTicks = this.valueTicks();
    const ticks = explicitTicks ?? niceTicks(dataMax);
    const domainMin = fixedDomain ? fixedDomain[0] : Math.min(0, ...ticks);
    const domainMax = fixedDomain ? fixedDomain[1] : Math.max(dataMax, ...ticks);
    const span = domainMax - domainMin || 1;

    const valueAxisLength = rowLayout ? plotRight - plotLeft : plotBottom - plotTop;
    const toOffset = (value: number) => {
      const ratio = (value - domainMin) / span;
      return rowLayout ? plotLeft + ratio * valueAxisLength : plotBottom - ratio * valueAxisLength;
    };

    const format = this.tickFormat();
    const valueTicks: AxisTick[] = ticks.map((value) => ({
      value,
      offset: toOffset(value),
      label: format(value),
    }));

    // ── Category bands ──────────────────────────────────────────────────────
    const categoryStart = rowLayout ? plotTop : plotLeft;
    const categoryLength = rowLayout ? plotBottom - plotTop : plotRight - plotLeft;
    const bandSize = categoryLength / rows.length;
    const groupSpace = bandSize * (1 - BAR_CATEGORY_GAP);

    const barGap = series.length > 1 ? BAR_GAP : 0;
    const rawThickness = (groupSpace - barGap * (series.length - 1)) / series.length;
    const thickness = Math.max(1, Math.min(this.maxBarSize(), rawThickness));
    const groupThickness = thickness * series.length + barGap * (series.length - 1);

    const cellColors = this.cellColors();
    const labelFormat = this.labelFormat();
    const baseline = toOffset(Math.max(domainMin, 0));

    const categories: RenderedCategory[] = rows.map((row, index) => {
      const bandStart = categoryStart + index * bandSize;
      const center = bandStart + bandSize / 2;
      const groupStart = center - groupThickness / 2;

      const bars: RenderedBar[] = series.map((s, seriesIndex) => {
        const raw = row[s.key];
        const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        const end = toOffset(value);
        const offset = groupStart + seriesIndex * (thickness + barGap);
        const fill = cellColors ? cellColors[Math.min(index, cellColors.length - 1)] : s.color;

        const path = rowLayout
          ? roundedRightPath(baseline, offset, Math.abs(end - baseline), thickness)
          : roundedTopPath(offset, Math.min(end, baseline), thickness, Math.abs(baseline - end));

        return {
          key: s.key,
          path,
          fill,
          label: labelFormat ? labelFormat(value) : '',
          labelX: rowLayout ? end + 6 : offset + thickness / 2,
          labelY: rowLayout ? offset + thickness / 2 : Math.min(end, baseline) - 4,
          labelAnchor: rowLayout ? 'start' : 'middle',
        };
      });

      return {
        key: String(row[this.categoryKey()] ?? index),
        label: String(row[this.categoryKey()] ?? ''),
        center,
        bandStart,
        bandSize,
        bars,
      };
    });

    return { width, height, plotLeft, plotRight, plotTop, plotBottom, valueTicks, categories };
  });

  protected readonly cursor = computed(() => {
    const state = this.tooltip();
    const geometry = this.geometry();
    if (!state || !geometry) return null;
    return this.isRows()
      ? {
          x: geometry.plotLeft,
          y: state.cursorStart,
          width: geometry.plotRight - geometry.plotLeft,
          height: state.cursorSize,
        }
      : {
          x: state.cursorStart,
          y: geometry.plotTop,
          width: state.cursorSize,
          height: geometry.plotBottom - geometry.plotTop,
        };
  });

  protected onPointerMove(event: MouseEvent): void {
    const geometry = this.geometry();
    if (!geometry) return;

    const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const along = this.isRows() ? y : x;

    const category = geometry.categories.find(
      (c) => along >= c.bandStart && along < c.bandStart + c.bandSize,
    );
    if (!category) {
      this.tooltip.set(null);
      return;
    }

    const rows = this.data();
    const index = geometry.categories.indexOf(category);
    const datum = rows[index];
    const format = this.tooltipFormat();
    const cellColors = this.cellColors();

    this.tooltip.set({
      x,
      y,
      title: category.label,
      rows: this.series().map((s, seriesIndex) => {
        const raw = datum[s.key];
        const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        return {
          label: s.label,
          color: cellColors ? cellColors[Math.min(index, cellColors.length - 1)] : s.color,
          value: format(value),
        };
      }),
      footer: this.tooltipFooter()?.(category.label) ?? null,
      cursorStart: category.bandStart,
      cursorSize: category.bandSize,
    });
  }

  protected onPointerLeave(): void {
    this.tooltip.set(null);
  }

  /**
   * Keeps the tooltip inside the chart. It trails the cursor the way Recharts'
   * did, but flips to the other side rather than being clipped at the edge.
   */
  protected tooltipLeft(state: TooltipState): number {
    const width = this.containerWidth();
    const estimated = 190;
    return state.x + estimated + 16 > width ? Math.max(4, state.x - estimated - 12) : state.x + 12;
  }
}

/** Bar with its data-end rounded and its baseline flat. */
function roundedTopPath(x: number, y: number, width: number, height: number): string {
  const r = Math.max(0, Math.min(BAR_RADIUS, width / 2, height));
  if (height <= 0) return '';
  return [
    `M${x},${y + height}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + width - r},${y}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `L${x + width},${y + height}`,
    'Z',
  ].join(' ');
}

function roundedRightPath(x: number, y: number, width: number, height: number): string {
  const r = Math.max(0, Math.min(BAR_RADIUS, height / 2, width));
  if (width <= 0) return '';
  return [
    `M${x},${y}`,
    `L${x + width - r},${y}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `L${x + width},${y + height - r}`,
    `Q${x + width},${y + height} ${x + width - r},${y + height}`,
    `L${x},${y + height}`,
    'Z',
  ].join(' ');
}

/**
 * Tick values that land on round numbers, so an axis reads 0 / 700 / 1.4k
 * rather than 0 / 1,847 / 3,694.
 *
 * This is Recharts' rule rather than the more common 1-2-5 one, so the axes here
 * carry the same numbers the React build's did: the rough step is scaled into
 * [0.1, 1), rounded *up* to a multiple of 0.05, and scaled back. That is what
 * produces steps like 350 and 700, which a 1-2-5 rule would never choose.
 */
function niceTicks(max: number, count = 5): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];

  // The domain always starts at 0 here, so the tick count is satisfied by
  // growing the top end; the correction factor only ever needs to shrink a step
  // that overshot it.
  for (let correction = 0; correction < 20; correction += 1) {
    const step = formatStep(max / (count - 1), correction);
    if (step <= 0) break;
    if (Math.ceil(round(max / step)) + 1 <= count) {
      return Array.from({ length: count }, (_, i) => round(i * step));
    }
  }

  const fallback = max / (count - 1);
  return Array.from({ length: count }, (_, i) => round(i * fallback));
}

/** Rounds a rough step up to the nearest 0.05 of its own magnitude. */
function formatStep(roughStep: number, correction: number): number {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 0;

  const digitCount = Math.floor(Math.log10(roughStep)) + 1;
  const magnitude = Math.pow(10, digitCount);
  const ratio = roughStep / magnitude;
  const ratioScale = digitCount !== 1 ? 0.05 : 0.1;
  const amended = (Math.ceil(round(ratio / ratioScale)) + correction) * ratioScale;

  return round(amended * magnitude);
}

function round(value: number): number {
  return Number(value.toPrecision(12));
}
