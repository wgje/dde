import { afterEach, describe, expect, it, vi } from 'vitest';

describe('startup-trace', () => {
  afterEach(() => {
    delete (window as Window & {
      __NANOFLOW_STARTUP_TRACE__?: unknown;
      __NANOFLOW_PUSH_STARTUP_TRACE__?: unknown;
    }).__NANOFLOW_STARTUP_TRACE__;
    delete (window as Window & {
      __NANOFLOW_STARTUP_TRACE__?: unknown;
      __NANOFLOW_PUSH_STARTUP_TRACE__?: unknown;
    }).__NANOFLOW_PUSH_STARTUP_TRACE__;
    vi.resetModules();
  });

  it('应在无全局 push 函数时回退写入 trace 数组', async () => {
    const { pushStartupTrace } = await import('./startup-trace');

    pushStartupTrace('boot.stage', { stage: 'launch-shell' });

    const records = (
      window as Window & {
        __NANOFLOW_STARTUP_TRACE__?: Array<{
          event: string;
          seq: number;
          data?: Record<string, unknown> | null;
        }>;
      }
    ).__NANOFLOW_STARTUP_TRACE__;

    expect(records).toHaveLength(1);
    expect(records?.[0]).toEqual(
      expect.objectContaining({
        event: 'boot.stage',
        seq: 1,
        data: { stage: 'launch-shell' },
      })
    );
  });

  it('应优先委托给 index 注入的全局 push 函数', async () => {
    const pushSpy = vi.fn();
    (
      window as Window & {
        __NANOFLOW_PUSH_STARTUP_TRACE__?: (event: string, data?: Record<string, unknown>) => void;
      }
    ).__NANOFLOW_PUSH_STARTUP_TRACE__ = pushSpy;

    const { pushStartupTrace } = await import('./startup-trace');
    pushStartupTrace('auth.bootstrap', { status: 'started' });

    expect(pushSpy).toHaveBeenCalledWith('auth.bootstrap', { status: 'started' });
    expect(
      (window as Window & { __NANOFLOW_STARTUP_TRACE__?: unknown[] }).__NANOFLOW_STARTUP_TRACE__ ?? []
    ).toHaveLength(0);
  });
});
