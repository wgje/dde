import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import {
  ProjectSyncProbeService,
  type ProjectSyncProbeDependencies,
} from './project-sync-probe.service';

const EXPECTED_PROJECT_HEAD_PAGE_SIZE = 100;

describe('ProjectSyncProbeService project-head pagination', () => {
  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
  });

  it('loads bounded project-head pages with a deterministic composite cursor', async () => {
    const firstPage = Array.from({ length: EXPECTED_PROJECT_HEAD_PAGE_SIZE }, (_, index) => ({
      project_id: `project-${String(index).padStart(3, '0')}`,
      updated_at: '2026-07-16T08:00:00.000Z',
      version: index + 1,
    }));
    const secondPage = [{
      project_id: 'project-100',
      updated_at: '2026-07-16T08:00:00.000Z',
      version: 101,
    }];
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: secondPage, error: null });
    const context = createService(rpc);

    const result = await context.service.listProjectHeadsSince(
      '2026-07-16T07:00:00.000Z',
      '2026-07-16T09:00:00.000Z',
      context.dependencies,
    );

    expect(result).toHaveLength(101);
    expect(rpc).toHaveBeenNthCalledWith(1, 'list_project_heads_page', {
      p_since: '2026-07-16T07:00:00.000Z',
      p_until: '2026-07-16T09:00:00.000Z',
      p_after_updated_at: null,
      p_after_project_id: null,
      p_limit: EXPECTED_PROJECT_HEAD_PAGE_SIZE,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'list_project_heads_page', {
      p_since: '2026-07-16T07:00:00.000Z',
      p_until: '2026-07-16T09:00:00.000Z',
      p_after_updated_at: '2026-07-16T08:00:00.000Z',
      p_after_project_id: 'project-099',
      p_limit: EXPECTED_PROJECT_HEAD_PAGE_SIZE,
    });
  });

  it('returns null when a page fails so callers cannot advance the watermark', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'project head page failed' },
    });
    const context = createService(rpc);

    await expect(context.service.listProjectHeadsSince(
      '2026-07-16T07:00:00.000Z',
      '2026-07-16T09:00:00.000Z',
      context.dependencies,
    )).resolves.toBeNull();

    expect(context.logger.warn).toHaveBeenCalled();
  });
});

function createService(rpc: ReturnType<typeof vi.fn>) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const injector = Injector.create({
    providers: [
      ProjectSyncProbeService,
      { provide: LoggerService, useValue: { category: () => logger } },
    ],
  });
  const dependencies: ProjectSyncProbeDependencies = {
    getClient: vi.fn(async () => ({ rpc }) as never),
    withAuthRetry: vi.fn(async (_context: string, run: () => Promise<unknown>) => run()) as never,
  };

  return {
    service: runInInjectionContext(injector, () => injector.get(ProjectSyncProbeService)),
    dependencies,
    logger,
  };
}
