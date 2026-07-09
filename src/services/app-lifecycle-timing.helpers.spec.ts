import { afterEach, describe, expect, it, vi } from 'vitest';

import { withLifecycleTimeout } from './app-lifecycle-timing.helpers';

describe('app-lifecycle timing helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears lifecycle timeout even when the browser returns timer handle 0', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      _handler: TimerHandler,
      _timeout?: number,
      ..._arguments: unknown[]
    ) => 0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await expect(withLifecycleTimeout(Promise.resolve('ready'), 1000)).resolves.toBe('ready');

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });
});
