import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Request } from 'express';

import {
  MAX_DATASET_GENERATIONS_PER_DAY,
  MAX_RUNS_PER_DAY,
  MAX_UPLOADS_PER_DAY,
  RATE_LIMIT_WINDOW_MS,
} from '../config/limits';

export type QuotaAction = 'run' | 'upload' | 'generate';

const QUOTAS: Record<QuotaAction, number> = {
  run: MAX_RUNS_PER_DAY,
  upload: MAX_UPLOADS_PER_DAY,
  generate: MAX_DATASET_GENERATIONS_PER_DAY,
};

const ACTION_LABELS: Record<QuotaAction, string> = {
  run: 'evaluation runs',
  upload: 'knowledge base uploads',
  generate: 'dataset generations',
};

interface Bucket {
  count: number;
  windowStartedAt: number;
}

export interface QuotaStatus {
  action: QuotaAction;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: number;
}

/**
 * Per-visitor daily quota, held in memory.
 *
 * This is a public portfolio deployment where every run spends real API credit,
 * so anonymous visitors get a fixed daily budget — enough for a recruiter to
 * explore properly, not enough to drain the account.
 *
 * In-memory is the right trade here: the app is a single process, and a quota
 * that resets on deploy is an acceptable failure mode for a demo. It is not a
 * security control — it is a spend control.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.evictExpired(), 10 * 60_000);
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  /** Throws 429 when the visitor is out of budget, otherwise records the use. */
  consume(req: Request, action: QuotaAction): QuotaStatus {
    const status = this.peek(req, action);

    if (status.remaining <= 0) {
      const hours = Math.max(1, Math.ceil((status.resetsAt - Date.now()) / 3_600_000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Daily limit reached',
          message:
            `You have used all ${status.limit} ${ACTION_LABELS[action]} available today. ` +
            `This is a portfolio demo and every run spends real OpenAI credit, so anonymous ` +
            `usage is capped. Your quota resets in about ${hours} hour${hours === 1 ? '' : 's'}.`,
          quota: status,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const key = this.keyFor(req, action);
    const bucket = this.buckets.get(key)!;
    bucket.count++;

    return {
      ...status,
      used: bucket.count,
      remaining: Math.max(0, status.limit - bucket.count),
    };
  }

  /**
   * Hands one use back.
   *
   * The quota exists to cap spend, so an action that was rejected before it
   * could spend anything must not leave the visitor poorer. Callers pair this
   * with consume() around work that can still fail validation.
   */
  refund(req: Request, action: QuotaAction): void {
    const bucket = this.buckets.get(this.keyFor(req, action));
    if (bucket && bucket.count > 0) bucket.count--;
  }

  /**
   * Runs `work` against one unit of quota, returning it if `work` throws.
   *
   * Checking the quota up front is what stops the spend; the refund is what
   * stops a 400 from costing the visitor a run.
   */
  async spendOn<T>(req: Request, action: QuotaAction, work: () => Promise<T> | T): Promise<T> {
    this.consume(req, action);
    try {
      return await work();
    } catch (err) {
      this.refund(req, action);
      throw err;
    }
  }

  /** Current quota without consuming any. */
  peek(req: Request, action: QuotaAction): QuotaStatus {
    const key = this.keyFor(req, action);
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      bucket = { count: 0, windowStartedAt: now };
      this.buckets.set(key, bucket);
    }

    const limit = QUOTAS[action];
    return {
      action,
      used: bucket.count,
      limit,
      remaining: Math.max(0, limit - bucket.count),
      resetsAt: bucket.windowStartedAt + RATE_LIMIT_WINDOW_MS,
    };
  }

  allQuotas(req: Request): QuotaStatus[] {
    return (Object.keys(QUOTAS) as QuotaAction[]).map((action) => this.peek(req, action));
  }

  /**
   * Client identity. Behind a proxy the socket address is the proxy's, so the
   * left-most X-Forwarded-For entry is preferred when Express is configured to
   * trust the proxy.
   */
  private keyFor(req: Request, action: QuotaAction): string {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    const ip = (first ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown').trim();
    return `${action}:${ip}`;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStartedAt < cutoff) {
        this.buckets.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.logger.debug(`Evicted ${removed} expired quota buckets`);
  }
}
