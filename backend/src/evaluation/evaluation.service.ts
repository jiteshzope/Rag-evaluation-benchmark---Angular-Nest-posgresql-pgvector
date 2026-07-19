import { Injectable, Logger } from '@nestjs/common';

import {
  EvaluationItem,
  IndexingStats,
  QuestionResult,
  StrategyId,
  StrategySummary,
} from '../common/types';
import { MAX_CONTEXT_CHUNKS, QUESTION_CONCURRENCY } from '../config/limits';
import { AnswerLlmService } from '../llm/answer-llm.service';
import { JudgeLlmService } from '../llm/judge-llm.service';
import { OpenAiService } from '../llm/openai.service';
import { UsageTracker, emptyUsage } from '../llm/usage-tracker';
import { cosineSimilarity, mapWithConcurrency } from '../ingestion/text-utils';
import { RelevanceLabeler } from '../metrics/relevance-labels';
import { evaluateRetrieval, keywordCoverage, keywordHits } from '../metrics/retrieval.metrics';
import { RagStrategyFactory } from '../rag/rag-strategy.factory';
import { StrategyContext } from '../rag/rag-strategy.interface';
import { PgVectorService } from '../vector-store/pgvector.service';
import { ExperimentStore } from '../experiments/experiment.store';
import { ExperimentContext } from '../experiments/experiment.types';
import { ResultAggregatorService } from './result-aggregator.service';

/**
 * The evaluation orchestrator.
 *
 * For each selected strategy:
 *   ingest the corpus -> label relevance -> for each question:
 *     retrieve -> score retrieval -> answer (no reference) -> judge -> record
 *
 * Two ordering decisions matter:
 *
 * 1. Relevance labels are computed per strategy but from the *same* dataset, so
 *    every strategy is measured against ground truth derived identically.
 * 2. The answering LLM never sees the reference answer. Only the judge does.
 *    Otherwise the benchmark would measure the judge's leniency, not retrieval.
 *
 * Results are streamed as they are produced. Nothing is cached: a run always
 * executes, so the numbers on screen are always from a real execution.
 */
