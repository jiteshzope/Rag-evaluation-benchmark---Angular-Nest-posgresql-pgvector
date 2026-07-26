import { Injectable } from '@angular/core';

import { environment } from '../../environments/environment';
import type {
  DatasetInfo,
  EvaluationItem,
  Experiment,
  KnowledgeBaseInfo,
  MetaResponse,
  QuestionResult,
  QuotaStatus,
  StrategyId,
  StrategySummary,
} from './types';

/**
 * Origin of the API, with no trailing slash.
 *
 * A run-time override on `window` wins over the build-time constant, so a single
 * bundle can be re-pointed at another backend by editing `index.html` — useful
 * for a preview deployment that has to talk to a staging API.
 */
function resolveOrigin(): string {
  const runtime = (globalThis as Record<string, unknown>)['__RAGBENCH_API_BASE_URL__'];
  const value =
    typeof runtime === 'string' && runtime.length > 0 ? runtime : environment.apiBaseUrl;
  return value.replace(/\/+$/, '');
}

const BASE = `${resolveOrigin()}/api`;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly quota?: QuotaStatus,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let quota: QuotaStatus | undefined;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
      if (body?.quota) quota = body.quota;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(response.status, message, quota);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  meta(): Promise<MetaResponse> {
    return request<MetaResponse>('/meta');
  }

  quotas(): Promise<{ quotas: QuotaStatus[] }> {
    return request<{ quotas: QuotaStatus[] }>('/quotas');
  }

  createExperiment(body: {
    strategies: StrategyId[];
    useDefaultKnowledgeBase?: boolean;
    useDefaultDataset?: boolean;
    questionCount?: number;
  }): Promise<Experiment> {
    return request<Experiment>('/experiments', { method: 'POST', body: JSON.stringify(body) });
  }

  getExperiment(id: string): Promise<Experiment> {
    return request<Experiment>(`/experiments/${id}`);
  }

  /** Pushes the current strategy selection onto an experiment already created. */
  setStrategies(id: string, strategies: StrategyId[]): Promise<{ strategies: StrategyId[] }> {
    return request<{ strategies: StrategyId[] }>(`/experiments/${id}/strategies`, {
      method: 'PATCH',
      body: JSON.stringify({ strategies }),
    });
  }

  deleteExperiment(id: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(`/experiments/${id}`, { method: 'DELETE' });
  }

  // ── Knowledge base ────────────────────────────────────────────────────────

  uploadKnowledgeBase(
    id: string,
    file: File,
  ): Promise<{ knowledgeBase: KnowledgeBaseInfo; quotas: QuotaStatus[] }> {
    const form = new FormData();
    form.append('file', file);
    return request<{ knowledgeBase: KnowledgeBaseInfo; quotas: QuotaStatus[] }>(
      `/experiments/${id}/knowledge-base`,
      { method: 'POST', body: form },
    );
  }

  setKnowledgeBaseText(
    id: string,
    text: string,
    title?: string,
  ): Promise<{ knowledgeBase: KnowledgeBaseInfo; quotas: QuotaStatus[] }> {
    return request<{ knowledgeBase: KnowledgeBaseInfo; quotas: QuotaStatus[] }>(
      `/experiments/${id}/knowledge-base/text`,
      { method: 'POST', body: JSON.stringify({ text, title }) },
    );
  }

  useDefaultKnowledgeBase(id: string): Promise<{ knowledgeBase: KnowledgeBaseInfo }> {
    return request<{ knowledgeBase: KnowledgeBaseInfo }>(
      `/experiments/${id}/knowledge-base/default`,
      { method: 'POST' },
    );
  }

  // ── Dataset ───────────────────────────────────────────────────────────────

  setDataset(id: string, content: string): Promise<{ dataset: DatasetInfo }> {
    return request<{ dataset: DatasetInfo }>(`/experiments/${id}/dataset`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  uploadDataset(id: string, file: File): Promise<{ dataset: DatasetInfo }> {
    const form = new FormData();
    form.append('file', file);
    return request<{ dataset: DatasetInfo }>(`/experiments/${id}/dataset/upload`, {
      method: 'POST',
      body: form,
    });
  }

  useDefaultDataset(id: string, count: number): Promise<{ dataset: DatasetInfo }> {
    return request<{ dataset: DatasetInfo }>(`/experiments/${id}/dataset/default?count=${count}`, {
      method: 'POST',
    });
  }

  generateDataset(
    id: string,
    count: number,
  ): Promise<{ dataset: DatasetInfo; items: EvaluationItem[]; quotas: QuotaStatus[] }> {
    return request<{ dataset: DatasetInfo; items: EvaluationItem[]; quotas: QuotaStatus[] }>(
      `/experiments/${id}/dataset/generate`,
      { method: 'POST', body: JSON.stringify({ count }) },
    );
  }

  getDataset(id: string): Promise<{ dataset: DatasetInfo | null; items: EvaluationItem[] }> {
    return request<{ dataset: DatasetInfo | null; items: EvaluationItem[] }>(
      `/experiments/${id}/dataset`,
    );
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  run(id: string): Promise<{
    status: string;
    strategies: StrategyId[];
    questionCount: number;
    quotas: QuotaStatus[];
  }> {
    return request(`/experiments/${id}/run`, { method: 'POST' });
  }

  cancel(id: string): Promise<{ cancelled: boolean }> {
    return request<{ cancelled: boolean }>(`/experiments/${id}/cancel`, { method: 'POST' });
  }

  // ── Results ───────────────────────────────────────────────────────────────

  results(id: string): Promise<{
    status: string;
    error?: string;
    summaries: StrategySummary[];
    durationMs?: number;
    totalCostUsd: number;
  }> {
    return request(`/experiments/${id}/results`);
  }

  questionResults(id: string, strategy?: StrategyId): Promise<{ results: QuestionResult[] }> {
    return request<{ results: QuestionResult[] }>(
      `/experiments/${id}/results/questions${strategy ? `?strategy=${strategy}` : ''}`,
    );
  }
}

/** SSE URL for a run's live progress. */
export function eventsUrl(id: string): string {
  return `${BASE}/experiments/${id}/events`;
}
