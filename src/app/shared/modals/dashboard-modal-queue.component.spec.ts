import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardModalComponent } from './dashboard-modal.component';
import { ActionQueueService } from '../../../services/action-queue.service';
import type { DeadLetterItem } from '../../../services/action-queue.types';
import { SyncStateService } from '../../core/services/sync/sync-state.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { ToastService } from '../../../services/toast.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ConflictAutoResolverService } from '../../../services/conflict-auto-resolver.service';
import { ProjectStore } from '../../core/state/stores';

const retainedMessage = '远端专注会话已更新，本地变更已保留等待处理';
function failedItem(id: string, retained = false): DeadLetterItem {
  return {
    action: {
      id, operationId: `operation-${id}`, type: 'update',
      entityType: retained ? 'focus-session' : 'preference', entityId: `entity-${id}`,
      payload: { preferences: {}, userId: 'owner-1' }, timestamp: Date.now(), retryCount: 3,
      lastError: retained ? retainedMessage : '网络错误', syncState: 'dead_letter',
    },
    failedAt: new Date(Date.now() - 120000).toISOString(), reason: retained ? retainedMessage : '失败原因可见',
  };
}

describe('DashboardModalComponent real queue template', () => {
  let fixture: ComponentFixture<DashboardModalComponent>;
  const deadLetters = signal<DeadLetterItem[]>([]);
  const queue = {
    queueSize: signal(0), deadLetterSize: computed(() => deadLetters().length),
    deadLetterQueue: deadLetters, isProcessing: signal(false),
    processQueue: vi.fn().mockResolvedValue(undefined), retryDeadLetter: vi.fn(),
    dismissDeadLetter: vi.fn(), clearDeadLetterQueue: vi.fn(), downloadEscapeExport: vi.fn(),
  };
  const toast = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
  const retry = { processQueue: vi.fn().mockResolvedValue(undefined) };
  const buttons = () => Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
  const button = (text: string) => {
    const result = buttons().find(item => item.textContent?.trim() === text);
    expect(result, `button ${text} exists`).toBeDefined();
    return result!;
  };
  const render = () => {
    fixture = TestBed.createComponent(DashboardModalComponent);

    fixture.detectChanges();
    buttons().find(item => item.textContent?.trim().startsWith('队列'))!.click();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    deadLetters.set([failedItem('normal-1')]);
    await TestBed.configureTestingModule({
      imports: [DashboardModalComponent], providers: [
        { provide: ActionQueueService, useValue: queue },
        { provide: SyncStateService, useValue: { syncState: signal({ isOnline: true, isSyncing: false, syncError: null, backgroundSyncNotice: null, cloudSyncPausedReason: null, offlineMode: false }) } },
        { provide: RetryQueueService, useValue: retry },
        { provide: AuthService, useValue: { currentUserId: signal('owner-1') } },
        { provide: ConflictStorageService, useValue: { conflictCount: signal(0), hasUnresolvedConflicts: signal(false), getAllConflicts: vi.fn().mockResolvedValue([]) } },
        { provide: ProjectOperationService, useValue: {} },
        { provide: ToastService, useValue: toast },
        { provide: SyncCoordinatorService, useValue: {} },
        { provide: ConflictAutoResolverService, useValue: {} },
        { provide: ProjectStore, useValue: {} },
      ],
    }).compileComponents();
  });

  it('renders actual failedAt and reason from DeadLetterItem, not nonexistent legacy fields', () => {
    render();
    expect(fixture.nativeElement.textContent).toContain('失败原因可见');
    expect(fixture.nativeElement.textContent).toContain('2 分钟前');
    expect(fixture.nativeElement.textContent).not.toContain('NaN');
  });

  it('normal retry and ignore pass action.id, preserving existing actions', () => {
    render(); button('重试').click(); button('忽略').click();
    expect(queue.retryDeadLetter).toHaveBeenCalledWith('normal-1');
    expect(queue.dismissDeadLetter).toHaveBeenCalledWith('normal-1');
  });

  it('normal failures still allow explicit clear-all', () => {
    render(); button('全部清空').click();
    expect(queue.clearDeadLetterQueue).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledOnce();
  });

  it.each(['', 'invalid-date'])('invalid date %j is explicit unknown, never NaN or fabricated now', value => {
    const item = failedItem('invalid-time'); item.failedAt = value; deadLetters.set([item]); render();
    expect(fixture.nativeElement.textContent).toContain('时间未知');
    expect(fixture.nativeElement.textContent).not.toContain('NaN');
  });

  it('retained Focus shows explanation and disables destructive/retry controls', () => {
    deadLetters.set([failedItem('focus-1', true)]); render();
    expect(fixture.nativeElement.textContent).toContain('本地快照已保留');
    expect(button('重试').disabled).toBe(true);
    expect(button('忽略').disabled).toBe(true);
    expect(button('全部清空').disabled).toBe(true);
    button('重试').click(); button('忽略').click(); button('全部清空').click();
    expect(queue.retryDeadLetter).not.toHaveBeenCalled();
    expect(queue.dismissDeadLetter).not.toHaveBeenCalled();
    expect(queue.clearDeadLetterQueue).not.toHaveBeenCalled();
  });

  it('method-level guards retain Focus snapshots even without disabled DOM', () => {
    deadLetters.set([failedItem('focus-1', true)]); render();
    fixture.componentInstance.retryDeadLetter('focus-1');
    fixture.componentInstance.dismissDeadLetter('focus-1');
    fixture.componentInstance.clearAllDeadLetters();
    expect(queue.retryDeadLetter).not.toHaveBeenCalled();
    expect(queue.dismissDeadLetter).not.toHaveBeenCalled();
    expect(queue.clearDeadLetterQueue).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('mixed queue protects retained Focus from clear-all but ordinary per-item actions remain usable', () => {
    deadLetters.set([failedItem('focus-1', true), failedItem('normal-1')]); render();
    expect(button('全部清空').disabled).toBe(true);
    const retries = buttons().filter(item => item.textContent?.trim() === '重试');
    const ignores = buttons().filter(item => item.textContent?.trim() === '忽略');
    retries[1].click(); ignores[1].click();
    expect(queue.retryDeadLetter).toHaveBeenCalledWith('normal-1');
    expect(queue.dismissDeadLetter).toHaveBeenCalledWith('normal-1');
    fixture.componentInstance.clearAllDeadLetters(); expect(queue.clearDeadLetterQueue).not.toHaveBeenCalled();
  });

  it('method guards resolve the current row, so a newly retained snapshot cannot use a stale enabled control', () => {
    render();
    deadLetters.set([failedItem('normal-1', true)]);
    fixture.componentInstance.retryDeadLetter('normal-1');
    fixture.componentInstance.dismissDeadLetter('normal-1');
    fixture.componentInstance.clearAllDeadLetters();
    expect(queue.retryDeadLetter).not.toHaveBeenCalled();
    expect(queue.dismissDeadLetter).not.toHaveBeenCalled();
    expect(queue.clearDeadLetterQueue).not.toHaveBeenCalled();
  });

  it('unknown row IDs cannot dispatch storage mutations', () => {
    render();
    fixture.componentInstance.retryDeadLetter('missing-row');
    fixture.componentInstance.dismissDeadLetter('missing-row');
    expect(queue.retryDeadLetter).not.toHaveBeenCalled();
    expect(queue.dismissDeadLetter).not.toHaveBeenCalled();
  });
  it('full queue backup only exports and does not process, remove or requeue retained data', () => {
    deadLetters.set([failedItem('focus-1', true)]); render();
    button('下载完整队列备份').click();
    expect(queue.downloadEscapeExport).toHaveBeenCalledOnce();
    expect(queue.processQueue).not.toHaveBeenCalled(); expect(retry.processQueue).not.toHaveBeenCalled();
    expect(queue.retryDeadLetter).not.toHaveBeenCalled(); expect(queue.dismissDeadLetter).not.toHaveBeenCalled();
    expect(queue.clearDeadLetterQueue).not.toHaveBeenCalled();
  });
});