import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Sse,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { Observable, Subject, concat, finalize, from, interval, map, merge, takeUntil } from 'rxjs';

import { ACCEPTED_EXTENSIONS, MAX_FILE_SIZE_BYTES, PUBLIC_LIMITS } from '../config/limits';
import { RateLimitService } from '../common/rate-limit.service';
import { RagStrategyFactory } from '../rag/rag-strategy.factory';
import { DefaultCorpusService } from '../datasets/default-corpus.service';
import { PgVectorService } from '../vector-store/pgvector.service';
import {
  CreateExperimentDto,
  GenerateDatasetDto,
  SetDatasetDto,
  SetKnowledgeBaseTextDto,
  UpdateStrategiesDto,
} from './experiment.dto';
import { ExperimentService } from './experiment.service';
import { ExperimentStore } from './experiment.store';
import { EvaluationEvent, ExperimentContext } from './experiment.types';

/** How often to send a keep-alive tick on an otherwise silent SSE stream. */
const SSE_HEARTBEAT_MS = 15_000;

@Controller('api')
export class ExperimentController {
  constructor(
    private readonly experiments: ExperimentService,
    private readonly store: ExperimentStore,
    private readonly strategies: RagStrategyFactory,
    private readonly defaultCorpus: DefaultCorpusService,
    private readonly pgvector: PgVectorService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ── Metadata ──────────────────────────────────────────────────────────────

  /** Everything the setup screen needs to render itself. */
  @Get('meta')
  async meta(@Req() req: Request) {
    const [pgAvailable, manifest, coverage] = await Promise.all([
      this.pgvector.isAvailable(),
      this.pgvector.getManifest(),
      this.pgvector.getCoverage(),
    ]);

    let defaultKb = null;
    let defaultQa = null;
    try {
      const corpus = this.defaultCorpus.getCorpus();
      const qa = this.defaultCorpus.getQaSet();
      defaultKb = {
        label: 'Assurio — insurance-tech demo corpus',
        documentCount: corpus.documents.length,
        totalChars: corpus.totalChars,
        categories: corpus.categories,
        preEmbedded: pgAvailable,
        fingerprint: corpus.fingerprint,
        stale: Boolean(manifest && manifest.corpusFingerprint !== corpus.fingerprint),
      };
      defaultQa = { questionCount: qa.items.length, byType: qa.byType };
    } catch {
      // The app still runs upload-only if the demo corpus is missing.
    }

    return {
      strategies: this.strategies.describeAll(),
      limits: PUBLIC_LIMITS,
      quotas: this.rateLimit.allQuotas(req),
      defaultKnowledgeBase: defaultKb,
      defaultDataset: defaultQa,
      pgvector: { available: pgAvailable, manifest, coverage },
      activeRuns: this.experiments.activeRunCount,
    };
  }

  @Get('quotas')
  quotas(@Req() req: Request) {
    return { quotas: this.rateLimit.allQuotas(req) };
  }

  // ── Experiment lifecycle ──────────────────────────────────────────────────

  @Post('experiments')
  async create(@Body() dto: CreateExperimentDto) {
    const experiment = await this.experiments.create(dto);
    return serialize(experiment);
  }

  @Get('experiments/:id')
  get(@Param('id') id: string) {
    return serialize(this.store.get(id));
  }

  /** Re-selects the strategies to benchmark, before the run starts. */
  @Patch('experiments/:id/strategies')
  setStrategies(@Param('id') id: string, @Body() dto: UpdateStrategiesDto) {
    const experiment = this.store.get(id);
    return { strategies: this.experiments.setStrategies(experiment, dto.strategies) };
  }

  @Delete('experiments/:id')
  remove(@Param('id') id: string) {
    this.store.delete(id);
    return { deleted: true };
  }

  // ── Knowledge base ────────────────────────────────────────────────────────

  @Post('experiments/:id/knowledge-base')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
    }),
  )
  async uploadKnowledgeBase(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    if (!file) {
      throw new BadRequestException('No file received. Attach a PDF, DOCX, TXT or MD file.');
    }

    const ext = `.${file.originalname.split('.').pop()?.toLowerCase() ?? ''}`;
    if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestException(
        `"${file.originalname}" is not a supported file type. ` +
          `Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}.`,
      );
    }

    const experiment = this.store.get(id);
    const info = await this.rateLimit.spendOn(req, 'upload', () =>
      this.experiments.setUploadedKnowledgeBase(experiment, file),
    );
    return { knowledgeBase: info, quotas: this.rateLimit.allQuotas(req) };
  }

  @Post('experiments/:id/knowledge-base/text')
  async setKnowledgeBaseText(
    @Param('id') id: string,
    @Body() dto: SetKnowledgeBaseTextDto,
    @Req() req: Request,
  ) {
    const experiment = this.store.get(id);
    const info = await this.rateLimit.spendOn(req, 'upload', () =>
      this.experiments.setTextKnowledgeBase(experiment, dto.text, dto.title),
    );
    return { knowledgeBase: info, quotas: this.rateLimit.allQuotas(req) };
  }

  @Post('experiments/:id/knowledge-base/default')
  async useDefaultKnowledgeBase(@Param('id') id: string) {
    const experiment = this.store.get(id);
    await this.experiments.applyDefaultKnowledgeBase(experiment);
    return { knowledgeBase: experiment.knowledgeBase };
  }

  // ── Dataset ───────────────────────────────────────────────────────────────

  @Post('experiments/:id/dataset')
  setDataset(@Param('id') id: string, @Body() dto: SetDatasetDto) {
    const experiment = this.store.get(id);
    return { dataset: this.experiments.setDataset(experiment, dto.content, 'paste') };
  }

  @Post('experiments/:id/dataset/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 } }))
  uploadDataset(@Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('No dataset file received.');
    const experiment = this.store.get(id);
    return {
      dataset: this.experiments.setDataset(experiment, file.buffer.toString('utf8'), 'upload'),
    };
  }

  @Post('experiments/:id/dataset/default')
  useDefaultDataset(@Param('id') id: string, @Query('count') count?: string) {
    const experiment = this.store.get(id);
    const requested = count ? Number(count) : PUBLIC_LIMITS.defaultQuestionCount;
    if (!Number.isFinite(requested)) throw new BadRequestException('"count" must be a number.');
    return { dataset: this.experiments.applyDefaultDataset(experiment, requested) };
  }

  @Post('experiments/:id/dataset/generate')
  async generateDataset(
    @Param('id') id: string,
    @Body() dto: GenerateDatasetDto,
    @Req() req: Request,
  ) {
    const experiment = this.store.get(id);
    const dataset = await this.rateLimit.spendOn(req, 'generate', () =>
      this.experiments.generateDataset(experiment, dto.count ?? PUBLIC_LIMITS.defaultQuestionCount),
    );
    return { dataset, items: experiment.dataset, quotas: this.rateLimit.allQuotas(req) };
  }

  /** The generated/loaded questions themselves, for the review table. */
  @Get('experiments/:id/dataset')
  getDataset(@Param('id') id: string) {
    const experiment = this.store.get(id);
    return { dataset: experiment.datasetInfo, items: experiment.dataset };
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  @Post('experiments/:id/run')
  async run(@Param('id') id: string, @Req() req: Request) {
    const experiment = this.store.get(id);

    // Preconditions first: a run rejected for a missing corpus or dataset costs
    // the server nothing, so it must not cost the visitor one of their runs.
    // spendOn then covers whatever startRun itself still refuses (a concurrency
    // ceiling hit between the check and the start).
    this.experiments.assertRunnable(experiment);
    await this.rateLimit.spendOn(req, 'run', () => this.experiments.startRun(experiment));
    return {
      status: experiment.status,
      strategies: experiment.strategies,
      questionCount: experiment.dataset.length,
      quotas: this.rateLimit.allQuotas(req),
    };
  }

  @Post('experiments/:id/cancel')
  cancel(@Param('id') id: string) {
    const experiment = this.store.get(id);
    this.experiments.cancelRun(experiment);
    return { cancelled: true };
  }

  /**
   * Live progress stream.
   *
   * Buffered events are replayed first so a client that connects a moment after
   * POST /run still sees the indexing phase, then the live subject takes over.
   */
  @Sse('experiments/:id/events')
  // Tells nginx-style proxies not to buffer the response. Without it a proxy can
  // hold events until its buffer fills, and a run that is progressing normally
  // looks frozen in the browser.
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache, no-transform')
  events(@Param('id') id: string): Observable<{ data: string }> {
    const experiment = this.store.get(id);
    const replay = from([...experiment.eventLog]);

    // Fires when the event stream ends — whether the run finished or the client
    // disconnected — so the heartbeat below stops with it rather than holding
    // the response open forever.
    const ended = new Subject<void>();

    const stream = concat(replay, experiment.events).pipe(
      map((event: EvaluationEvent) => ({ data: JSON.stringify(event) })),
      finalize(() => {
        ended.next();
        ended.complete();
      }),
    );

    /**
     * Keeps the connection alive through a gap in real events.
     *
     * Indexing an uploaded corpus for GraphRAG runs entity extraction over every
     * chunk and emits nothing between "Extracting entities" and "Graph has N
     * entities" — minutes of silence. A proxy in front of the API (Railway,
     * nginx, Cloudflare) drops an idle connection well before that, and the
     * browser would show a stalled run that is in fact progressing. A tick every
     * 15s keeps bytes flowing; the client ignores the event type.
     */
    const heartbeat = interval(SSE_HEARTBEAT_MS).pipe(
      map(() => ({ data: JSON.stringify({ type: 'ping', at: Date.now() }) })),
      takeUntil(ended),
    );

    return merge(stream, heartbeat);
  }

  // ── Results ───────────────────────────────────────────────────────────────

  @Get('experiments/:id/results')
  results(@Param('id') id: string) {
    const experiment = this.store.get(id);
    return {
      status: experiment.status,
      error: experiment.error,
      summaries: [...experiment.summaries.values()],
      durationMs:
        experiment.finishedAt && experiment.startedAt
          ? experiment.finishedAt - experiment.startedAt
          : undefined,
      totalCostUsd: [...experiment.summaries.values()].reduce((s, x) => s + x.usage.costUsd, 0),
    };
  }

  @Get('experiments/:id/results/questions')
  questionResults(@Param('id') id: string, @Query('strategy') strategy?: string) {
    const experiment = this.store.get(id);
    const all = [...experiment.results.entries()].flatMap(([strategyId, results]) =>
      strategy && strategy !== strategyId ? [] : results,
    );
    return { results: all };
  }

  @Get('experiments/:id/results/questions/:questionId')
  questionResult(@Param('id') id: string, @Param('questionId') questionId: string) {
    const experiment = this.store.get(id);
    const results = [...experiment.results.values()]
      .flat()
      .filter((r) => r.itemId === questionId);
    return { results };
  }
}

/** API projection of an experiment — never exposes the raw corpus or vectors. */
function serialize(experiment: ExperimentContext) {
  return {
    id: experiment.id,
    status: experiment.status,
    strategies: experiment.strategies,
    knowledgeBase: experiment.knowledgeBase,
    dataset: experiment.datasetInfo,
    createdAt: experiment.createdAt,
    error: experiment.error,
  };
}
