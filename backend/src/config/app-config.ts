import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';

@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService) {}

  private req(key: string): string {
    const v = this.config.get<string>(key);
    if (!v) throw new Error(`Missing required environment variable: ${key}`);
    return v;
  }

  get openAiApiKey(): string {
    return this.req('OPENAI_API_KEY');
  }

  get embeddingModel(): string {
    return this.config.get<string>('EMBEDDING_MODEL') ?? 'text-embedding-3-small';
  }

  get answerModel(): string {
    return this.config.get<string>('ANSWER_MODEL') ?? 'gpt-5-nano';
  }

  get judgeModel(): string {
    return this.config.get<string>('JUDGE_MODEL') ?? 'gpt-5-nano';
  }

  /** Query rewriting, decomposition, routing, reranking, graph extraction. */
  get utilityModel(): string {
    return this.config.get<string>('UTILITY_MODEL') ?? 'gpt-5-nano';
  }

  get databaseUrl(): string {
    return this.req('DATABASE_URL');
  }

  /**
   * How long to wait for a Postgres connection.
   *
   * Well above a local socket's needs, because the deployment target is a
   * serverless Postgres (Neon) that suspends when idle: the first connection
   * after that has to wait for the compute to resume, which takes seconds.
   * Timing out there would silently fall back to re-embedding the corpus.
   */
  get pgConnectTimeoutMs(): number {
    return Number(this.config.get<string>('PG_CONNECT_TIMEOUT_MS') ?? 20_000);
  }

  get port(): number {
    return Number(this.config.get<string>('PORT') ?? 3001);
  }

  /**
   * Allowed browser origins, as written in CORS_ORIGIN.
   *
   * Entries may contain `*` as a wildcard, which is what makes Vercel usable:
   * every preview deployment gets a fresh hostname
   * (`project-git-branch-team.vercel.app`), so an exact-match list would block
   * every preview and leave only the production URL working.
   */
  get corsOrigins(): string[] {
    const raw = this.config.get<string>('CORS_ORIGIN') ?? 'http://localhost:5173';
    return raw
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  }

  private resolveFromBackend(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(__dirname, '../../', p);
  }

  get defaultKbDir(): string {
    return this.resolveFromBackend(
      this.config.get<string>('DEFAULT_KB_DIR') ?? '../default-knowledge-base',
    );
  }

  get defaultQaSetPath(): string {
    return this.resolveFromBackend(
      this.config.get<string>('DEFAULT_QA_SET') ?? '../default-question-answer-set.jsonl',
    );
  }
}

/** Characters that have to be escaped to match literally inside a RegExp. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Builds an origin matcher from the configured patterns.
 *
 * `*` stands for any run of characters other than `/`, which is what makes
 * Vercel workable: previews get a fresh hostname on every push.
 *
 * The pattern is anchored and every other character is escaped, so
 * `https://app.vercel.app` in the list cannot be satisfied by
 * `https://app.vercel.app.attacker.com`, and `https://*.vercel.app` cannot be
 * satisfied by `https://evil.com/.vercel.app` — the wildcard stops at a slash.
 */
export function buildOriginMatcher(patterns: string[]): (origin: string) => boolean {
  const matchers = patterns.map((pattern) => {
    const escaped = pattern.replace(REGEX_SPECIAL, (ch) => (ch === '*' ? '[^/]*' : `\\${ch}`));
    return new RegExp(`^${escaped}$`);
  });

  return (origin: string) => matchers.some((m) => m.test(origin));
}
