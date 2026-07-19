import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import {
  DEFAULT_QUESTION_COUNT,
  MAX_CONCURRENT_RUNS,
  MAX_GENERATED_QUESTIONS,
  MAX_QUESTIONS,
} from '../config/limits';
import { EvaluationItem, QuestionType, StrategyId } from '../common/types';
import { ChunkingService } from '../ingestion/chunking.service';
import { DocumentParserService } from '../ingestion/document-parser.service';
import { UsageTracker } from '../llm/usage-tracker';
import { DatasetGeneratorService } from '../datasets/dataset-generator.service';
import { DefaultCorpusService } from '../datasets/default-corpus.service';
import { parseDataset } from '../datasets/dataset-parser';
import { EvaluationService } from '../evaluation/evaluation.service';
import { PgVectorService } from '../vector-store/pgvector.service';
import { CreateExperimentDto } from './experiment.dto';
import { ExperimentStore } from './experiment.store';
import { DatasetInfo, DatasetSource, ExperimentContext, KnowledgeBaseInfo } from './experiment.types';

@Injectable()
export class ExperimentService {
  private readonly logger = new Logger(ExperimentService.name);
  private activeRuns = 0;

  constructor(
    private readonly store: ExperimentStore,
    private readonly defaultCorpus: DefaultCorpusService,
    private readonly parser: DocumentParserService,
    private readonly chunking: ChunkingService,
    private readonly generator: DatasetGeneratorService,
    private readonly evaluation: EvaluationService,
    private readonly pgvector: PgVectorService,
  ) {}

  async create(dto: CreateExperimentDto): Promise<ExperimentContext> {
    const experiment = this.store.create();
    experiment.strategies = [...new Set(dto.strategies)];

    if (dto.useDefaultKnowledgeBase) {
      await this.applyDefaultKnowledgeBase(experiment);
    }

    // applyDefaultDataset enforces the pairing, so an unpaired request fails here
    // with the same message the standalone endpoint gives.
    if (dto.useDefaultDataset) {
      this.applyDefaultDataset(experiment, dto.questionCount ?? DEFAULT_QUESTION_COUNT);
    }

    return experiment;
  }

  /**
   * Replaces the strategy selection.
   *
   * Setup is a live editing session, not a wizard whose first step is final —
   * the experiment is created on the first action the user takes, so anything
   * they change afterwards has to be able to reach the server.
   */
  setStrategies(experiment: ExperimentContext, strategies: StrategyId[]): StrategyId[] {
    if (experiment.status === 'evaluating' || experiment.status === 'indexing') {
      throw new BadRequestException(
        'This evaluation is already running, so its strategies cannot be changed. ' +
          'Wait for it to finish, or cancel it first.',
      );
    }

    experiment.strategies = [...new Set(strategies)];

    // Results are keyed by strategy; anything from a previous selection would
    // otherwise linger and be reported alongside the new run.
    experiment.results.clear();
    experiment.summaries.clear();

    return experiment.strategies;
  }

  // ── Knowledge base ────────────────────────────────────────────────────────

  async applyDefaultKnowledgeBase(experiment: ExperimentContext): Promise<void> {
    const corpus = this.defaultCorpus.getCorpus();
    const preEmbedded = await this.pgvector.isAvailable();

    experiment.documents = corpus.documents;
    experiment.knowledgeBase = {
      source: 'default',
      label: 'Assurio — insurance-tech demo corpus',
      documentCount: corpus.documents.length,
      totalChars: corpus.totalChars,
      originalChars: corpus.totalChars,
      trimmed: false,
      categories: corpus.categories,
      preEmbedded,
      notice: preEmbedded
        ? undefined
        : 'pgvector has not been seeded, so this corpus will be embedded on demand. ' +
          'Run "npm run seed" to make default runs faster and cheaper.',
    };
    experiment.status = 'ready';

    this.dropMismatchedDataset(experiment);
  }

