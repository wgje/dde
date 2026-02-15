import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDataService } from './project-data.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';

describe('ProjectDataService', () => {
  it('P0001 Access Denied 时不应 fallback 到 loadFullProject', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'Access denied',
      },
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const fallbackSpy = vi.spyOn(
      service as unknown as { loadFullProject: (projectId: string) => Promise<unknown> },
      'loadFullProject'
    ).mockResolvedValue(null);

    const result = await service.loadFullProjectOptimized('proj-denied');

    expect(result).toBeNull();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('getProjectSyncWatermark 应返回远端聚合水位', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: '2026-02-14T08:10:00.000Z',
      error: null,
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const watermark = await service.getProjectSyncWatermark('proj-1');

    expect(rpc).toHaveBeenCalledWith('get_project_sync_watermark', { p_project_id: 'proj-1' });
    expect(watermark).toBe('2026-02-14T08:10:00.000Z');
  });
});
