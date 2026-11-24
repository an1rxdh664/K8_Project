import { useCallback, useRef, useState } from 'react';

// ── SSE event types ───────────────────────────────────────────────────────────

export interface SSELogEvent {
  type: 'log';
  line: string;
}

export interface SSEProgressEvent {
  type: 'progress';
  step: string;
  pct: number;
}

export interface SSEDoneEvent {
  type: 'done';
  ok: boolean;
  exitCode?: number;
  detail?: string;
}

export interface SSEErrorEvent {
  type: 'error';
  message: string;
}

export type SSEEvent =
  | SSELogEvent
  | SSEProgressEvent
  | SSEDoneEvent
  | SSEErrorEvent;

// ── Hook state ────────────────────────────────────────────────────────────────

export interface UseSSEState {
  /** True while the SSE connection is open and the script is running. */
  running: boolean;
  /** Set if the EventSource itself failed to connect. */
  connectError: string | null;
  /** Accumulated log lines received so far. */
  lines: string[];
  /** Set to true when a done/error event arrives. */
  finished: boolean;
  /** True if the last run completed successfully. */
  succeeded: boolean | null;
}

export interface UseSSEReturn extends UseSSEState {
  /**
   * Open an SSE connection to `url`.
   * Calls `onEvent` for every parsed event (optional convenience callback).
   * Clears previous state before connecting.
   */
  start: (url: string, body?: Record<string, unknown>, onEvent?: (e: SSEEvent) => void) => void;
  /** Abort the current connection (if any). */
  abort: () => void;
  /** Reset state back to initial. */
  reset: () => void;
}

// ── Implementation ────────────────────────────────────────────────────────────

const INITIAL_STATE: UseSSEState = {
  running: false,
  connectError: null,
  lines: [],
  finished: false,
  succeeded: null,
};

/**
 * useSSE — consume a Server-Sent Events action endpoint.
 *
 * The backend streams events as:
 *   data: {"type":"log","line":"..."}
 *   data: {"type":"done","ok":true}
 *
 * Because SSE is GET-only natively, we use a small trick:
 *   1. POST the action body to `url` → get back a one-time stream token.
 *   2. Open EventSource on `url?token=<token>`.
 *
 * However, since our Express backend is same-origin (proxied by Next.js
 * rewrites), we just POST with fetch and read the response body as a
 * ReadableStream — this gives us identical streaming without the GET
 * limitation. The backend still sends `text/event-stream` headers.
 */
export function useSSE(): UseSSEReturn {
  const [state, setState] = useState<UseSSEState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((prev) => ({ ...prev, running: false }));
  }, []);

  const start = useCallback(
    (url: string, body?: Record<string, unknown>, onEvent?: (e: SSEEvent) => void) => {
      // Cancel any in-flight connection
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setState({
        running: true,
        connectError: null,
        lines: [],
        finished: false,
        succeeded: null,
      });

      (async () => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: ac.signal,
          });

          if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            throw new Error(`HTTP ${res.status}: ${text}`);
          }

          if (!res.body) {
            throw new Error('Response body is null — SSE not supported?');
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // SSE lines are separated by \n\n (double newline)
            // Each event looks like: "data: {...}\n\n"
            const parts = buffer.split('\n\n');
            // The last part may be incomplete — keep it in the buffer
            buffer = parts.pop() ?? '';

            for (const part of parts) {
              const dataLine = part
                .split('\n')
                .find((l) => l.startsWith('data: '));
              if (!dataLine) continue;

              const json = dataLine.slice('data: '.length).trim();
              if (!json) continue;

              let event: SSEEvent;
              try {
                event = JSON.parse(json) as SSEEvent;
              } catch {
                continue; // malformed line — skip
              }

              onEvent?.(event);

              if (event.type === 'log') {
                setState((prev) => ({
                  ...prev,
                  lines: [...prev.lines, event.line],
                }));
              } else if (event.type === 'progress') {
                // Progress updates don't change lines — consumers can read
                // the event via onEvent if they need the pct value.
              } else if (event.type === 'done') {
                setState((prev) => ({
                  ...prev,
                  running: false,
                  finished: true,
                  succeeded: event.ok,
                }));
              } else if (event.type === 'error') {
                setState((prev) => ({
                  ...prev,
                  running: false,
                  finished: true,
                  succeeded: false,
                  lines: [...prev.lines, `Error: ${event.message}`],
                }));
              }
            }
          }

          // Stream ended without explicit done — treat as success
          setState((prev) => {
            if (!prev.finished) {
              return { ...prev, running: false, finished: true, succeeded: true };
            }
            return prev;
          });
        } catch (err: unknown) {
          if ((err as { name?: string }).name === 'AbortError') {
            // Intentional abort — don't update state further
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          setState((prev) => ({
            ...prev,
            running: false,
            connectError: message,
            finished: true,
            succeeded: false,
          }));
        }
      })();
    },
    [],
  );

  return { ...state, start, abort, reset };
}
