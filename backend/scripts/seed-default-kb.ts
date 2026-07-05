/**
 * Seeds pgvector with the pre-embedded default knowledge base.
 *
 * Run once (and again whenever the corpus changes):
 *
 *     npm run seed            # incremental — skips strategies already seeded
 *     npm run seed:reset      # wipe and rebuild everything
 *     npm run seed -- --only=graphrag
 *
 * What it does, per strategy:
 *   baseline      fixed chunks           -> embeddings
 *   advanced      structural chunks      -> embeddings
 *   advanced-pro  contextual chunks      -> LLM context headers -> embeddings
 *   graphrag      structural chunks      -> embeddings + entity/community graph
 *
 * Why this exists: embedding 76 documents four different ways, writing ~400 LLM
 * context headers and running entity extraction over the corpus on every
 * recruiter visit would be slow and wasteful. Doing it once here means a default
 * run at request time makes no ingestion API calls at all.
 *
 * Uploaded corpora never come near this table.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/app-config';
import { StrategyId } from '../src/common/types';
import { ChunkingService } from '../src/ingestion/chunking.service';
import { OpenAiService } from '../src/llm/openai.service';
import { UsageTracker } from '../src/llm/usage-tracker';
import { DefaultCorpusService } from '../src/datasets/default-corpus.service';
import { ContextualizerService } from '../src/rag/advanced-pro/contextualizer.service';
import { GraphBuilderService } from '../src/rag/graph/graph-builder.service';
import { RagStrategyFactory } from '../src/rag/rag-strategy.factory';
import { PgVectorService } from '../src/vector-store/pgvector.service';

const logger = new Logger('Seed');

interface Args {
  reset: boolean;
  only: StrategyId[] | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const only = argv
    .find((a) => a.startsWith('--only='))
    ?.split('=')[1]
    ?.split(',')
    .map((s) => s.trim()) as StrategyId[] | undefined;

  return { reset: argv.includes('--reset'), only: only && only.length > 0 ? only : null };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const startedAt = Date.now();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(AppConfig);
  const pgvector = app.get(PgVectorService);
  const corpusService = app.get(DefaultCorpusService);
  const chunking = app.get(ChunkingService);
  const openai = app.get(OpenAiService);
  const contextualizer = app.get(ContextualizerService);
  const graphBuilder = app.get(GraphBuilderService);
  const strategies = app.get(RagStrategyFactory);

  openai.ensureClient();

  logger.log('Bringing the schema up to date');
  await pgvector.migrate();

  const targets: StrategyId[] = args.only ?? ['baseline', 'advanced', 'advanced-pro', 'graphrag'];

  if (args.reset) {
    if (args.only) {
      // Scope the reset to what was asked for. A blanket clearAll() here would
      // silently destroy the strategies the caller did not name.
      logger.warn(`--reset: clearing ${args.only.join(', ')}`);
      for (const strategyId of args.only) await pgvector.clearStrategy(strategyId);
    } else {
      logger.warn('--reset: clearing all seeded data');
      await pgvector.clearAll();
    }
  }

  const corpus = corpusService.getCorpus();
  logger.log(
    `Corpus: ${corpus.documents.length} documents, ${corpus.totalChars.toLocaleString()} chars, ` +
      `fingerprint ${corpus.fingerprint}`,
  );

  const existing = new Map(
    (await pgvector.getCoverage()).map((c) => [c.strategy, c.chunkCount]),
  );

  const tracker = new UsageTracker();

  for (const strategyId of targets) {
    const already = existing.get(strategyId) ?? 0;
    if (already > 0 && !args.reset && !args.only) {
      logger.log(`[${strategyId}] already seeded with ${already} chunks — skipping`);
      continue;
    }

    const strategy = strategies.get(strategyId);
    const strategyStart = Date.now();
    logger.log(`[${strategyId}] chunking with the "${strategy.chunkProfile}" profile`);

    let chunks = chunking.chunkAll(corpus.documents, strategy.chunkProfile);
    logger.log(`[${strategyId}] ${chunks.length} chunks`);

    // Advanced-Pro: LLM-written contextual headers, generated once here and
    // stored, so request-time ingestion is a pure read.
    const contextHeaders = new Map<string, string>();
    if (strategyId === 'advanced-pro') {
      logger.log(`[${strategyId}] generating ${chunks.length} contextual headers (this is the slow part)`);
      const docById = new Map(corpus.documents.map((d) => [d.id, d]));

      const withContext = await contextualizer.contextualize(
        chunks,
        corpus.documents,
        tracker,
        undefined,
        // No budget cap in the seed — the whole point is to do it properly once.
        chunks.length,
      );

      // Recover just the header so it can be stored separately from embedText.
      withContext.forEach((chunk, i) => {
        const header = chunk.embedText.slice(0, chunk.embedText.length - chunks[i].text.length);
        const match = /^\[Context:\s*([\s\S]*?)\]\n$/.exec(header);
        if (match) contextHeaders.set(chunk.id, match[1].trim());
      });

      chunks = withContext;
      void docById;
    }

    logger.log(`[${strategyId}] embedding ${chunks.length} chunks`);
    const embeddings = await openai.embed(
      chunks.map((c) => c.embedText),
      tracker,
    );

    logger.log(`[${strategyId}] writing to pgvector`);
    await pgvector.clearStrategy(strategyId);
    await pgvector.saveChunks(
      strategyId,
      chunks.map((chunk, i) => ({
        chunk,
        embedding: embeddings[i],
        contextHeader: contextHeaders.get(chunk.id) ?? null,
      })),
    );

    // GraphRAG: extract the graph over the full corpus and store it.
    if (strategyId === 'graphrag') {
      logger.log(`[${strategyId}] building knowledge graph over ${chunks.length} text units`);
      const graph = await graphBuilder.build(chunks, tracker, (m) => logger.log(`[graphrag] ${m}`), {
        // Seed-time budgets: cover the whole corpus rather than a sample.
        maxUnits: chunks.length,
        maxSummaries: 60,
      });

      await pgvector.saveGraph('graphrag', graphBuilder.serialize(graph), graph.levels);
      logger.log(
        `[graphrag] stored ${graph.entities.size} entities, ${graph.relationships.length} ` +
          `relationships, ${graph.communities.length} communities across ${graph.levels} level(s)`,
      );
    }

    const totals = tracker.totals();
    logger.log(
      `[${strategyId}] done in ${((Date.now() - strategyStart) / 1000).toFixed(1)}s ` +
        `(running cost $${totals.costUsd.toFixed(4)})`,
    );
  }

  await pgvector.saveManifest({
    documentCount: corpus.documents.length,
    totalChars: corpus.totalChars,
    corpusFingerprint: corpus.fingerprint,
    embeddingModel: config.embeddingModel,
  });

  const totals = tracker.totals();
  const coverage = await pgvector.getCoverage();

  logger.log('─'.repeat(70));
  logger.log(`Seed complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  for (const c of coverage.sort((a, b) => a.strategy.localeCompare(b.strategy))) {
    logger.log(`  ${c.strategy.padEnd(14)} ${c.chunkCount} chunks`);
  }
  logger.log(
    `  tokens: ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out ` +
      `(${totals.embeddingTokens.toLocaleString()} embedding)`,
  );
  logger.log(`  cost:   $${totals.costUsd.toFixed(4)}`);
  logger.log('─'.repeat(70));

  await app.close();
}

main().catch((err) => {
  logger.error(`Seed failed: ${(err as Error).message}`, (err as Error).stack);
  process.exit(1);
});
