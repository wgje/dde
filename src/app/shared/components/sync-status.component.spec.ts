import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncStatusComponent } from './sync-status.component';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';
import type { QueuedAction, DeadLetterItem } from '../../../services/action-queue.types';

function createQueuedAction(entityType: QueuedAction['entityType']): QueuedAction {
  const now = Date.now();

  return {
    id: `${entityType}-action`,
    type: 'update',
    entityType,
    entityId: `${entityType}-1`,
    payload: {} as unknown as QueuedAction['payload'],
    timestamp: now,
    retryCount: 0,
    priority: entityType === 'focus-session' ? 'critical' : 'normal',
  };
}

describe('SyncStatusComponent', () => {
  let fixture: ComponentFixture<SyncStatusComponent>;
  const pendingActions = signal<QueuedAction[]>([]);
  const deadLetters = signal<DeadLetterItem[]>([]);
  const queueFrozen = signal(false);
  const syncState = signal({
    isSyncing: false,
    isOnline: true,
    offlineMode: false,
    sessionExpired: false,
    lastSyncTime: null as string | null,
    pendingCount: 0,
    syncError: null as string | null,
    hasConflict: false,
    conflictData: null,
  });
  const currentUserId = signal('user-1');
  const conflictCount = signal(0);
  const hasUnresolvedConflicts = signal(false);
  const isLoadingRemote = signal(false);
  const activeProjectId = signal('project-1');
  const legacyReviewCount = signal(0);

  const actionQueueMock = {
    pendingActions,
    queueSize: computed(() => pendingActions().length),
    deadLetterQueue: deadLetters,
    deadLetterSize: computed(() => deadLetters().length),
    queueFrozen,
    isProcessing: signal(false),
    processQueue: vi.fn().mockResolvedValue({ processed: 0, failed: 0, movedToDeadLetter: 0 }),
    retryDeadLetter: vi.fn(),
    dismissDeadLetter: vi.fn(),
    clearDeadLetterQueue: vi.fn(),
    downloadEscapeExport: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    pendingActions.set([]);
    deadLetters.set([]);
    queueFrozen.set(false);
    syncState.set({
      isSyncing: false,
      isOnline: true,
      offlineMode: false,
      sessionExpired: false,
      lastSyncTime: null,
      pendingCount: 0,
      syncError: null,
      hasConflict: false,
      conflictData: null,
    });
    currentUserId.set('user-1');
    conflictCount.set(0);
    hasUnresolvedConflicts.set(false);
    isLoadingRemote.set(false);
    activeProjectId.set('project-1');
    legacyReviewCount.set(0);

    await TestBed.configureTestingModule({
      imports: [SyncStatusComponent],
      providers: [
        { provide: ActionQueueService, useValue: actionQueueMock },
        { provide: SimpleSyncService, useValue: { syncState } },
        {
          provide: SyncCoordinatorService,
          useValue: {
            isLoadingRemote,
            resyncActiveProject: vi.fn().mockResolvedValue({ success: true, conflictDetected: false, message: 'ok' }),
          },
        },
        { provide: ProjectStateService, useValue: { activeProjectId } },
        { provide: AuthService, useValue: { currentUserId } },
        { provide: ConflictStorageService, useValue: { conflictCount, hasUnresolvedConflicts } },
        {
          provide: RetryQueueService,
          useValue: {
            processQueue: vi.fn().mockResolvedValue(undefined),
            getCapacityPercent: vi.fn().mockReturnValue(0),
            legacyReviewCount,
          },
        },
        {
          provide: ToastService,
          useValue: {
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn(),
          },
        },
        { provide: LoggerService, useValue: { error: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SyncStatusComponent);
    fixture.detectChanges();
  }, 5000);

  it('不应将后台 focus-session 自动同步显示为用户待同步', () => {
    pendingActions.set([createQueuedAction('focus-session')]);
    fixture.detectChanges();

    expect(fixture.componentInstance.pendingCount()).toBe(0);
    expect(fixture.componentInstance.detailedStatus()).toBe('数据已保存到云端');
  });

  it('应继续即时显示用户可感知的待同步操作', () => {
    pendingActions.set([createQueuedAction('project')]);
    fixture.detectChanges();

    expect(fixture.componentInstance.pendingCount()).toBe(1);
    expect(fixture.componentInstance.detailedStatus()).toBe('1 个操作待同步');
  });

  it('应显示待人工确认的 legacy retry 数据', () => {
    legacyReviewCount.set(2);
    fixture.detectChanges();

    expect(fixture.componentInstance.detailedStatus()).toBe('2 个旧版离线同步项待确认');
    expect(fixture.componentInstance.hasIssues()).toBe(true);
  });

  it('retryAll 应先重放 RetryQueue，再处理 ActionQueue', async () => {
    const retryQueue = TestBed.inject(RetryQueueService) as unknown as {
      processQueue: ReturnType<typeof vi.fn>;
    };

    await fixture.componentInstance.retryAll();

    expect(actionQueueMock.processQueue).toHaveBeenCalledOnce();
    expect(retryQueue.processQueue).toHaveBeenCalledWith(undefined, true);
    expect(retryQueue.processQueue.mock.invocationCallOrder[0]).toBeLessThan(
      actionQueueMock.processQueue.mock.invocationCallOrder[0],
    );
  });
});
