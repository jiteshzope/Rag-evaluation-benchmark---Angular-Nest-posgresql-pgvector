import { Injectable } from '@nestjs/common';

import { AppConfig } from '../config/app-config';
import { MAX_UTILITY_OUTPUT_TOKENS } from '../config/limits';
import { OpenAiService } from '../llm/openai.service';
import { UsageTracker } from '../llm/usage-tracker';
import {
  DECOMPOSE_SYSTEM_PROMPT,
  MULTI_QUERY_SCHEMA,
  MULTI_QUERY_SYSTEM_PROMPT,
  REWRITE_SYSTEM_PROMPT,
  ROUTE_SCHEMA,
  ROUTE_SYSTEM_PROMPT,
} from '../llm/prompts';

export interface QueryRoute {
  category: 'specific' | 'multi_hop' | 'broad';
  needsDecomposition: boolean;
  suggestedK: number;
}

const schema = (s: unknown) => s as unknown as { name: string; schema: Record<string, unknown> };

/**
 * Query-side transformations shared by the advanced strategies.
 *
 * Each method degrades to the original question when the model misbehaves — a
 * failed rewrite should cost one wasted call, never a failed evaluation run.
 */
@Injectable()
export class QueryTransformService {
  constructor(
    private readonly openai: OpenAiService,
    private readonly config: AppConfig,
  ) {}

  /** Single rewrite optimised for hybrid retrieval. */
  async rewrite(question: string, tracker: UsageTracker): Promise<string> {
    const { text } = await this.openai.chat(this.config.utilityModel, {
      system: REWRITE_SYSTEM_PROMPT,
      user: question,
      maxOutputTokens: MAX_UTILITY_OUTPUT_TOKENS,
      stage: 'query-transform',
      tracker,
      reasoningEffort: 'minimal',
    });

    const rewritten = text.replace(/^["']|["']$/g, '').trim();
    return rewritten.length > 3 ? rewritten : question;
  }

  /** 2-4 diverse queries attacking the question from different angles. */
  async multiQuery(question: string, tracker: UsageTracker): Promise<string[]> {
    const result = await this.openai.chatJson<{ queries: string[] }>(this.config.utilityModel, {
      system: MULTI_QUERY_SYSTEM_PROMPT,
      user: question,
      maxOutputTokens: MAX_UTILITY_OUTPUT_TOKENS,
      stage: 'query-transform',
      tracker,
      reasoningEffort: 'minimal',
      jsonSchema: schema(MULTI_QUERY_SCHEMA),
    });

    const queries = (result?.queries ?? [])
      .map((q) => q.trim())
      .filter((q) => q.length > 3)
      .slice(0, 4);

    return queries.length > 0 ? unique([question, ...queries]) : [question];
  }

  /** Break a complex question into independent, self-contained sub-questions. */
  async decompose(question: string, tracker: UsageTracker): Promise<string[]> {
    const result = await this.openai.chatJson<{ queries: string[] }>(this.config.utilityModel, {
      system: DECOMPOSE_SYSTEM_PROMPT,
      user: question,
      maxOutputTokens: MAX_UTILITY_OUTPUT_TOKENS,
      stage: 'query-transform',
      tracker,
      reasoningEffort: 'minimal',
      jsonSchema: schema(MULTI_QUERY_SCHEMA),
    });

    const parts = (result?.queries ?? [])
      .map((q) => q.trim())
      .filter((q) => q.length > 3)
      .slice(0, 3);

    return parts.length > 0 ? unique(parts) : [question];
  }

  /** Classify the question so advanced-pro can route it. */
  async route(question: string, tracker: UsageTracker): Promise<QueryRoute> {
    const result = await this.openai.chatJson<QueryRoute>(this.config.utilityModel, {
      system: ROUTE_SYSTEM_PROMPT,
      user: question,
      maxOutputTokens: MAX_UTILITY_OUTPUT_TOKENS,
      stage: 'query-transform',
      tracker,
      reasoningEffort: 'minimal',
      jsonSchema: schema(ROUTE_SCHEMA),
    });

    if (!result) {
      return { category: 'specific', needsDecomposition: false, suggestedK: 5 };
    }

    return {
      category: ['specific', 'multi_hop', 'broad'].includes(result.category)
        ? result.category
        : 'specific',
      needsDecomposition: Boolean(result.needsDecomposition),
      suggestedK: clampInt(result.suggestedK, 3, 5, 5),
    };
  }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
