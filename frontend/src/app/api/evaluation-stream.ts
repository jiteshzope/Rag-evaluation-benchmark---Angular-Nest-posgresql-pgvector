import { DestroyRef, effect, inject, Signal } from '@angular/core';

import { eventsUrl } from './api.service';
import type { EvaluationEvent } from './types';

/**
 * Subscribes to a run's SSE stream for as long as `enabled` is true.
 *
 * The backend replays its buffered event log to every new subscriber, so a
 * client that connects a moment after POST /run still sees the indexing phase.
 * That makes reconnection safe: the store's `applyEvent` is written so replayed
 * events are idempotent for summaries, and per-question results are
 * de-duplicated here.
 *
 * Call this from an injection context — it wires an effect that opens and closes
 * the connection as the two signals change, and tears down with its owner.
 */
export function connectEvaluationStream(
  experimentId: Signal<string | null>,
  enabled: Signal<boolean>,
  onEvent: (event: EvaluationEvent) => void,
): void {
  const destroyRef = inject(DestroyRef);
  let source: EventSource | null = null;

  const close = () => {
    source?.close();
    source = null;
  };

  effect((onCleanup) => {
    const id = experimentId();
    const active = enabled();

    if (!id || !active) return;

    source = new EventSource(eventsUrl(id));
    const stream = source;
    const seenQuestions = new Set<string>();

    stream.onmessage = (message) => {
      let event: EvaluationEvent;
      try {
        event = JSON.parse(message.data) as EvaluationEvent;
      } catch {
        return;
      }

      // A replayed 'question' event would otherwise duplicate a table row.
      if (event.type === 'question') {
        const key = `${event.strategy}:${event.result.itemId}`;
        if (seenQuestions.has(key)) return;
        seenQuestions.add(key);
      }

      onEvent(event);

      if (event.type === 'complete' || event.type === 'error') {
        stream.close();
      }
    };

    stream.onerror = () => {
      // The server closes the stream when the run finishes, which surfaces here
      // as an error. The 'complete' event has already been delivered, so simply
      // close rather than reporting a failure the user cannot act on.
      stream.close();
    };

    onCleanup(() => stream.close());
  });

  destroyRef.onDestroy(close);
}
