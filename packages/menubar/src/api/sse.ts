import { createParser } from 'eventsource-parser';
import type { WorkflowEvent } from './types.js';

export type SseEventHandler = (event: WorkflowEvent) => void;
export type SseErrorHandler = (error: Error) => void;

export interface SseConnection {
  close: () => void;
}

/**
 * Connect to the SSE stream for a workflow using fetch + eventsource-parser.
 * Native EventSource does not support custom headers (needed for auth), so we
 * use fetch with a ReadableStream instead — the same pattern used by ChatGPT.
 */
export function connectWorkflowStream(
  baseUrl: string,
  apiKey: string,
  workflowId: string,
  onEvent: SseEventHandler,
  onError: SseErrorHandler,
  signal?: AbortSignal
): SseConnection {
  const abortController = new AbortController();

  // Forward external signal cancellation
  signal?.addEventListener('abort', () => abortController.abort());

  const url = `${baseUrl.replace(/\/$/, '')}/v1/workflows/${workflowId}/stream`;

  (async () => {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const parser = createParser((evt) => {
        if (evt.type === 'event' && evt.data) {
          try {
            const parsed = JSON.parse(evt.data) as WorkflowEvent;
            onEvent(parsed);
          } catch {
            // Ignore malformed JSON events
          }
        }
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    close: () => abortController.abort(),
  };
}
