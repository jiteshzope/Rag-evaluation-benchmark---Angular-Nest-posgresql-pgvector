import { Injectable } from '@nestjs/common';

import {
  AnswerMetricAverages,
  IndexingStats,
  MetricAggregate,
  QuestionResult,
  QuestionTypeSummary,
  RetrievalMetricAverages,
  StrategyId,
  StrategySummary,
} from '../common/types';
import { divideUsage, sumUsage } from '../llm/usage-tracker';

/**
 * Weights for the composite score.
 *
 * Retrieval and answer quality are weighted equally on purpose: a strategy that
 * retrieves perfectly but hallucinates is not a good strategy, and neither is
 * one that writes fluently from the wrong evidence. The raw components stay
 * visible in the dashboard so this single number never has to be trusted alone.
 */
const COMPOSITE_WEIGHTS = {
  ndcg: 0.2,
  recall: 0.15,
  contextPrecision: 0.15,
  faithfulness: 0.2,
  factualCorrectness: 0.2,
  answerRelevance: 0.1,
} as const;

@Injectable()
export class ResultAggregatorService {
  summarize(
    strategy: StrategyId,
    label: string,
    results: QuestionResult[],
    indexing: IndexingStats,
  ): StrategySummary {
    const succeeded = results.filter((r) => !r.error);
    const failures = results.length - succeeded.length;

    // Averages are taken over questions that actually ran. A crashed question
    // should not silently drag a strategy's mean toward zero — it is reported
    // separately as a failure count.
    const basis = succeeded.length > 0 ? succeeded : [];

    const retrieval = meanOf<RetrievalMetricAverages>(basis, (r) => ({
      reciprocalRank: r.retrieval.reciprocalRank,
      ndcg: r.retrieval.ndcg,
      recall: r.retrieval.recall,
      precision: r.retrieval.precision,
      hitRate: r.retrieval.hitRate,
      contextKeywordCoverage: r.retrieval.contextKeywordCoverage,
      contextPrecision: r.retrieval.contextPrecision,
      contextRecall: r.retrieval.contextRecall,
      relevantRetrieved: r.retrieval.relevantRetrieved,
      relevantTotal: r.retrieval.relevantTotal,
    }));

    const answer = meanOf<AnswerMetricAverages>(basis, (r) => ({
      faithfulness: r.answer.faithfulness,
      factualCorrectness: r.answer.factualCorrectness,
      answerRelevance: r.answer.answerRelevance,
      judgeScore: r.answer.judgeScore,
      answerKeywordCoverage: r.answer.answerKeywordCoverage,
      referenceSimilarity: r.answer.referenceSimilarity,
    }));

    const usage = sumUsage(results.map((r) => r.usage));

    return {
      strategy,
      label,
      questionCount: results.length,
      failures,
      retrieval,
      answer,
      compositeScore: composite(retrieval, answer, results.length, failures),
      usage,
      usagePerQuestion: divideUsage(usage, results.length),
      latency: {
        retrieval: aggregate(basis.map((r) => r.latency.retrievalMs)),
        answer: aggregate(basis.map((r) => r.latency.answerMs)),
        judge: aggregate(basis.map((r) => r.latency.judgeMs)),
        total: aggregate(basis.map((r) => r.latency.totalMs)),
      },
      byQuestionType: this.byQuestionType(basis),
      verdicts: {
        pass: basis.filter((r) => r.answer.verdict === 'pass').length,
        partial: basis.filter((r) => r.answer.verdict === 'partial').length,
        fail: basis.filter((r) => r.answer.verdict === 'fail').length + failures,
      },
      indexing,
    };
  }

