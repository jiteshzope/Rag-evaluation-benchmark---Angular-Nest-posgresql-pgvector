import { computed, inject, Injectable, signal } from '@angular/core';

import { ApiService } from '../api/api.service';
import type { MetaResponse } from '../api/types';

/**
 * The server's description of itself: strategies, limits, quotas and what the
 * demo corpus holds.
 *
 * Fetched once at start-up and refreshed after anything that spends quota, which
 * is the whole of what React Query was doing for this app — one query, one
 * invalidation key.
 */
@Injectable({ providedIn: 'root' })
export class MetaStore {
  private readonly api = inject(ApiService);

  readonly data = signal<MetaResponse | null>(null);
  readonly error = signal<Error | null>(null);
  private readonly inFlight = signal(false);

  readonly isLoading = computed(() => this.inFlight() && this.data() === null);
  readonly isError = computed(() => this.error() !== null && this.data() === null);

  async load(): Promise<void> {
    if (this.inFlight()) return;
    this.inFlight.set(true);
    try {
      this.data.set(await this.api.meta());
      this.error.set(null);
    } catch (err) {
      this.error.set(err as Error);
    } finally {
      this.inFlight.set(false);
    }
  }

  /** Re-reads meta after an action that changed quotas or the seeded corpus. */
  refresh(): void {
    void this.load();
  }
}
