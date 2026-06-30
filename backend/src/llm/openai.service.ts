import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import OpenAI from 'openai';

import { AppConfig } from '../config/app-config';
import { computeCost } from '../config/pricing';
import { EMBEDDING_BATCH_SIZE } from '../config/limits';
import { UsageStage } from '../common/types';
import { UsageTracker } from './usage-tracker';
import { l2Normalize } from '../ingestion/text-utils';

export interface ChatOptions {
  system?: string;
  user: string;
  maxOutputTokens: number;
  stage: UsageStage;
  tracker: UsageTracker;
  /** Reasoning models only. 'minimal' keeps latency and hidden token spend down. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** When set, the model is constrained to this JSON schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface ChatResult {
  text: string;
  truncated: boolean;
}

/**
 * Thin wrapper over the OpenAI SDK that makes every call *accounted for*.
 *
 * Nothing else in the codebase talks to OpenAI directly, so there is exactly one
 * place where tokens are counted, cost is computed and retries happen.
 */
@Injectable()
export class OpenAiService implements OnModuleInit {
  private readonly logger = new Logger(OpenAiService.name);
  private client!: OpenAI;

  constructor(private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.client = new OpenAI({ apiKey: this.config.openAiApiKey, maxRetries: 0 });
  }

  /** Lets the seed script construct the service without the Nest lifecycle. */
  ensureClient(): void {
    if (!this.client) this.onModuleInit();
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  async chat(model: string, opts: ChatOptions): Promise<ChatResult> {
    this.ensureClient();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: opts.user });

    const body: Record<string, unknown> = {
      model,
      messages,
      max_completion_tokens: opts.maxOutputTokens,
    };

    if (isReasoningModel(model)) {
      body.reasoning_effort = opts.reasoningEffort ?? 'minimal';
    } else {
      body.temperature = 0;
    }

    if (opts.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: opts.jsonSchema.name,
          schema: opts.jsonSchema.schema,
          strict: true,
        },
      };
    }

    const completion = await this.withRetry(
      () => this.client.chat.completions.create(body as never) as Promise<OpenAI.Chat.ChatCompletion>,
      `chat:${opts.stage}`,
    );

    const usage = completion.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    opts.tracker.add({
      model,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costUsd: computeCost(model, inputTokens, outputTokens, cachedInputTokens),
      stage: opts.stage,
    });

    const choice = completion.choices[0];
    const text = choice?.message?.content ?? '';
    const truncated = choice?.finish_reason === 'length';

    if (truncated) {
      this.logger.warn(
        `Output truncated at ${opts.maxOutputTokens} tokens (stage=${opts.stage}, model=${model})`,
      );
    }

    return { text: text.trim(), truncated };
  }

  /**
   * Chat call constrained to a JSON schema, parsed for you. Returns `null` when
   * the model produced nothing parseable so callers can degrade gracefully
   * rather than failing an entire evaluation run.
   */
  async chatJson<T>(
    model: string,
    opts: ChatOptions & { jsonSchema: { name: string; schema: Record<string, unknown> } },
  ): Promise<T | null> {
    const { text } = await this.chat(model, opts);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Structured outputs should make this unreachable; salvage a JSON object
      // if a model ever wraps it in prose.
      const match = /\{[\s\S]*\}/.exec(text);
      if (match) {
        try {
          return JSON.parse(match[0]) as T;
        } catch {
          /* fall through */
        }
      }
      this.logger.warn(`Unparseable JSON from ${model} (stage=${opts.stage}): ${text.slice(0, 200)}`);
      return null;
    }
  }

  // ── Embeddings ─────────────────────────────────────────────────────────────

  /**
   * Embed a batch of texts. Vectors come back L2-normalised so downstream
   * similarity is a plain dot product.
   */
  async embed(texts: string[], tracker: UsageTracker): Promise<Float32Array[]> {
    this.ensureClient();
    if (texts.length === 0) return [];

    const model = this.config.embeddingModel;
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE).map((t) => (t.trim() ? t : ' '));

      const response = await this.withRetry(
        () => this.client.embeddings.create({ model, input: batch, encoding_format: 'float' }),
        'embeddings',
      );

      const inputTokens = response.usage?.prompt_tokens ?? 0;
      tracker.add({
        model,
        inputTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: computeCost(model, inputTokens, 0, 0),
        stage: 'embedding',
      });

      // The API guarantees order, but sort defensively — a mis-ordered batch
      // would silently corrupt every downstream metric.
      const sorted = [...response.data].sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        out.push(l2Normalize(Float32Array.from(item.embedding)));
      }
    }

    return out;
  }

  async embedOne(text: string, tracker: UsageTracker): Promise<Float32Array> {
    const [v] = await this.embed([text], tracker);
    return v;
  }

  // ── Retry ──────────────────────────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const status = (err as { status?: number }).status;
        const retryable = status === undefined || status === 408 || status === 429 || status >= 500;

        if (!retryable || attempt === attempts) break;

        const backoff = Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.random() * 250;
        this.logger.warn(
          `${label} failed (status=${status ?? 'network'}), retry ${attempt}/${attempts - 1} in ${Math.round(backoff)}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    throw lastError;
  }
}

/** GPT-5 family and o-series take `reasoning_effort` and reject `temperature`. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[134])/.test(model);
}
