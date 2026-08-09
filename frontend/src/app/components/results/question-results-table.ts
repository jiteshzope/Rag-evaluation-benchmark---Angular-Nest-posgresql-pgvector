import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { QuestionResult, StrategyId } from '../../api/types';
import {
  STRATEGY_COLOR,
  STRATEGY_SHORT,
  fmtCost,
  fmtDuration,
  fmtScore,
  questionTypeLabel,
} from '../../lib/format';

const VERDICT_STYLE: Record<string, string> = {
  pass: 'text-status-good',
  partial: 'text-status-warning',
  fail: 'text-status-critical',
};

const VERDICT_ICON: Record<string, string> = {
  pass: '●',
  partial: '◐',
  fail: '○',
};

type SortDirection = 'asc' | 'desc';

interface Column {
  id: string;
  header: string;
  accessor: (row: QuestionResult) => string | number;
}

interface DisplayRow {
  key: string;
  result: QuestionResult;
  question: string;
  strategyLabel: string;
  strategyColor: string;
  type: string;
  mrr: string;
  ndcg: string;
  faithfulness: string;
  judge: string;
  verdict: string;
  verdictClass: string;
  verdictIcon: string;
  cost: string;
  latency: string;
}

const PAGE_SIZE = 25;

/**
 * Per-question explorer. For debugging a RAG pipeline this is often more useful
 * than the charts: it is where you find the individual question that broke.
 *
 * Sorting, filtering and paging are all derived signals over the streamed
 * results — the same job TanStack Table did in the React build, minus the
 * dependency.
 */
@Component({
  selector: 'app-question-results-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './question-results-table.html',
})
export class QuestionResultsTable {
  readonly results = input.required<QuestionResult[]>();
  readonly strategies = input.required<StrategyId[]>();
  readonly select = output<QuestionResult>();

  protected readonly query = signal('');
  protected readonly verdictFilter = signal<'all' | 'pass' | 'partial' | 'fail'>('all');
  protected readonly strategyFilter = signal<StrategyId | 'all'>('all');
  protected readonly sortId = signal<string | null>(null);
  protected readonly sortDirection = signal<SortDirection>('asc');
  protected readonly pageIndex = signal(0);

  protected readonly STRATEGY_SHORT = STRATEGY_SHORT;

  protected readonly columns = computed<Column[]>(() => [
    { id: 'question', header: 'Question', accessor: (r) => r.question },
    ...(this.strategies().length > 1
      ? [{ id: 'strategy', header: 'Strategy', accessor: (r: QuestionResult) => r.strategy }]
      : []),
    { id: 'questionType', header: 'Type', accessor: (r) => r.questionType },
    { id: 'mrr', header: 'RR', accessor: (r) => r.retrieval.reciprocalRank },
    { id: 'ndcg', header: 'nDCG', accessor: (r) => r.retrieval.ndcg },
    { id: 'faithfulness', header: 'Faithful', accessor: (r) => r.answer.faithfulness },
    { id: 'judge', header: 'Judge', accessor: (r) => r.answer.judgeScore },
    { id: 'verdict', header: 'Verdict', accessor: (r) => r.answer.verdict },
    { id: 'cost', header: 'Cost', accessor: (r) => r.usage.costUsd },
    { id: 'latency', header: 'Latency', accessor: (r) => r.latency.totalMs },
  ]);

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const verdict = this.verdictFilter();
    const strategy = this.strategyFilter();

    return this.results().filter((r) => {
      if (verdict !== 'all' && r.answer.verdict !== verdict) return false;
      if (strategy !== 'all' && r.strategy !== strategy) return false;
      if (!q) return true;
      return (
        r.question.toLowerCase().includes(q) ||
        r.generatedAnswer.toLowerCase().includes(q) ||
        r.referenceAnswer.toLowerCase().includes(q)
      );
    });
  });

  private readonly sorted = computed(() => {
    const id = this.sortId();
    const rows = this.filtered();
    if (!id) return rows;

    const column = this.columns().find((c) => c.id === id);
    if (!column) return rows;

    const direction = this.sortDirection() === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = column.accessor(a);
      const right = column.accessor(b);
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction;
      return String(left).localeCompare(String(right)) * direction;
    });
  });

  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.sorted().length / PAGE_SIZE)),
  );

  /** Clamped so deleting rows out from under the last page cannot strand it. */
  protected readonly currentPage = computed(() => Math.min(this.pageIndex(), this.pageCount() - 1));

  protected readonly rows = computed<DisplayRow[]>(() => {
    const start = this.currentPage() * PAGE_SIZE;
    return this.sorted()
      .slice(start, start + PAGE_SIZE)
      .map((result) => ({
        key: `${result.strategy}:${result.itemId}`,
        result,
        question: result.question,
        strategyLabel: STRATEGY_SHORT[result.strategy],
        strategyColor: STRATEGY_COLOR[result.strategy],
        type: questionTypeLabel(result.questionType),
        mrr: fmtScore(result.retrieval.reciprocalRank),
        ndcg: fmtScore(result.retrieval.ndcg),
        faithfulness: fmtScore(result.answer.faithfulness),
        judge: fmtScore(result.answer.judgeScore),
        verdict: result.answer.verdict,
        verdictClass: VERDICT_STYLE[result.answer.verdict] ?? '',
        verdictIcon: VERDICT_ICON[result.answer.verdict] ?? '',
        cost: fmtCost(result.usage.costUsd),
        latency: fmtDuration(result.latency.totalMs),
      }));
  });

  protected readonly canPreviousPage = computed(() => this.currentPage() > 0);
  protected readonly canNextPage = computed(() => this.currentPage() < this.pageCount() - 1);

  /** asc → desc → unsorted, matching the table this replaces. */
  protected toggleSort(id: string): void {
    if (this.sortId() !== id) {
      this.sortId.set(id);
      this.sortDirection.set('asc');
    } else if (this.sortDirection() === 'asc') {
      this.sortDirection.set('desc');
    } else {
      this.sortId.set(null);
    }
    this.pageIndex.set(0);
  }

  protected sortIndicator(id: string): string {
    if (this.sortId() !== id) return '';
    return this.sortDirection() === 'asc' ? '↑' : '↓';
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    this.pageIndex.set(0);
  }

  protected setVerdictFilter(value: string): void {
    this.verdictFilter.set(value as 'all' | 'pass' | 'partial' | 'fail');
    this.pageIndex.set(0);
  }

  protected setStrategyFilter(value: string): void {
    this.strategyFilter.set(value as StrategyId | 'all');
    this.pageIndex.set(0);
  }

  protected previousPage(): void {
    this.pageIndex.set(Math.max(0, this.currentPage() - 1));
  }

  protected nextPage(): void {
    this.pageIndex.set(Math.min(this.pageCount() - 1, this.currentPage() + 1));
  }

  protected onRowKeydown(event: KeyboardEvent, result: QuestionResult): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.select.emit(result);
    }
  }
}