  async setUploadedKnowledgeBase(
    experiment: ExperimentContext,
    file: { originalname: string; mimetype: string; buffer: Buffer },
  ): Promise<KnowledgeBaseInfo> {
    const parsed = await this.parser.parseUpload(file);

    experiment.documents = parsed.documents;
    experiment.knowledgeBase = {
      source: 'upload',
      label: file.originalname,
      documentCount: parsed.documents.length,
      totalChars: parsed.keptChars,
      originalChars: parsed.originalChars,
      trimmed: parsed.trimmed,
      notice: parsed.notice,
      categories: [{ name: 'uploaded', documents: parsed.documents.length }],
      preEmbedded: false,
    };
    experiment.status = 'ready';

    this.dropMismatchedDataset(experiment);

    return experiment.knowledgeBase;
  }

  /**
   * Changing the corpus can invalidate the questions already loaded against it,
   * so drop them rather than leaving a pairing the run endpoint would reject.
   */
  private dropMismatchedDataset(experiment: ExperimentContext): void {
    const kbIsDefault = experiment.knowledgeBase?.source === 'default';
    const datasetIsDefault = experiment.datasetInfo?.source === 'default';
    if (!experiment.datasetInfo || kbIsDefault === datasetIsDefault) return;

    experiment.dataset = [];
    experiment.datasetInfo = null;
  }

  /**
   * Pasted plain text. Routed through the same upload path so the trim rule and
   * the minimum-length rule apply identically however the text arrived.
   */
  async setTextKnowledgeBase(
    experiment: ExperimentContext,
    text: string,
    title = 'pasted-text',
  ): Promise<KnowledgeBaseInfo> {
    return this.setUploadedKnowledgeBase(experiment, {
      originalname: title.endsWith('.txt') ? title : `${title}.txt`,
      mimetype: 'text/plain',
      buffer: Buffer.from(text, 'utf8'),
    });
  }

  // ── Dataset ───────────────────────────────────────────────────────────────

  /**
   * The demo corpus and the demo question set are one pairing, enforced in both
   * directions.
   *
   * The 150 shipped questions are hand-written against the Assurio documents and
   * carry reference answers keyed to their contents, so pointing them at someone
   * else's upload measures nothing. The reverse holds too: swapping in different
   * questions over the demo corpus quietly throws away the only ground truth the
   * app has, and the retrieval numbers stop being comparable to every other run.
   */
  private assertDefaultPairing(experiment: ExperimentContext, incoming: DatasetSource): void {
    const kb = experiment.knowledgeBase?.source ?? null;

    if (incoming === 'default' && kb !== 'default') {
      throw new BadRequestException(
        'The demo question set is written against the demo knowledge base, with reference ' +
          'answers taken from those documents. Select the demo knowledge base to use it, or ' +
          'supply your own questions for your own documents.',
      );
    }

    if (incoming !== 'default' && kb === 'default') {
      throw new BadRequestException(
        'The demo knowledge base runs with its own 150-question ground-truth set. ' +
          'Switch to an uploaded or pasted knowledge base to bring your own questions.',
      );
    }
  }

  applyDefaultDataset(experiment: ExperimentContext, requestedCount: number): DatasetInfo {
    this.assertDefaultPairing(experiment, 'default');

    const count = Math.min(Math.max(1, requestedCount), MAX_QUESTIONS);
    const items = this.defaultCorpus.sampleQuestions(count);

    experiment.dataset = items;
    experiment.datasetInfo = {
      source: 'default',
      questionCount: items.length,
      byType: countByType(items),
      // Sampling fewer than all 150 is the user's own choice, not a cap, so it
      // is not "truncated" — only a request above MAX_QUESTIONS is.
      truncated: requestedCount > MAX_QUESTIONS,
      available: this.defaultCorpus.getQaSet().items.length,
      skipped: [],
    };

    return experiment.datasetInfo;
  }

  setDataset(experiment: ExperimentContext, content: string, source: 'upload' | 'paste'): DatasetInfo {
    this.assertDefaultPairing(experiment, source);

    const parsed = parseDataset(content);

    experiment.dataset = parsed.items;
    experiment.datasetInfo = {
      source,
      questionCount: parsed.items.length,
      byType: countByType(parsed.items),
      truncated: parsed.truncated,
      skipped: parsed.skipped,
    };

    return experiment.datasetInfo;
  }

