import { Injectable, Logger } from '@nestjs/common';

import { AppConfig } from '../config/app-config';
import {
  LLM_CONCURRENCY,
  MAX_GENERATED_QUESTIONS,
  MAX_UTILITY_OUTPUT_TOKENS,
} from '../config/limits';
import { Chunk, EvaluationItem, QuestionType } from '../common/types';
import { OpenAiService } from '../llm/openai.service';
import { UsageTracker } from '../llm/usage-tracker';
import { DATASET_SCHEMA, DATASET_SYSTEM_PROMPT } from '../llm/prompts';
import { mapWithConcurrency, normalizeForMatch } from '../ingestion/text-utils';
import { normalizeQuestionType } from './dataset-parser';

interface GeneratedItem {
  question: string;
  referenceAnswer: string;
  expectedKeywords: string[];
  questionType: string;
}

/** A chunk shorter than this rarely holds a self-contained answerable fact. */
const MIN_CHUNK_CHARS_FOR_GENERATION = 250;

/**
 * Generates an evaluation dataset from the knowledge base itself.
 *
 * The key advantage over a hand-written set: because each question is generated
 * *from a specific chunk*, that chunk is recorded as `goldChunkIds`. Retrieval
 * metrics then rest on real ground truth instead of derived labels.
 */
@Injectable()
export class DatasetGeneratorService {
  private readonly logger = new Logger(DatasetGeneratorService.name);

  constructor(
    private readonly openai: OpenAiService,
    private readonly config: AppConfig,
  ) {}

  async generate(
    chunks: Chunk[],
    requested: number,
    tracker: UsageTracker,
    onProgress?: (done: number, total: number) => void,
  ): Promise<EvaluationItem[]> {
    const count = Math.min(requested, MAX_GENERATED_QUESTIONS);
    const selected = this.selectChunks(chunks, count);

    this.logger.log(`Generating ${selected.length} questions from ${chunks.length} chunks`);

    let done = 0;
    const generated = await mapWithConcurrency(selected, LLM_CONCURRENCY, async (chunk) => {
      const item = await this.generateOne(chunk, tracker);
      onProgress?.(++done, selected.length);
      return item;
    });

    const items: EvaluationItem[] = [];
    const seenQuestions = new Set<string>();

    generated.forEach((raw, i) => {
      if (!raw?.question?.trim() || !raw?.referenceAnswer?.trim()) return;

      // Near-duplicate questions make the by-type averages misleading.
      const fingerprint = normalizeForMatch(raw.question);
      if (seenQuestions.has(fingerprint)) return;
      seenQuestions.add(fingerprint);

      const keywords = (raw.expectedKeywords ?? [])
        .map((k) => String(k).trim())
        .filter((k) => k.length > 1)
        .slice(0, 5);

      // A question with no distinctive keywords cannot be scored on coverage
      // and would weaken the relevance labels; drop it.
      if (keywords.length === 0) return;

      items.push({
        id: `gen-${items.length + 1}`,
        question: raw.question.trim(),
        referenceAnswer: raw.referenceAnswer.trim(),
        expectedKeywords: keywords,
        questionType: normalizeQuestionType(raw.questionType) as QuestionType,
        goldChunkIds: [selected[i].id],
      });
    });

    this.logger.log(`Generated ${items.length} usable questions from ${selected.length} attempts`);
    return items;
  }

  private async generateOne(chunk: Chunk, tracker: UsageTracker): Promise<GeneratedItem | null> {
    const where = chunk.headingPath.length
      ? `${chunk.docTitle} > ${chunk.headingPath.join(' > ')}`
      : chunk.docTitle;

    try {
      return await this.openai.chatJson<GeneratedItem>(this.config.utilityModel, {
        system: DATASET_SYSTEM_PROMPT,
        user: `Source: ${where}\n\nPassage:\n${chunk.text}\n\nWrite one evaluation question.`,
        maxOutputTokens: MAX_UTILITY_OUTPUT_TOKENS,
        stage: 'dataset-generation',
        tracker,
        reasoningEffort: 'minimal',
        jsonSchema: DATASET_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
      });
    } catch (err) {
      this.logger.warn(`Question generation failed for ${chunk.id}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Pick source chunks spread evenly across documents, preferring substantial
   * ones. Taking the first N chunks would generate a whole dataset about the
   * first two files in the corpus.
   */
  private selectChunks(chunks: Chunk[], count: number): Chunk[] {
    const usable = chunks.filter((c) => c.text.length >= MIN_CHUNK_CHARS_FOR_GENERATION);
    const pool = usable.length >= count ? usable : chunks;
    if (pool.length <= count) return pool;

    const byDoc = new Map<string, Chunk[]>();
    for (const c of pool) {
      const list = byDoc.get(c.docId) ?? [];
      list.push(c);
      byDoc.set(c.docId, list);
    }

    // Within each document, prefer the longest chunks.
    for (const list of byDoc.values()) list.sort((a, b) => b.text.length - a.text.length);

    const docs = [...byDoc.values()];
    const selected: Chunk[] = [];
    let round = 0;

    while (selected.length < count) {
      let addedThisRound = false;
      for (const docChunks of docs) {
        if (selected.length >= count) break;
        if (round < docChunks.length) {
          selected.push(docChunks[round]);
          addedThisRound = true;
        }
      }
      if (!addedThisRound) break;
      round++;
    }

    return selected;
  }
}
