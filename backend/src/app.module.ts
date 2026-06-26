import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfig } from './config/app-config';
import { RateLimitService } from './common/rate-limit.service';

import { ChunkingService } from './ingestion/chunking.service';
import { DocumentParserService } from './ingestion/document-parser.service';

import { OpenAiService } from './llm/openai.service';
import { AnswerLlmService } from './llm/answer-llm.service';
import { JudgeLlmService } from './llm/judge-llm.service';

import { VectorStoreModule } from './vector-store/vector-store.module';
import { PgVectorService } from './vector-store/pgvector.service';

import { QueryTransformService } from './rag/query-transform.service';
import { RerankerService } from './rag/reranker.service';
import { RagStrategyFactory } from './rag/rag-strategy.factory';
import { BaselineRagService } from './rag/baseline/baseline-rag.service';
import { AdvancedRagService } from './rag/advanced/advanced-rag.service';
import { AdvancedProRagService } from './rag/advanced-pro/advanced-pro-rag.service';
import { ContextualizerService } from './rag/advanced-pro/contextualizer.service';
import { GraphBuilderService } from './rag/graph/graph-builder.service';
import { GraphRagService } from './rag/graph/graph-rag.service';

import { DefaultCorpusService } from './datasets/default-corpus.service';
import { DatasetGeneratorService } from './datasets/dataset-generator.service';

import { EvaluationService } from './evaluation/evaluation.service';
import { ResultAggregatorService } from './evaluation/result-aggregator.service';

import { ExperimentStore } from './experiments/experiment.store';
import { ExperimentService } from './experiments/experiment.service';
import { ExperimentController } from './experiments/experiment.controller';
import { HealthController } from './common/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    VectorStoreModule,
  ],
  controllers: [ExperimentController, HealthController],
  providers: [
    AppConfig,
    RateLimitService,

    ChunkingService,
    DocumentParserService,

    OpenAiService,
    AnswerLlmService,
    JudgeLlmService,

    QueryTransformService,
    RerankerService,
    ContextualizerService,
    GraphBuilderService,

    BaselineRagService,
    AdvancedRagService,
    AdvancedProRagService,
    GraphRagService,
    RagStrategyFactory,

    DefaultCorpusService,
    DatasetGeneratorService,

    ResultAggregatorService,
    EvaluationService,

    ExperimentStore,
    ExperimentService,
  ],
})
export class AppModule {
  // PgVectorService comes from VectorStoreModule, which exports it so the
  // evaluation and experiment services can read the pre-embedded corpus.
  constructor(private readonly _pgvector: PgVectorService) {}
}
