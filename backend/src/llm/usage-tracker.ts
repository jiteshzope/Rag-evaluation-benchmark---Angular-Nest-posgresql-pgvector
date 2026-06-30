import { USAGE_STAGES, UsageRecord, UsageStage, UsageTotals } from '../common/types';

function emptyByStage(): Record<UsageStage, number> {
  return USAGE_STAGES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<UsageStage, number>,
  );
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    embeddingTokens: 0,
    costUsd: 0,
    costByStage: emptyByStage(),
    tokensByStage: emptyByStage(),
  };
}

/**
 * Accumulates per-call usage into a running total.
 *
 * One tracker is created per question so the dashboard can attribute cost to the
 * exact stage that spent it — the whole point of the efficiency panel is
 * answering "does the retrieval gain justify the extra spend?".
 */
export class UsageTracker {
  private readonly records: UsageRecord[] = [];

  add(record: UsageRecord): void {
    this.records.push(record);
  }

  /** Fold another tracker's records in (e.g. a sub-pipeline's). */
  merge(other: UsageTracker): void {
    this.records.push(...other.records);
  }

  all(): readonly UsageRecord[] {
    return this.records;
  }

  totals(): UsageTotals {
    const t = emptyUsage();

    for (const r of this.records) {
      const stageTokens = r.inputTokens + r.outputTokens;

      if (r.stage === 'embedding') {
        t.embeddingTokens += r.inputTokens;
      }

      t.inputTokens += r.inputTokens;
      t.cachedInputTokens += r.cachedInputTokens;
      t.outputTokens += r.outputTokens;
      t.costUsd += r.costUsd;
      t.costByStage[r.stage] += r.costUsd;
      t.tokensByStage[r.stage] += stageTokens;
    }

    t.totalTokens = t.inputTokens + t.outputTokens;
    return t;
  }
}

/** Sum a list of totals — used when aggregating a whole strategy run. */
export function sumUsage(list: UsageTotals[]): UsageTotals {
  const out = emptyUsage();
  for (const u of list) {
    out.inputTokens += u.inputTokens;
    out.cachedInputTokens += u.cachedInputTokens;
    out.outputTokens += u.outputTokens;
    out.totalTokens += u.totalTokens;
    out.embeddingTokens += u.embeddingTokens;
    out.costUsd += u.costUsd;
    for (const s of USAGE_STAGES) {
      out.costByStage[s] += u.costByStage[s];
      out.tokensByStage[s] += u.tokensByStage[s];
    }
  }
  return out;
}

/** Divide totals by a question count to get per-question averages. */
export function divideUsage(u: UsageTotals, divisor: number): UsageTotals {
  const d = divisor > 0 ? divisor : 1;
  const out = emptyUsage();
  out.inputTokens = u.inputTokens / d;
  out.cachedInputTokens = u.cachedInputTokens / d;
  out.outputTokens = u.outputTokens / d;
  out.totalTokens = u.totalTokens / d;
  out.embeddingTokens = u.embeddingTokens / d;
  out.costUsd = u.costUsd / d;
  for (const s of USAGE_STAGES) {
    out.costByStage[s] = u.costByStage[s] / d;
    out.tokensByStage[s] = u.tokensByStage[s] / d;
  }
  return out;
}
