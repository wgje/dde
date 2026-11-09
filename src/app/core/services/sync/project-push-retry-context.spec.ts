import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../../models';
import type { DurableRetryHandler } from './project-push.types';
import {
  createProjectPushRetryContext,
  enqueueProjectPushRetry,
} from './project-push-retry-context';

function createProject(id = 'project-retry-context'): Project {
  return { id } as Project;
}

describe('project push retry context', () => {
  it('keeps compact durable retry arguments when no optional retry metadata exists', async () => {
    const durableRetryHandler = vi.fn<DurableRetryHandler>().mockResolvedValue(true);

    const result = await enqueueProjectPushRetry({
      durableRetryHandler,
      project: createProject(),
      fromRetryQueue: false,
      sourceUserId: 'user-1',
      taskIdsToDelete: ['task-delete'],
    });

    expect(result).toBe(true);
    expect(durableRetryHandler).toHaveBeenCalledWith(
      'project',
      'upsert',
      expect.objectContaining({ id: 'project-retry-context' }),
      undefined,
      'user-1',
      ['task-delete'],
      undefined,
    );
    expect(durableRetryHandler.mock.calls[0]).toHaveLength(7);
  });

  it('preserves operationId when task delete base metadata is absent', async () => {
    const durableRetryHandler = vi.fn<DurableRetryHandler>().mockResolvedValue(true);

    await enqueueProjectPushRetry({
      durableRetryHandler,
      project: createProject('project-operation-id'),
      fromRetryQueue: false,
      operationId: 'op-1',
    });

    expect(durableRetryHandler.mock.calls[0]).toEqual([
      'project',
      'upsert',
      expect.objectContaining({ id: 'project-operation-id' }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'op-1',
    ]);
  });

  it('passes unknown remote outcome failure context to durable retry handler', async () => {
    const durableRetryHandler = vi.fn<DurableRetryHandler>().mockResolvedValue(true);
    const retryContext = createProjectPushRetryContext({
      durableRetryHandler,
      project: createProject('project-timeout-unknown-outcome'),
      fromRetryQueue: false,
      sourceUserId: 'user-timeout',
      operationId: 'op-timeout',
    });
    const lastFailure = {
      errorType: 'TimeoutError',
      message: '请求超时 (30000ms): push-project',
      remoteOutcome: 'unknown' as const,
      recordedAt: 1_000,
    };

    const enqueueRetry = retryContext.enqueueRetry as unknown as (failure: typeof lastFailure) => Promise<boolean>;
    await enqueueRetry(lastFailure);

    expect(durableRetryHandler.mock.calls[0]).toEqual([
      'project',
      'upsert',
      expect.objectContaining({ id: 'project-timeout-unknown-outcome' }),
      undefined,
      'user-timeout',
      undefined,
      undefined,
      undefined,
      'op-timeout',
      lastFailure,
    ]);
  });

  it('tracks retryEnqueued without re-enqueueing items that already came from the retry queue', async () => {
    const durableRetryHandler = vi.fn<DurableRetryHandler>().mockResolvedValue(true);
    const retryContext = createProjectPushRetryContext({
      durableRetryHandler,
      project: createProject(),
      fromRetryQueue: true,
    });

    expect(await retryContext.enqueueRetry()).toBe(false);
    expect(retryContext.retryEnqueued).toBe(false);
    expect(durableRetryHandler).not.toHaveBeenCalled();
  });
});
