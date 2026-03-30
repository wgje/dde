export interface StartupTraceEvent {
  seq: number;
  event: string;
  at: string;
  monotonicMs: number;
  data: Record<string, unknown> | null;
}

const MAX_TRACE_EVENTS = 200;

function createTraceEvent(
  seq: number,
  event: string,
  data?: Record<string, unknown>
): StartupTraceEvent {
  const monotonicMs =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  return {
    seq,
    event,
    at: new Date().toISOString(),
    monotonicMs,
    data: data ?? null,
  };
}

export function pushStartupTrace(event: string, data?: Record<string, unknown>): void {
  if (typeof window === 'undefined') {
    return;
  }

  const delegatedPush = window.__NANOFLOW_PUSH_STARTUP_TRACE__;
  if (typeof delegatedPush === 'function') {
    delegatedPush(event, data);
    return;
  }

  const records = window.__NANOFLOW_STARTUP_TRACE__ ?? [];
  const next = [...records, createTraceEvent(records.length + 1, event, data)];
  window.__NANOFLOW_STARTUP_TRACE__ = next.slice(-MAX_TRACE_EVENTS);
}