  private byQuestionType(results: QuestionResult[]): QuestionTypeSummary[] {
    const groups = new Map<string, QuestionResult[]>();
    for (const r of results) {
      const list = groups.get(r.questionType) ?? [];
      list.push(r);
      groups.set(r.questionType, list);
    }

    return [...groups.entries()]
      .map(([questionType, group]) => ({
        questionType: questionType as QuestionTypeSummary['questionType'],
        count: group.length,
        mrr: mean(group.map((r) => r.retrieval.reciprocalRank)),
        ndcg: mean(group.map((r) => r.retrieval.ndcg)),
        recall: mean(group.map((r) => r.retrieval.recall)),
        precision: mean(group.map((r) => r.retrieval.precision)),
        hitRate: mean(group.map((r) => r.retrieval.hitRate)),
        contextKeywordCoverage: mean(group.map((r) => r.retrieval.contextKeywordCoverage)),
        contextPrecision: mean(group.map((r) => r.retrieval.contextPrecision)),
        contextRecall: mean(group.map((r) => r.retrieval.contextRecall)),
        faithfulness: mean(group.map((r) => r.answer.faithfulness)),
        factualCorrectness: mean(group.map((r) => r.answer.factualCorrectness)),
        answerRelevance: mean(group.map((r) => r.answer.answerRelevance)),
        judgeScore: mean(group.map((r) => r.answer.judgeScore)),
        answerKeywordCoverage: mean(group.map((r) => r.answer.answerKeywordCoverage)),
        referenceSimilarity: mean(group.map((r) => r.answer.referenceSimilarity)),
        avgInputTokens: mean(group.map((r) => r.usage.inputTokens)),
        avgOutputTokens: mean(group.map((r) => r.usage.outputTokens)),
        avgCostUsd: mean(group.map((r) => r.usage.costUsd)),
        avgLatencyMs: mean(group.map((r) => r.latency.totalMs)),
      }))
      .sort((a, b) => b.count - a.count);
  }
}

function composite(
  retrieval: RetrievalMetricAverages,
  answer: AnswerMetricAverages,
  total: number,
  failures: number,
): number {
  const raw =
    retrieval.ndcg * COMPOSITE_WEIGHTS.ndcg +
    retrieval.recall * COMPOSITE_WEIGHTS.recall +
    retrieval.contextPrecision * COMPOSITE_WEIGHTS.contextPrecision +
    answer.faithfulness * COMPOSITE_WEIGHTS.faithfulness +
    answer.factualCorrectness * COMPOSITE_WEIGHTS.factualCorrectness +
    answer.answerRelevance * COMPOSITE_WEIGHTS.answerRelevance;

  // Questions that errored count as zero against the full question set.
  const successRate = total > 0 ? (total - failures) / total : 0;
  return raw * successRate;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Mean each numeric field of a projected record. */
function meanOf<T extends Record<string, number>>(
  results: QuestionResult[],
  project: (r: QuestionResult) => T,
): T {
  if (results.length === 0) {
    // Preserve the key set even with no data, so the frontend never sees
    // undefined where it expects a number.
    const shape = project({
      retrieval: {
        reciprocalRank: 0, ndcg: 0, recall: 0, precision: 0, hitRate: 0,
        contextKeywordCoverage: 0, contextPrecision: 0, contextRecall: 0,
        relevantRetrieved: 0, relevantTotal: 0,
      },
      answer: {
        faithfulness: 0, factualCorrectness: 0, answerRelevance: 0, judgeScore: 0,
        answerKeywordCoverage: 0, referenceSimilarity: 0, verdict: 'fail', judgeReasoning: '',
      },
    } as unknown as QuestionResult);
    return shape;
  }

  const projected = results.map(project);
  const keys = Object.keys(projected[0]) as Array<keyof T>;
  const out = {} as T;
  for (const key of keys) {
    out[key] = mean(projected.map((p) => p[key])) as T[keyof T];
  }
  return out;
}

export function aggregate(values: number[]): MetricAggregate {
  if (values.length === 0) {
    return { mean: 0, median: 0, p95: 0, min: 0, max: 0, stdDev: 0, count: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const avg = mean(values);
  const variance = mean(values.map((v) => (v - avg) ** 2));

  return {
    mean: avg,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev: Math.sqrt(variance),
    count: values.length,
  };
}

/** Linear-interpolated percentile over an already-sorted array. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
