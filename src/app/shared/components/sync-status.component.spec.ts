import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SyncStatusComponent } from './sync-status.component';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';

type SyncStateShape = {
  isOnline: boolean;
  isSyncing: boolean;
  syncError: string | null;
  offlineMode: boolean;
  lastSyncTime: string | null;
  pendingCount: number;
};

describe('SyncStatusComponent pending status debounce', () => {
  let actionQueueSize: ReturnType<typeof signal<number>>;
  let syncState: ReturnType<typeof signal<SyncStateShape>>;
  let component: SyncStatusComponent;

  beforeEach(() => {
    vi.useFakeTimers();

    actionQueueSize = signal(0);
    syncState = signal<SyncStateShape>({
      isOnline: true,
      isSyncing: false,
      syncError: null,
      offlineMode: false,
      lastSyncTime: null,
      pendingCount: 0,
    });

    TestBed.configureTestingModule({
      providers: [
        {
          provide: ActionQueueService,
          useValue: {
            queueSize: actionQueueSize,
            deadLetterSize: signal(0),
            deadLetterQueue: signal([]),
            queueFrozen: signal(false),
            isProcessing: vi.fn(() => false),
            processQueue: vi.fn(async () => undefined),
            retryDeadLetter: vi.fn(),
            dismissDeadLetter: vi.fn(),
            clearDeadLetterQueue: vi.fn(),
            downloadEscapeExport: vi.fn(),
          },
        },
        {
          provide: SimpleSyncService,
          useValue: {
            syncState,
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: signal('user-1'),
          },
        },
        {
          provide: ConflictStorageService,
          useValue: {
            conflictCount: signal(0),
            hasUnresolvedConflicts: signal(false),
          },
        },
        {
          provide: SyncCoordinatorService,
          useValue: {
            isLoadingRemote: signal(false),
            resyncActiveProject: vi.fn(async () => ({ success: true, conflictDetected: false, message: 'ok' })),
          },
        },
        {
          provide: ProjectStateService,
          useValue: {
            activeProjectId: signal('project-1'),
          },
        },
        {
          provide: RetryQueueService,
          useValue: {
            getCapacityPercent: vi.fn(() => 0),
          },
        },
        {
          provide: ToastService,
          useValue: {
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            error: vi.fn(),
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
          },
        },
      ],
    });

    component = TestBed.runInInjectionContext(() => new SyncStatusComponent());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should keep pending visible when retry queue briefly drops to zero and returns quickly', () => {
    // 先进入待同步状态
    syncState.update(s => ({ ...s, pendingCount: 1 }));
    vi.advanceTimersByTime(1200);
    expect(component.pendingCount()).toBe(1);

    // 短暂变为 0（启动清除延时）
    syncState.update(s => ({ ...s, pendingCount: 0 }));
    vi.advanceTimersByTime(700);
    expect(component.pendingCount()).toBe(1);

    // 在清除延时结束前恢复为 1，应取消清除计时器并保持稳定
    syncState.update(s => ({ ...s, pendingCount: 1 }));
    vi.advanceTimersByTime(900);
    expect(component.pendingCount()).toBe(1);
  });
});
