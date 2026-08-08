import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { StrategySummary } from '../../api/types';
import { fmtScore, questionTypeLabel } from '../../lib/format';
import { BarChart, type BarDatum, type BarSeries } from '../ui/bar-chart';
import { ChartLegend, EmptyChart } from '../ui/chart-bits';
import { ChartFrame, DataTable } from '../ui/chart-frame';

const SERIES: BarSeries[] = [
  { key: 'faithfulness', label: 'Faithfulness', color: 'var(--series-1)' },
  { key: 'factualCorrectness', label: 'Correctness', color: 'var(--series-2)' },
  { key: 'answerRelevance', label: 'Relevance', color: 'var(--series-3)' },
  { key: 'judgeScore', label: 'Judge score', color: 'var(--series-4)' },
];

/**
 * Answer quality by question type — kept deliberately separate from the
 * retrieval chart.
 *
 * Mixing them would hide the most interesting failure mode in RAG: retrieval
 * that finds the right evidence while generation still gets the answer wrong,
 * or the reverse. Two charts keep the two layers legible.
 */
@Component({
  selector: 'app-answer-quality-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarChart, ChartFrame, ChartLegend, DataTable, EmptyChart],
  templateUrl: './answer-quality-chart.html',
})
export class AnswerQualityChart {
  readonly summary = input.required<StrategySummary>();

  protected readonly series = SERIES;
  protected readonly legend = SERIES.map((s) => ({ label: s.label, color: s.color }));
  protected readonly scoreDomain: [number, number] = [0, 1];
  protected readonly scoreTicks = [0, 0.25, 0.5, 0.75, 1];

  protected readonly data = computed<BarDatum[]>(() =>
    this.summary().byQuestionType.map((row) => ({
      type: questionTypeLabel(row.questionType),
      count: row.count,
      faithfulness: row.faithfulness,
      factualCorrectness: row.factualCorrectness,
      answerRelevance: row.answerRelevance,
      judgeScore: row.judgeScore,
    })),
  );

  protected readonly minWidth = computed(() => Math.max(460, this.data().length * 150));

  protected readonly aside = computed(() => `${this.summary().label} · LLM judge`);

  protected readonly tableRows = computed(() =>
    this.data().map((r) => [
      String(r['type']),
      Number(r['count']),
      fmtScore(Number(r['faithfulness'])),
      fmtScore(Number(r['factualCorrectness'])),
      fmtScore(Number(r['answerRelevance'])),
      fmtScore(Number(r['judgeScore'])),
    ]),
  );

  protected readonly tickFormat = (v: number) => String(v);
  protected readonly tooltipFormat = (v: number) => fmtScore(v);
  protected readonly labelFormat = (v: number) => (v >= 0.005 ? v.toFixed(2) : '');

  protected readonly tooltipFooter = (label: string): string | null => {
    const row = this.data().find((d) => d['type'] === label);
    if (!row) return null;
    const count = Number(row['count']);
    return `${count} question${count === 1 ? '' : 's'}`;
  };
}
