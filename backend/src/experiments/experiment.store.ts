import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';
import * as crypto from 'crypto';

import { EXPERIMENT_TTL_MS, MAX_LIVE_EXPERIMENTS } from '../config/limits';
import { EvaluationEvent, ExperimentContext } from './experiment.types';

/**
 * In-memory experiment registry.
 *
 * Deliberately not a database. An experiment holds an uploaded corpus, its
 * chunks and its vectors; keeping that only in process memory means a visitor's
 * document is never written to disk and disappears on eviction. The TTL sweep
 * and the capacity cap bound RSS so a burst of uploads cannot exhaust memory.
 */
@Injectable()
export class ExperimentStore implements OnModuleDestroy {
  private readonly logger = new Logger(ExperimentStore.name);
  private readonly experiments = new Map<string, ExperimentContext>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.evictExpired(), 60_000);
    // Never hold the process open just for the sweeper.
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
    for (const experiment of this.experiments.values()) experiment.events.complete();
    this.experiments.clear();
  }

  create(): ExperimentContext {
    this.evictExpired();
    this.enforceCapacity();

    const experiment: ExperimentContext = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      lastTouchedAt: Date.now(),
      status: 'created',
      strategies: [],
      documents: [],
      knowledgeBase: null,
      dataset: [],
      datasetInfo: null,
      results: new Map(),
      summaries: new Map(),
      events: new Subject<EvaluationEvent>(),
      eventLog: [],
      cancelled: false,
    };

    this.experiments.set(experiment.id, experiment);
    this.logger.log(`Experiment ${experiment.id} created (${this.experiments.size} live)`);
    return experiment;
  }

  get(id: string): ExperimentContext {
    const experiment = this.experiments.get(id);
    if (!experiment) {
      // Nothing the user did wrong, so the message leads with what happened
      // rather than with an internal id they never chose.
      throw new NotFoundException(
        `This evaluation session has expired. Sessions live in memory only — they are dropped ` +
          `after ${Math.round(EXPERIMENT_TTL_MS / 60000)} minutes of inactivity, and whenever ` +
          `the server restarts. Your selections are still on screen; start the run again to ` +
          `set up a fresh session.`,
      );
    }
    experiment.lastTouchedAt = Date.now();
    return experiment;
  }

  has(id: string): boolean {
    return this.experiments.has(id);
  }

  /** Publish an event to subscribers and record it for late joiners. */
  emit(experiment: ExperimentContext, event: EvaluationEvent): void {
    experiment.lastTouchedAt = Date.now();
    experiment.eventLog.push(event);
    // Per-question events dominate the log; cap it so a 100-question,
    // 3-strategy run cannot grow without bound.
    if (experiment.eventLog.length > 1200) experiment.eventLog.shift();
    experiment.events.next(event);
  }

  delete(id: string): void {
    const experiment = this.experiments.get(id);
    if (!experiment) return;
    experiment.cancelled = true;
    experiment.events.complete();
    this.experiments.delete(id);
    this.logger.log(`Experiment ${id} deleted`);
  }

  get liveCount(): number {
    return this.experiments.size;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - EXPERIMENT_TTL_MS;
    for (const [id, experiment] of this.experiments) {
      if (experiment.lastTouchedAt < cutoff) {
        this.logger.log(`Evicting expired experiment ${id}`);
        experiment.events.complete();
        this.experiments.delete(id);
      }
    }
  }

  /** Drop the least recently touched experiments that are not mid-run. */
  private enforceCapacity(): void {
    if (this.experiments.size < MAX_LIVE_EXPERIMENTS) return;

    const evictable = [...this.experiments.entries()]
      .filter(([, e]) => e.status !== 'evaluating' && e.status !== 'indexing')
      .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);

    const toEvict = this.experiments.size - MAX_LIVE_EXPERIMENTS + 1;
    for (const [id, experiment] of evictable.slice(0, toEvict)) {
      this.logger.log(`Evicting experiment ${id} to stay under the capacity cap`);
      experiment.events.complete();
      this.experiments.delete(id);
    }
  }
}
