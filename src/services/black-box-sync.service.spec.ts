import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { BlackBoxSyncService } from './black-box-sync.service';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { setBlackBoxEntries } from '../state/focus-stores';

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
            isOfflineMode: vi.fn(() => false),
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
          provide: AuthService,
          useValue: {
            currentUserId: vi.fn(() => 'user-1'),
            isConfigured: true,
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
    setBlackBoxEntries([]);
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

    resolvePull!();
    await Promise.all([p1, p2]);
  });

  it('should fall back to local cache when remote transport is marked unavailable', async () => {
    const supabase = TestBed.inject(SupabaseClientService) as unknown as {
      isOfflineMode: ReturnType<typeof vi.fn>;
    };
    supabase.isOfflineMode.mockReturnValue(true);

    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(undefined);
    const loadLocalSpy = vi.spyOn(
      service as unknown as { loadFromLocal: () => Promise<unknown[]> },
      'loadFromLocal'
    ).mockResolvedValue([]);

    await service.pullChanges({ reason: 'resume', force: true });

    expect(doPullSpy).not.toHaveBeenCalled();
    expect(loadLocalSpy).toHaveBeenCalledTimes(1);
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

  it('should not report passive view refresh duplicates to Sentry', async () => {
    const doPullSpy = vi.spyOn(
      service as unknown as { doPullChanges: () => Promise<void> },
      'doPullChanges'
    ).mockResolvedValue(undefined);

    await service.pullChanges({ reason: 'panel-open', force: true });
    mockSentry.captureMessage.mockClear();

    await service.pullChanges({ reason: 'panel-open' });

    expect(doPullSpy).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
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

  it('loadFromLocal 应只恢复当前用户的黑匣子条目', async () => {
    const foreignEntry = {
      id: 'entry-foreign',
      projectId: null,
      userId: 'user-2',
      content: 'foreign',
      date: '2026-03-04',
      createdAt: '2026-03-04T00:00:00.000Z',
      updatedAt: '2026-03-04T00:00:00.000Z',
      isRead: false,
      isCompleted: false,
      isArchived: false,
      deletedAt: null,
    };
    const ownEntry = {
      ...foreignEntry,
      id: 'entry-own',
      userId: 'user-1',
      content: 'own',
    };
    const getAll = vi.fn();
    const transaction = vi.fn(() => ({
      objectStore: vi.fn(() => ({
        getAll: () => {
          const request = {
            result: [ownEntry, foreignEntry],
            onsuccess: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
            onerror: null as ((this: IDBRequest<unknown[]>, ev: Event) => unknown) | null,
          };
          queueMicrotask(() => request.onsuccess?.call(request as unknown as IDBRequest<unknown[]>, new Event('success')));
          getAll();
          return request;
        },
      })),
    }));
    (service as unknown as { db: unknown }).db = { transaction };

    const entries = await service.loadFromLocal();

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([expect.objectContaining({ id: 'entry-own', userId: 'user-1' })]);
  });
});
