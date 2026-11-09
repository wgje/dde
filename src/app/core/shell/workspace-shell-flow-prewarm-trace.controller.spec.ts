import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WorkspaceShellFlowPrewarmTraceController,
  type FlowPrewarmTraceEvent,
} from './workspace-shell-flow-prewarm-trace.controller';

const TRACE_KEY = '__NANOFLOW_FLOW_PREWARM_TRACE__';

describe('WorkspaceShellFlowPrewarmTraceController', () => {
  let previousDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, TRACE_KEY);
    Reflect.deleteProperty(globalThis, TRACE_KEY);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, TRACE_KEY);
    if (previousDescriptor) {
      Object.defineProperty(globalThis, TRACE_KEY, previousDescriptor);
    }
  });

  it('appends status transitions with their reason and timestamp', () => {
    const initialEvent: FlowPrewarmTraceEvent = {
      status: 'idle',
      reason: 'initial',
      at: 1,
    };
    Reflect.set(globalThis, TRACE_KEY, [initialEvent]);
    const controller = new WorkspaceShellFlowPrewarmTraceController();

    controller.record('scheduled', 'text-ready');

    const trace = Reflect.get(globalThis, TRACE_KEY) as FlowPrewarmTraceEvent[];
    expect(trace.slice(0, 1)).toEqual([initialEvent]);
    expect(trace[1]).toMatchObject({
      status: 'scheduled',
      reason: 'text-ready',
    });
    expect(Number.isFinite(trace[1]?.at)).toBe(true);
  });

  it('replaces malformed trace state', () => {
    Reflect.set(globalThis, TRACE_KEY, 'malformed');
    const controller = new WorkspaceShellFlowPrewarmTraceController();

    controller.record('loading', 'retry');

    expect(Reflect.get(globalThis, TRACE_KEY)).toEqual([
      expect.objectContaining({
        status: 'loading',
        reason: 'retry',
      }),
    ]);
  });

  it('does not surface trace storage failures', () => {
    Object.defineProperty(globalThis, TRACE_KEY, {
      configurable: true,
      get: () => [],
      set: () => {
        throw new Error('trace storage failed');
      },
    });
    const controller = new WorkspaceShellFlowPrewarmTraceController();

    expect(() => controller.record('failed', 'retry')).not.toThrow();
  });
});
