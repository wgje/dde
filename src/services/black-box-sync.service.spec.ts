import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { BlackBoxSyncService } from './black-box-sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

describe('BlackBoxSyncService', () => {
  let service: BlackBoxSyncService;
  let initDbSpy: ReturnType<typeof vi.spyOn>;
  let setupNetworkSpy: ReturnType<typeof vi.spyOn>;
  let mockSentry: { addBreadcrumb: ReturnType<typeof vi.fn>; captureMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    initDbSpy = vi.spyOn(
      BlackBoxSyncService.prototype as unknown as { initIndexedDB: () => Promise<void> },
      'initIndexedDB'
    ).mockResolvedValue(undefined);
    setupNetworkSpy = vi.spyOn(
      BlackBoxSyncService.prototype as unknown as { setupNetworkListener: () => void },
      'setupNetworkListener'
    ).mockImplementation(() => {});

    mockSentry = {
      addBreadcrumb: vi.fn(),
      captureMessage: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        BlackBoxSyncService,
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn().mockResolvedValue({}),
          },
        },
        {
          provide: NetworkAwarenessService,
          useValue: {
            isOnline: vi.fn(() => true),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: mockSentry,
        },
      ],
    });

    service = TestBed.inject(BlackBoxSyncService);
  });

  afterEach(() => {
    initDbSpy.mockRestore();
    setupNetworkSpy.mockRestore();
  });

  it('should apply resume pull cooldown by default', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(undefined);

    await service.pullChanges({ reason: 'resume' });
    await service.pullChanges({ reason: 'resume' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
  });

  it('should bypass cooldown when force=true', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(undefined);

    await service.pullChanges({ reason: 'resume' });
    await service.pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).toHaveBeenCalledTimes(2);
  });

  it('should reuse in-flight pull promise (single-flight)', async () => {
    let resolvePull: (() => void) | null = null;
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockReturnValue(new Promise<void>(resolve => {
      resolvePull = resolve;
    }));

    const p1 = service.pullChanges({ reason: 'resume', force: true });
    const p2 = service.pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).toHaveBeenCalledTimes(1);

    resolvePull?.();
    await Promise.all([p1, p2]);
  });

  it('should block duplicate pull by freshness window and report to Sentry', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(undefined);

    // 首次拉取成功
    await service.pullChanges({ reason: 'manual', force: true });
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    // 窗口内第二次调用应被阻断
    await service.pullChanges({ reason: 'manual' });
    expect(doPullSpy).toHaveBeenCalledTimes(1);

    // 验证结构化 Sentry 上报
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'BlackBox duplicate pull blocked',
      expect.objectContaining({
        level: 'info',
        tags: expect.objectContaining({
          classification: 'duplicate_blocked',
        }),
      })
    );
  });

  it('should map focus_meta from database row into focusMeta', () => {
    const mapRowToEntry = (service as unknown as {
      mapRowToEntry: (row: Record<string, unknown>) => { focusMeta?: unknown };
    }).mapRowToEntry.bind(service);

    const mapped = mapRowToEntry({
      id: 'entry-1',
      project_id: null,
      user_id: 'user-1',
      content: 'inline detail',
      focus_meta: {
        source: 'focus-console-inline',
        sessionId: 'session-1',
        title: 'Inline task',
        detail: 'inline detail',
        lane: 'backup',
        expectedMinutes: 20,
        waitMinutes: 10,
        cognitiveLoad: 'low',
        dockEntryId: 'dock-entry-1',
      },
      date: '2026-03-04',
      created_at: '2026-03-04T00:00:00.000Z',
      updated_at: '2026-03-04T00:00:00.000Z',
      is_read: false,
      is_completed: false,
      is_archived: false,
      snooze_until: null,
      snooze_count: 0,
      deleted_at: null,
    });

    expect(mapped.focusMeta).toEqual({
      source: 'focus-console-inline',
      sessionId: 'session-1',
      title: 'Inline task',
      detail: 'inline detail',
      lane: 'backup',
      expectedMinutes: 20,
      waitMinutes: 10,
      cognitiveLoad: 'low',
      dockEntryId: 'dock-entry-1',
    });
  });
});