  async generateDataset(experiment: ExperimentContext, requested: number): Promise<DatasetInfo> {
    this.assertDefaultPairing(experiment, 'generated');

    if (experiment.documents.length === 0) {
      throw new BadRequestException(
        'Add a knowledge base before generating questions — the generator writes questions from it.',
      );
    }

    const count = Math.min(Math.max(1, requested), MAX_GENERATED_QUESTIONS);

    // Generate from structural chunks: they respect section boundaries, so a
    // source passage is far more likely to hold one self-contained fact.
    const chunks = this.chunking.chunkAll(experiment.documents, 'structural');
    const tracker = new UsageTracker();

    const items = await this.generator.generate(chunks, count, tracker, (done, total) =>
      this.store.emit(experiment, {
        type: 'status',
        status: experiment.status,
        message: `Generating questions ${done}/${total}`,
        at: Date.now(),
      }),
    );

    if (items.length === 0) {
      throw new BadRequestException(
        'The generator could not produce usable questions from this knowledge base. ' +
          'It may be too short or lack self-contained factual passages.',
      );
    }

    experiment.dataset = items;
    experiment.datasetInfo = {
      source: 'generated',
      questionCount: items.length,
      byType: countByType(items),
      truncated: items.length < count,
      skipped: [],
    };

    return experiment.datasetInfo;
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  /**
   * Everything that makes a run impossible, checked without side effects.
   *
   * Split out from startRun so the controller can reject a misconfigured request
   * *before* it charges the visitor's daily run budget — a run that never starts
   * should never cost a run.
   */
  assertRunnable(experiment: ExperimentContext): void {
    if (experiment.documents.length === 0) {
      throw new BadRequestException('Add a knowledge base before running the evaluation.');
    }
    if (experiment.dataset.length === 0) {
      throw new BadRequestException('Add an evaluation dataset before running the evaluation.');
    }
    if (experiment.strategies.length === 0) {
      throw new BadRequestException('Select at least one RAG strategy.');
    }
    if (experiment.status === 'evaluating' || experiment.status === 'indexing') {
      throw new BadRequestException(
        'This evaluation is already running. Wait for it to finish, or cancel it and start again.',
      );
    }
    if (this.activeRuns >= MAX_CONCURRENT_RUNS) {
      throw new BadRequestException(
        `The server is already running ${MAX_CONCURRENT_RUNS} evaluations. ` +
          'Wait for one to finish and try again — this keeps the demo responsive for everyone.',
      );
    }
  }

  startRun(experiment: ExperimentContext): void {
    this.assertRunnable(experiment);

    experiment.results.clear();
    experiment.summaries.clear();
    experiment.cancelled = false;
    experiment.status = 'evaluating';
    this.activeRuns++;

    this.logger.log(
      `Starting run ${experiment.id}: ${experiment.strategies.join(', ')} over ` +
        `${experiment.dataset.length} questions`,
    );

    // Fire and forget: the client follows progress over SSE.
    void this.evaluation
      .run(experiment)
      .catch((err) => this.logger.error(`Run ${experiment.id} threw: ${(err as Error).message}`))
      .finally(() => {
        this.activeRuns--;
      });
  }

  cancelRun(experiment: ExperimentContext): void {
    experiment.cancelled = true;
    this.logger.log(`Run ${experiment.id} cancellation requested`);
  }

  get activeRunCount(): number {
    return this.activeRuns;
  }
}

function countByType(items: EvaluationItem[]): Array<{ questionType: string; count: number }> {
  const counts = new Map<QuestionType, number>();
  for (const item of items) counts.set(item.questionType, (counts.get(item.questionType) ?? 0) + 1);
  return [...counts.entries()]
    .map(([questionType, count]) => ({ questionType, count }))
    .sort((a, b) => b.count - a.count);
}
