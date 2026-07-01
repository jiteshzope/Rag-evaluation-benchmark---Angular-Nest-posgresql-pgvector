import { Injectable } from '@nestjs/common';

import { AppConfig } from '../config/app-config';
import { MAX_OUTPUT_TOKENS } from '../config/limits';
import { RetrievedChunk } from '../common/types';
import { OpenAiService } from './openai.service';
import { UsageTracker } from './usage-tracker';
import { ANSWER_SYSTEM_PROMPT, buildAnswerPrompt } from './prompts';

export interface AnswerRequest {
  question: string;
  chunks: RetrievedChunk[];
  tracker: UsageTracker;
}

export interface AnswerResponse {
  answer: string;
  truncated: boolean;
  latencyMs: number;
}

/**
 * Generates an answer from the question plus retrieved context.
 *
 * Critically, this service has no access to the reference answer — it is not
 * even in the request type. That keeps the generation step honest so the judge's
 * scores measure the retrieval pipeline rather than a leaked ground truth.
 */
@Injectable()
export class AnswerLlmService {
  constructor(
    private readonly openai: OpenAiService,
    private readonly config: AppConfig,
  ) {}

  async generate(req: AnswerRequest): Promise<AnswerResponse> {
    const startedAt = Date.now();

    const { text, truncated } = await this.openai.chat(this.config.answerModel, {
      system: ANSWER_SYSTEM_PROMPT,
      user: buildAnswerPrompt(req.question, req.chunks),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stage: 'answer',
      tracker: req.tracker,
      reasoningEffort: 'minimal',
    });

    return { answer: text, truncated, latencyMs: Date.now() - startedAt };
  }
}
