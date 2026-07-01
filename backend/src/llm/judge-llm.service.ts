import { Injectable, Logger } from '@nestjs/common';

import { AppConfig } from '../config/app-config';
import { MAX_JUDGE_OUTPUT_TOKENS } from '../config/limits';
import { RetrievedChunk } from '../common/types';
import { OpenAiService } from './openai.service';
import { UsageTracker } from './usage-tracker';
import { JUDGE_SCHEMA, JUDGE_SYSTEM_PROMPT, buildJudgePrompt } from './prompts';

export interface JudgeRequest {
  question: string;
  referenceAnswer: string;
  generatedAnswer: string;
  chunks: RetrievedChunk[];
  tracker: UsageTracker;
}

export interface JudgeVerdict {
  faithfulness: number;
  factualCorrectness: number;
  answerRelevance: number;
  judgeScore: number;
  verdict: 'pass' | 'partial' | 'fail';
  reasoning: string;
  latencyMs: number;
}

interface RawJudgement {
  faithfulness: number;
  factualCorrectness: number;
  answerRelevance: number;
  judgeScore: number;
  verdict: string;
  reasoning: string;
}

const clamp01 = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.min(1, Math.max(0, v));
};

/**
 * LLM-as-judge. Sees strictly more than the answerer: question, reference
 * answer, generated answer and the same retrieved context.
 */
@Injectable()
export class JudgeLlmService {
  private readonly logger = new Logger(JudgeLlmService.name);

  constructor(
    private readonly openai: OpenAiService,
    private readonly config: AppConfig,
  ) {}

  async evaluate(req: JudgeRequest): Promise<JudgeVerdict> {
    const startedAt = Date.now();

    // An empty answer is an unambiguous fail; spending a judge call on it would
    // be pure waste across a 100-question run.
    if (!req.generatedAnswer.trim()) {
      return {
        faithfulness: 0,
        factualCorrectness: 0,
        answerRelevance: 0,
        judgeScore: 0,
        verdict: 'fail',
        reasoning: 'The system produced no answer.',
        latencyMs: Date.now() - startedAt,
      };
    }

    let raw = await this.ask(req, false);

    // A truncated or unparseable judgement is a *measurement* failure, not a bad
    // answer. Retrying once costs one cheap call; recording it as 0.0 would
    // silently drag the strategy's averages down and be indistinguishable from
    // a genuine hallucination.
    if (!raw) {
      this.logger.warn('Judge returned no parseable verdict; retrying once with terser output.');
      raw = await this.ask(req, true);
    }

    const latencyMs = Date.now() - startedAt;

    if (!raw) {
      // Surfacing this as an error means the orchestrator counts the question as
      // a failure and excludes it from the metric averages, rather than
      // fabricating a score the judge never gave.
      throw new Error('The judge model did not return a parseable verdict after a retry.');
    }

    const judgeScore = clamp01(raw.judgeScore);

    return {
      faithfulness: clamp01(raw.faithfulness),
      factualCorrectness: clamp01(raw.factualCorrectness),
      answerRelevance: clamp01(raw.answerRelevance),
      judgeScore,
      verdict: normalizeVerdict(raw.verdict, judgeScore),
      reasoning: (raw.reasoning ?? '').trim(),
      latencyMs,
    };
  }

  /** One judgement call. `terse` is the retry, which asks for less prose. */
  private async ask(req: JudgeRequest, terse: boolean): Promise<RawJudgement | null> {
    return this.openai.chatJson<RawJudgement>(this.config.judgeModel, {
      system: terse
        ? `${JUDGE_SYSTEM_PROMPT}\n\nIMPORTANT: keep "reasoning" to at most 15 words.`
        : JUDGE_SYSTEM_PROMPT,
      user: buildJudgePrompt(req),
      maxOutputTokens: MAX_JUDGE_OUTPUT_TOKENS,
      stage: 'judge',
      tracker: req.tracker,
      reasoningEffort: 'minimal',
      jsonSchema: JUDGE_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    });
  }
}

/** Trust the stated verdict when it is one of ours; otherwise derive it. */
function normalizeVerdict(verdict: string, judgeScore: number): 'pass' | 'partial' | 'fail' {
  const v = (verdict ?? '').toLowerCase().trim();
  if (v === 'pass' || v === 'partial' || v === 'fail') return v;
  if (judgeScore >= 0.75) return 'pass';
  if (judgeScore >= 0.4) return 'partial';
  return 'fail';
}
