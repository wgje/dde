import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeRemoteChangeDedupController } from './realtime-remote-change-dedup.controller';

describe('RealtimeRemoteChangeDedupController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks duplicate remote changes while the first matching key is active', () => {
    const dedup = new RealtimeRemoteChangeDedupController(1000);
    const payload = { eventType: 'reconnect', projectId: 'project-1' };

    const first = dedup.begin(payload);
    const duplicate = dedup.begin(payload);

    expect(first.status).toBe('started');
    expect(duplicate.status).toBe('active-duplicate');

    if (first.status === 'started') {
      dedup.finish(first.key);
    }

    expect(dedup.begin(payload).status).toBe('started');
  });

  it('blocks recently completed remote changes until the dedup window expires', async () => {
    vi.useFakeTimers();
    const dedup = new RealtimeRemoteChangeDedupController(1000);
    const payload = { eventType: 'reconnect', projectId: 'project-2' };

    const first = dedup.begin(payload);
    expect(first.status).toBe('started');
    if (first.status === 'started') {
      dedup.markRecent(first.key);
      dedup.finish(first.key);
    }

    expect(dedup.begin(payload).status).toBe('recent-duplicate');

    await vi.advanceTimersByTimeAsync(1000);

    expect(dedup.begin(payload).status).toBe('started');
  });

  it('clears active and recent state', () => {
    vi.useFakeTimers();
    const dedup = new RealtimeRemoteChangeDedupController(1000);
    const payload = { eventType: 'manual', projectId: 'project-3' };

    const first = dedup.begin(payload);
    expect(first.status).toBe('started');
    if (first.status === 'started') {
      dedup.markRecent(first.key);
    }

    dedup.clear();

    expect(dedup.begin(payload).status).toBe('started');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restore recent state after clear while a remote change is still running', async () => {
    vi.useFakeTimers();
    const dedup = new RealtimeRemoteChangeDedupController(1000);
    const payload = { eventType: 'reconnect', projectId: 'project-clear-race' };
    let finishRemoteChange!: () => void;
    const running = dedup.run(payload, {
      callback: () => new Promise<void>(resolve => {
        finishRemoteChange = resolve;
      }),
      failureMessage: 'remote change failed',
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    });

    expect(dedup.begin(payload).status).toBe('active-duplicate');

    dedup.clear();
    finishRemoteChange();
    await expect(running).resolves.toBe(true);

    expect(dedup.begin(payload).status).toBe('started');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a cleared stale run release a newer active run for the same key', async () => {
    const dedup = new RealtimeRemoteChangeDedupController(1000);
    const payload = { eventType: 'reconnect', projectId: 'project-active-race' };
    let finishStaleRun!: () => void;
    let finishCurrentRun!: () => void;
    const staleRun = dedup.run(payload, {
      callback: () => new Promise<void>(resolve => {
        finishStaleRun = resolve;
      }),
      failureMessage: 'stale run failed',
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    });

    dedup.clear();

    const currentRun = dedup.run(payload, {
      callback: () => new Promise<void>(resolve => {
        finishCurrentRun = resolve;
      }),
      failureMessage: 'current run failed',
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    });

    finishStaleRun();
    await expect(staleRun).resolves.toBe(true);

    expect(dedup.begin(payload).status).toBe('active-duplicate');

    finishCurrentRun();
    await expect(currentRun).resolves.toBe(true);
    dedup.clear();
  });

  it('keeps duplicate-trigger logging failures from rejecting the run', async () => {
    const dedup = new RealtimeRemoteChangeDedupController(1000);
    const payload = { eventType: 'reconnect', projectId: 'project-4' };
    let releaseActiveRun!: () => void;
    const duplicateCallback = vi.fn();
    const logger = {
      debug: vi.fn(() => {
        throw new Error('debug sink failed');
      }),
      warn: vi.fn(),
    };

    const activeRun = dedup.run(payload, {
      callback: () => new Promise<void>(resolve => {
        releaseActiveRun = resolve;
      }),
      failureMessage: 'active run failed',
      logger,
    });

    await expect(dedup.run(payload, {
      callback: duplicateCallback,
      failureMessage: 'duplicate run failed',
      logger,
    })).resolves.toBe(false);

    expect(duplicateCallback).not.toHaveBeenCalled();

    releaseActiveRun();
    await expect(activeRun).resolves.toBe(true);
    dedup.clear();
  });

  it('returns false and releases the active key when callback and warning sink both fail', async () => {
    const dedup = new RealtimeRemoteChangeDedupController(1000);
    const payload = { eventType: 'manual', projectId: 'project-5' };
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('warn sink failed');
      }),
    };

    await expect(dedup.run(payload, {
      callback: () => {
        throw new Error('remote sync failed');
      },
      failureMessage: 'remote change failed',
      logger,
    })).resolves.toBe(false);

    const retryCallback = vi.fn();
    await expect(dedup.run(payload, {
      callback: retryCallback,
      failureMessage: 'retry failed',
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    })).resolves.toBe(true);

    expect(retryCallback).toHaveBeenCalledOnce();
    dedup.clear();
  });
});
