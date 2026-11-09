export type FlowPrewarmStatus = 'idle' | 'scheduled' | 'loading' | 'ready' | 'failed';

export interface FlowPrewarmTraceEvent {
  status: FlowPrewarmStatus;
  reason: string;
  at: number;
}

export class WorkspaceShellFlowPrewarmTraceController {
  record(status: FlowPrewarmStatus, reason: string): void {
    try {
      const target = globalThis as typeof globalThis & {
        __NANOFLOW_FLOW_PREWARM_TRACE__?: FlowPrewarmTraceEvent[];
      };
      const records = Array.isArray(target.__NANOFLOW_FLOW_PREWARM_TRACE__)
        ? target.__NANOFLOW_FLOW_PREWARM_TRACE__
        : [];
      target.__NANOFLOW_FLOW_PREWARM_TRACE__ = [
        ...records,
        {
          status,
          reason,
          at: typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now(),
        },
      ];
    } catch {
      // E2E trace only; never affect production behavior.
    }
  }
}
