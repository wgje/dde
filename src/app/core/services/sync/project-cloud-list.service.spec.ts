import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import {
  createBrowserNetworkSuspendedError,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../../../../utils/browser-network-suspension';
import { ProjectCloudListService, type ProjectCloudListDependencies } from './project-cloud-list.service';
import { SyncStateService } from './sync-state.service';

describe('ProjectCloudListService runtime boundaries', () => {
  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
  });

  it('marks remote loading before awaiting Supabase client acquisition', async () => {
    const client = createDeferred<null>();
    const context = createService();
    const pending = context.service.loadProjectsFromCloud('user-1', {
      ...createDependencies(),
      getClient: vi.fn(() => client.promise),
    });

    expect(context.setLoadingRemote).toHaveBeenCalledWith(true);

    client.resolve(null);
    await expect(pending).resolves.toBeNull();
    expect(context.setLoadingRemote.mock.calls).toEqual([[true], [false]]);
  });

  it('treats browser suspension during metadata load as a quiet soft failure', async () => {
    const context = createService();
    context.execute.mockRejectedValue(createBrowserNetworkSuspendedError());

    await expect(context.service.loadProjectListMetadataFromCloud(
      'user-1',
      {},
      createDependencies(),
    )).resolves.toBeNull();

    expect(context.logger.debug).toHaveBeenCalled();
    expect(context.logger.warn).not.toHaveBeenCalled();
    expect(context.captureException).not.toHaveBeenCalled();
  });
});

function createDependencies(): ProjectCloudListDependencies {
  return {
    getClient: vi.fn(async () => ({}) as never),
    withAuthRetry: vi.fn(async (_context: string, run: () => Promise<unknown>) => run()) as never,
    rowToProject: vi.fn() as never,
    loadFullProjectOptimized: vi.fn(async () => null),
    isTransientMetadataLoadFailure: vi.fn(() => false),
  };
}

function createService() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const execute = vi.fn();
  const setLoadingRemote = vi.fn();
  const captureException = vi.fn();
  const injector = Injector.create({
    providers: [
      ProjectCloudListService,
      { provide: LoggerService, useValue: { category: () => logger } },
      { provide: RequestThrottleService, useValue: { execute } },
      { provide: SyncStateService, useValue: { setLoadingRemote } },
      { provide: SentryLazyLoaderService, useValue: { captureException } },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(ProjectCloudListService)),
    logger,
    execute,
    setLoadingRemote,
    captureException,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}
