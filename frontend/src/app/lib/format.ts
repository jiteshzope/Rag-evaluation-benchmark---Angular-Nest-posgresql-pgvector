import type { QuestionType, StrategyId } from '../api/types';

/** Categorical slots, assigned in fixed order and never cycled. */
export const SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
] as const;

/**
 * Colour follows the entity, not its rank: a strategy keeps the same hue no
 * matter which subset of strategies a run includes, so charts stay comparable
 * across runs and a filter never repaints the survivors.
 */
export const STRATEGY_COLOR: Record<StrategyId, string> = {
  baseline: 'var(--series-1)',
  advanced: 'var(--series-2)',
  'advanced-pro': 'var(--series-3)',
  graphrag: 'var(--series-4)',
};

export const STRATEGY_SHORT: Record<StrategyId, string> = {
  baseline: 'Baseline',
  advanced: 'Advanced',
  'advanced-pro': 'Advanced-Pro',
  graphrag: 'GraphRAG',
};

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  direct_fact: 'Direct fact',
  temporal: 'Temporal',
  comparative: 'Comparative',
  numerical: 'Numerical',
  relationship: 'Relationship',
  spanning: 'Spanning',
  holistic: 'Holistic',
  multi_hop: 'Multi-hop',
  procedural: 'Procedural',
  definition: 'Definition',
  summarization: 'Summarization',
  other: 'Other',
};

export function questionTypeLabel(type: string): string {
  return QUESTION_TYPE_LABEL[type as QuestionType] ?? type;
}

/** 0-1 metric rendered as a 3-decimal score, the convention in IR papers. */
export function fmtScore(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(3);
}

export function fmtPercent(value: number | undefined | null, digits = 0): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Cost. Per-question figures are fractions of a cent, so a fixed 2-decimal
 * dollar format would render every strategy as "$0.00" and hide the entire
 * cost story. Scale the precision to the magnitude instead.
 */
export function fmtCost(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.001) return `$${value.toFixed(6)}`;
  if (value < 0.01) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function fmtTokens(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString('en-US');
}

export function fmtDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function fmtBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function fmtNumber(value: number | undefined | null, digits = 0): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Relative delta vs a baseline value, for the "+12%" chips on stat tiles. */
export function relativeDelta(value: number, baseline: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) return null;
  return (value - baseline) / baseline;
}

export function fmtDelta(delta: number | null): string {
  if (delta === null) return '';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${(delta * 100).toFixed(1)}%`;
}

export const RETRIEVAL_SOURCE_LABEL: Record<string, string> = {
  dense: 'Dense',
  bm25: 'BM25',
  rrf: 'RRF',
  rerank: 'Reranked',
  'graph-local': 'Graph local',
  'graph-global': 'Graph global',
  'graph-drift': 'Graph DRIFT',
  'parent-expansion': 'Parent expansion',
  compression: 'Compressed',
};

export const USAGE_STAGE_LABEL: Record<string, string> = {
  embedding: 'Embedding',
  'query-transform': 'Query transform',
  rerank: 'Reranking',
  graph: 'Graph',
  answer: 'Answer LLM',
  judge: 'Judge LLM',
  'dataset-generation': 'Dataset generation',
};
