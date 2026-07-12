import { Injectable, Logger } from '@nestjs/common';

import { AppConfig } from '../../config/app-config';
import {
  LLM_CONCURRENCY,
  MAX_CONTEXTUALIZED_CHUNKS,
  MAX_SUMMARY_OUTPUT_TOKENS,
} from '../../config/limits';
import { Chunk, SourceDocument } from '../../common/types';
import { OpenAiService } from '../../llm/openai.service';
import { UsageTracker } from '../../llm/usage-tracker';
import { CONTEXTUALIZE_SYSTEM_PROMPT, buildContextualizePrompt } from '../../llm/prompts';
import { mapWithConcurrency } from '../../ingestion/text-utils';
import { buildDeterministicContext } from '../../ingestion/chunking.service';

/** Document excerpt given to the contextualiser, in characters. */
const DOCUMENT_EXCERPT_CHARS = 6000;

/**
 * Contextual retrieval: prepend a short, LLM-written sentence situating each
 * chunk inside its document, and embed *that* instead of the bare chunk.
 *
 * The problem it solves: a chunk reading "The agreement may be terminated after
 * 30 days" is nearly unretrievable, because it names neither the agreement nor
 * the parties. Embedding "This clause from the termination section of the Apex
 * Reinsurance contract states that..." makes it findable.
 *
 * The original text is what the answering LLM sees — only the *retrieval
 * representation* is enriched, so no invented context can leak into an answer.
 *
 * Cost control: for the shipped knowledge base these headers are generated once
 * by the seed script and read back from pgvector. For an anonymous upload only
 * the first MAX_CONTEXTUALIZED_CHUNKS chunks are enriched; the rest keep the
 * deterministic heading-path header, which costs nothing.
 */
@Injectable()
export class ContextualizerService {
  private readonly logger = new Logger(ContextualizerService.name);

  constructor(
    private readonly openai: OpenAiService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Returns chunks whose `embedText` carries a context header. `cached` supplies
   * pre-generated headers by chunk id; anything missing is generated up to the
   * budget.
   */
  async contextualize(
    chunks: Chunk[],
    documents: SourceDocument[],
    tracker: UsageTracker,
    cached?: Map<string, string>,
    budget = MAX_CONTEXTUALIZED_CHUNKS,
  ): Promise<Chunk[]> {
    const docById = new Map(documents.map((d) => [d.id, d]));
    const needsGeneration: number[] = [];

    const headers = chunks.map((c, i) => {
      const hit = cached?.get(c.id);
      if (hit) return hit;
      if (needsGeneration.length < budget) needsGeneration.push(i);
      return null;
    });

    if (needsGeneration.length > 0) {
      this.logger.log(`Generating ${needsGeneration.length} contextual headers`);

      const generated = await mapWithConcurrency(
        needsGeneration,
        LLM_CONCURRENCY,
        async (chunkIndex) => {
          const chunk = chunks[chunkIndex];
          const doc = docById.get(chunk.docId);
          if (!doc) return null;
          return this.generateHeader(doc, chunk, tracker);
        },
      );

      needsGeneration.forEach((chunkIndex, j) => {
        headers[chunkIndex] = generated[j];
      });
    }

    return chunks.map((c, i) => {
      const header = headers[i];
      // Deterministic heading-path context is the floor: every chunk gets at
      // least that, so an exhausted budget degrades gracefully.
      const prefix = header
        ? `[Context: ${header.trim()}]\n`
        : buildDeterministicContext(c);
      return { ...c, embedText: prefix + c.text };
    });
  }

  /** Generates one header. Exposed so the seed script can reuse it directly. */
  async generateHeader(
    doc: SourceDocument,
    chunk: Chunk,
    tracker: UsageTracker,
  ): Promise<string | null> {
    try {
      const { text } = await this.openai.chat(this.config.utilityModel, {
        system: CONTEXTUALIZE_SYSTEM_PROMPT,
        user: buildContextualizePrompt(
          doc.text.slice(0, DOCUMENT_EXCERPT_CHARS),
          chunk.text,
        ),
        maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
        stage: 'query-transform',
        tracker,
        reasoningEffort: 'minimal',
      });

      const header = text.replace(/\s+/g, ' ').trim();
      return header.length > 8 ? header : null;
    } catch (err) {
      this.logger.warn(`Contextualisation failed for ${chunk.id}: ${(err as Error).message}`);
      return null;
    }
  }
}
