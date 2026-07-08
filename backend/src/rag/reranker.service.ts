import { Injectable, Logger } from '@nestjs/common';

import { AppConfig } from '../config/app-config';
import { MAX_UTILITY_OUTPUT_TOKENS } from '../config/limits';
import { RetrievedChunk } from '../common/types';
import { OpenAiService } from '../llm/openai.service';
import { UsageTracker } from '../llm/usage-tracker';
import { RERANK_SCHEMA, RERANK_SYSTEM_PROMPT, buildRerankPrompt } from '../llm/prompts';
import { renumber } from './fusion';

/** Passages scored per rerank call. Keeps one prompt well inside context. */
const RERANK_WINDOW = 10;

/**
 * LLM cross-encoder reranker: the second stage that turns a wide, cheap
 * candidate pool into a precise top-k.
 *
 * Bi-encoder retrieval (dense or BM25) scores query and passage independently.
 * A cross-encoder reads them together, so it can tell that a passage mentioning
 * the right entity does not actually answer the question. That is exactly the
 * failure mode nDCG punishes and the reason reranking moves the numbers.
 */
@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);

  constructor(
    private readonly openai: OpenAiService,
    private readonly config: AppConfig,
  ) {}

  async rerank(
    question: string,
    candidates: RetrievedChunk[],
    topN: number,
    tracker: UsageTracker,
  ): Promise<RetrievedChunk[]> {
    if (candidates.length <= 1) return candidates;

    const windows: RetrievedChunk[][] = [];
    for (let i = 0; i < candidates.length; i += RERANK_WINDOW) {
      windows.push(candidates.slice(i, i + RERANK_WINDOW));
    }

    const scored: Array<{ item: RetrievedChunk; score: number }> = [];

    for (const window of windows) {
      const scores = await this.scoreWindow(question, window, tracker);
      window.forEach((item, i) => {
        // Fall back to the fusion rank when the model skipped a passage, so an
        // incomplete response degrades to the input order instead of dropping
        // candidates entirely.
        const modelScore = scores.get(i + 1);
        const fallback = 1 / (item.rank || i + 1);
        scored.push({ item, score: modelScore ?? fallback });
      });
    }

    scored.sort((a, b) => b.score - a.score);

    return renumber(
      scored.slice(0, topN).map(({ item, score }) => ({
        ...item,
        score,
        provenance: [...item.provenance, { source: 'rerank' as const, score }],
      })),
    );
  }

  private async scoreWindow(
    question: string,
    window: RetrievedChunk[],
    tracker: UsageTracker,
  ): Promise<Map<number, number>> {
    const out = new Map<number, number>();

    const result = await this.openai.chatJson<{ scores: Array<{ passage: number; score: number }> }>(
      this.config.utilityModel,
      {
        system: RERANK_SYSTEM_PROMPT,
        user: buildRerankPrompt(
          question,
          window.map((w) => w.chunk.text),
        ),
        maxOutputTokens: MAX_UTILITY_OUTPUT_TOKENS,
        stage: 'rerank',
        tracker,
        reasoningEffort: 'minimal',
        jsonSchema: RERANK_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      },
    );

    if (!result?.scores) {
      this.logger.warn('Reranker returned no scores; keeping fusion order for this window.');
      return out;
    }

    for (const entry of result.scores) {
      if (
        typeof entry?.passage === 'number' &&
        typeof entry?.score === 'number' &&
        Number.isFinite(entry.score) &&
        entry.passage >= 1 &&
        entry.passage <= window.length
      ) {
        // Normalise 0-10 to 0-1 so scores stay comparable with other sources.
        out.set(entry.passage, Math.min(1, Math.max(0, entry.score / 10)));
      }
    }

    return out;
  }
}