@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name);

  constructor(
    private readonly strategyFactory: RagStrategyFactory,
    private readonly answerLlm: AnswerLlmService,
    private readonly judgeLlm: JudgeLlmService,
    private readonly openai: OpenAiService,
    private readonly aggregator: ResultAggregatorService,
    private readonly pgvector: PgVectorService,
    private readonly store: ExperimentStore,
  ) {}

  async run(experiment: ExperimentContext): Promise<void> {
    experiment.status = 'evaluating';
    experiment.startedAt = Date.now();

    const totalQuestions = experiment.dataset.length * experiment.strategies.length;
    let overallCompleted = 0;

    this.store.emit(experiment, {
      type: 'status',
      status: 'evaluating',
      message: `Running ${experiment.strategies.length} strateg${
        experiment.strategies.length === 1 ? 'y' : 'ies'
      } over ${experiment.dataset.length} questions`,
      at: Date.now(),
    });

    try {
      for (const strategyId of experiment.strategies) {
        if (experiment.cancelled) break;

        const summary = await this.runStrategy(experiment, strategyId, {
          totalQuestions,
          getOverallCompleted: () => overallCompleted,
          onQuestionDone: () => ++overallCompleted,
        });

        experiment.summaries.set(strategyId, summary);
        this.store.emit(experiment, {
          type: 'strategy-complete',
          strategy: strategyId,
          summary,
          at: Date.now(),
        });
      }

      experiment.status = experiment.cancelled ? 'cancelled' : 'complete';
      experiment.finishedAt = Date.now();

      const summaries = [...experiment.summaries.values()];
      this.store.emit(experiment, {
        type: 'complete',
        summaries,
        totalCostUsd: summaries.reduce((sum, s) => sum + s.usage.costUsd, 0),
        durationMs: experiment.finishedAt - (experiment.startedAt ?? experiment.finishedAt),
        at: Date.now(),
      });
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Experiment ${experiment.id} failed: ${message}`, (err as Error).stack);
      experiment.status = 'failed';
      experiment.error = message;
      experiment.finishedAt = Date.now();
      this.store.emit(experiment, { type: 'error', message, at: Date.now() });
    } finally {
      experiment.events.complete();
    }
  }

  private async runStrategy(
    experiment: ExperimentContext,
    strategyId: StrategyId,
    progress: {
      totalQuestions: number;
      getOverallCompleted: () => number;
      onQuestionDone: () => number;
    },
  ): Promise<StrategySummary> {
    const strategy = this.strategyFactory.get(strategyId);

    // ── Ingest ──────────────────────────────────────────────────────────────
    this.store.emit(experiment, {
      type: 'indexing',
      strategy: strategyId,
      message: `Indexing for ${strategy.label}`,
      at: Date.now(),
    });

    const ingestTracker = new UsageTracker();
    const cached = await this.loadCachedIndex(experiment, strategyId);

    const context: StrategyContext = await strategy.ingest({
      documents: experiment.documents,
      tracker: ingestTracker,
      cachedEmbeddings: cached.embeddings,
      cachedContexts: cached.contexts,
      cachedGraph: cached.graph,
      onProgress: (message) =>
        this.store.emit(experiment, {
          type: 'indexing',
          strategy: strategyId,
          message,
          at: Date.now(),
        }),
    });

    this.store.emit(experiment, {
      type: 'indexed',
      strategy: strategyId,
      chunkCount: context.stats.chunkCount,
      indexingMs: context.stats.indexingMs,
      fromCache: context.stats.fromCache,
      graph: context.stats.graph,
      at: Date.now(),
    });

    // ── Ground truth ────────────────────────────────────────────────────────
    const labeler = new RelevanceLabeler(context.chunks);
    const labels = labeler.labelAll(experiment.dataset);

    // ── Per-question evaluation ─────────────────────────────────────────────
    const results = await mapWithConcurrency(
      experiment.dataset,
      QUESTION_CONCURRENCY,
      async (item) => {
        if (experiment.cancelled) return this.errorResult(item, strategyId, 'Run cancelled');

        const result = await this.evaluateQuestion(item, strategyId, context, labels.get(item.id));
        const completed = progress.onQuestionDone();

        this.store.emit(experiment, { type: 'question', strategy: strategyId, result, at: Date.now() });
        this.store.emit(experiment, {
          type: 'progress',
          strategy: strategyId,
          completed: (experiment.results.get(strategyId)?.length ?? 0) + 1,
          total: experiment.dataset.length,
          overallCompleted: completed,
          overallTotal: progress.totalQuestions,
          currentQuestion: item.question,
          at: Date.now(),
        });

        const list = experiment.results.get(strategyId) ?? [];
        list.push(result);
        experiment.results.set(strategyId, list);

        return result;
      },
    );

    // Keep dataset order regardless of completion order.
    experiment.results.set(strategyId, results);

    // Indexing cost belongs to the strategy, not to any single question.
    const indexing: IndexingStats = context.stats;
    const summary = this.aggregator.summarize(strategyId, strategy.label, results, indexing);
    summary.usage = addUsage(summary.usage, ingestTracker.totals());

    return summary;
  }

  private async evaluateQuestion(
    item: EvaluationItem,
    strategyId: StrategyId,
    context: StrategyContext,
    labels: { relevance: Record<string, number> } | undefined,
  ): Promise<QuestionResult> {
    const tracker = new UsageTracker();
    const startedAt = Date.now();
    const relevance = labels?.relevance ?? {};

    try {
      const strategy = this.strategyFactory.get(strategyId);

      // 1. Retrieve.
      const retrievalStart = Date.now();
      const retrieval = await strategy.retrieve({
        question: item.question,
        topK: MAX_CONTEXT_CHUNKS,
        tracker,
        context,
      });
      const retrievalMs = Date.now() - retrievalStart;

      // 2. Score retrieval against ground truth.
      const retrievalMetrics = evaluateRetrieval(
        retrieval.chunks,
        relevance,
        item.expectedKeywords,
        MAX_CONTEXT_CHUNKS,
      );

      // 3. Answer — question + context only, never the reference answer.
      const answer = await this.answerLlm.generate({
        question: item.question,
        chunks: retrieval.chunks,
        tracker,
      });

      // 4. Judge — sees everything.
      const verdict = await this.judgeLlm.evaluate({
        question: item.question,
        referenceAnswer: item.referenceAnswer,
        generatedAnswer: answer.answer,
        chunks: retrieval.chunks,
        tracker,
      });

      // 5. Reference similarity, a cheap non-LLM cross-check on the judge.
      const referenceSimilarity = await this.referenceSimilarity(
        answer.answer,
        item.referenceAnswer,
        tracker,
      );

      return {
        itemId: item.id,
        strategy: strategyId,
        question: item.question,
        questionType: item.questionType,
        referenceAnswer: item.referenceAnswer,
        generatedAnswer: answer.answer,
        expectedKeywords: item.expectedKeywords,
        keywordHits: keywordHits(answer.answer, item.expectedKeywords),
        retrieved: retrieval.chunks,
        relevanceLabels: relevance,
        retrieval: retrievalMetrics,
        answer: {
          faithfulness: verdict.faithfulness,
          factualCorrectness: verdict.factualCorrectness,
          answerRelevance: verdict.answerRelevance,
          judgeScore: verdict.judgeScore,
          answerKeywordCoverage: keywordCoverage(answer.answer, item.expectedKeywords),
          referenceSimilarity,
          verdict: verdict.verdict,
          judgeReasoning: verdict.reasoning,
        },
        usage: tracker.totals(),
        latency: {
          retrievalMs,
          answerMs: answer.latencyMs,
          judgeMs: verdict.latencyMs,
          totalMs: Date.now() - startedAt,
        },
        trace: retrieval.trace,
      };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Question ${item.id} failed on ${strategyId}: ${message}`);
      return this.errorResult(item, strategyId, message, tracker, Date.now() - startedAt);
    }
  }

  /** Cosine similarity between the generated and reference answer embeddings. */
  private async referenceSimilarity(
    generated: string,
    reference: string,
    tracker: UsageTracker,
  ): Promise<number> {
    if (!generated.trim() || !reference.trim()) return 0;
    try {
      const [a, b] = await this.openai.embed([generated, reference], tracker);
      return Math.max(0, cosineSimilarity(a, b));
    } catch {
      // A failed similarity check must not fail the question.
      return 0;
    }
  }

  /**
   * Pre-embedded vectors for the default knowledge base. Returns empty when the
   * corpus is an upload or pgvector has not been seeded, in which case the
   * strategy embeds normally.
   */
  private async loadCachedIndex(
    experiment: ExperimentContext,
    strategyId: StrategyId,
  ): Promise<{
    embeddings?: Map<string, Float32Array>;
    contexts?: Map<string, string>;
    graph?: unknown;
  }> {
    if (experiment.knowledgeBase?.source !== 'default') return {};
    if (!(await this.pgvector.isAvailable())) return {};

    try {
      const stored = await this.pgvector.loadChunks(strategyId);
      if (stored.length === 0) return {};

      const embeddings = new Map<string, Float32Array>();
      const contexts = new Map<string, string>();
      for (const item of stored) {
        embeddings.set(item.chunk.id, item.embedding);
        if (item.contextHeader) contexts.set(item.chunk.id, item.contextHeader);
      }

      const graph =
        strategyId === 'graphrag' ? ((await this.pgvector.loadGraph()) ?? undefined) : undefined;

      this.logger.log(
        `Loaded ${embeddings.size} pre-embedded vectors for ${strategyId} from pgvector`,
      );
      return { embeddings, contexts: contexts.size > 0 ? contexts : undefined, graph };
    } catch (err) {
      this.logger.warn(`Could not load cached vectors for ${strategyId}: ${(err as Error).message}`);
      return {};
    }
  }

  private errorResult(
    item: EvaluationItem,
    strategy: StrategyId,
    message: string,
    tracker?: UsageTracker,
    totalMs = 0,
  ): QuestionResult {
    return {
      itemId: item.id,
      strategy,
      question: item.question,
      questionType: item.questionType,
      referenceAnswer: item.referenceAnswer,
      generatedAnswer: '',
      expectedKeywords: item.expectedKeywords,
      keywordHits: {},
      retrieved: [],
      relevanceLabels: {},
      retrieval: {
        reciprocalRank: 0, ndcg: 0, recall: 0, precision: 0, hitRate: 0,
        contextKeywordCoverage: 0, contextPrecision: 0, contextRecall: 0,
        relevantRetrieved: 0, relevantTotal: 0,
      },
      answer: {
        faithfulness: 0, factualCorrectness: 0, answerRelevance: 0, judgeScore: 0,
        answerKeywordCoverage: 0, referenceSimilarity: 0,
        verdict: 'fail', judgeReasoning: message,
      },
      usage: tracker?.totals() ?? emptyUsage(),
      latency: { retrievalMs: 0, answerMs: 0, judgeMs: 0, totalMs },
      trace: { strategy, steps: [], queries: [item.question], latencyMs: 0 },
      error: message,
    };
  }
}

function addUsage(
  a: ReturnType<UsageTracker['totals']>,
  b: ReturnType<UsageTracker['totals']>,
): ReturnType<UsageTracker['totals']> {
  const out = { ...a, costByStage: { ...a.costByStage }, tokensByStage: { ...a.tokensByStage } };
  out.inputTokens += b.inputTokens;
  out.cachedInputTokens += b.cachedInputTokens;
  out.outputTokens += b.outputTokens;
  out.totalTokens += b.totalTokens;
  out.embeddingTokens += b.embeddingTokens;
  out.costUsd += b.costUsd;
  for (const stage of Object.keys(b.costByStage) as Array<keyof typeof b.costByStage>) {
    out.costByStage[stage] += b.costByStage[stage];
    out.tokensByStage[stage] += b.tokensByStage[stage];
  }
  return out;
}
