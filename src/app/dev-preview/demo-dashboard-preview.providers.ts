import { computed, Injectable, signal, type Provider } from '@angular/core';
import { ActionQueueService } from '../../services/action-queue.service';
import { SyncStateService } from '../core/services/sync/sync-state.service';
import { RetryQueueService } from '../core/services/sync/retry-queue.service';
import { AuthService } from '../../services/auth.service';
import { ConflictStorageService } from '../../services/conflict-storage.service';
import { ProjectOperationService } from '../../services/project-operation.service';
import { SyncCoordinatorService } from '../../services/sync-coordinator.service';
import { ConflictAutoResolverService } from '../../services/conflict-auto-resolver.service';
import { ToastService } from '../../services/toast.service';
import { ProjectStore } from '../core/state/stores';

/** Every Dashboard dependency is local to one preview; no root service is instantiated. */
@Injectable()
export class DemoDashboardMemoryService {
  readonly queueSize = signal(0);
  readonly deadLetterSize = signal(0);
  readonly deadLetterQueue = signal<never[]>([]);
  readonly isProcessing = signal(false);
  readonly currentUserId = signal<string | null>(null);
  readonly conflictCount = signal(0);
  readonly hasUnresolvedConflicts = computed(() => this.conflictCount() > 0);
  readonly message = signal('');
  readonly syncState = signal({ isOnline: true, isSyncing: false, syncError: null, backgroundSyncNotice: null, cloudSyncPausedReason: null, offlineMode: false });

  reset(state: string): void {
    this.queueSize.set(state === 'queue' ? 2 : 0);
    this.message.set('');
  }
  async processQueue(): Promise<void> { this.queueSize.set(0); }
  async getAllConflicts(): Promise<never[]> { return []; }
  async getConflict(): Promise<null> { return null; }
  async deleteConflict(): Promise<boolean> { return true; }
  async refreshConflictCount(): Promise<void> { this.conflictCount.set(0); }
  getProject(): undefined { return undefined; }
  async resolveConflict(): Promise<boolean> { return false; }
  async resolveConflictWithPlan(): Promise<boolean> { return false; }
  async resyncActiveProject(): Promise<{ success: boolean; conflictDetected: boolean; message: string }> {
    this.queueSize.set(0);
    return { success: true, conflictDetected: false, message: '演示队列已清空，没有发送网络请求。' };
  }
  async captureConflict(): Promise<null> { return null; }
  analyze(): never { throw new Error('Conflict scenarios are not part of the Dashboard normal preview.'); }
  retryDeadLetter(): void { /* no failed-operation fixture */ }
  dismissDeadLetter(): void { /* no failed-operation fixture */ }
  clearDeadLetterQueue(): void { this.deadLetterSize.set(0); this.deadLetterQueue.set([]); }
  downloadEscapeExport(): void { this.message.set('此演示不下载用户数据。'); }
  success(title: string, body = ''): void { this.message.set(`${title} ${body}`.trim()); }
  error(title: string, body = ''): void { this.message.set(`${title} ${body}`.trim()); }
  warning(title: string, body = ''): void { this.message.set(`${title} ${body}`.trim()); }
  info(title: string, body = ''): void { this.message.set(`${title} ${body}`.trim()); }
}

export const DEMO_DASHBOARD_PROVIDERS: Provider[] = [
  DemoDashboardMemoryService,
  ...[ActionQueueService, SyncStateService, RetryQueueService, AuthService,
    ConflictStorageService, ProjectOperationService, SyncCoordinatorService,
    ConflictAutoResolverService, ToastService, ProjectStore]
    .map(provide => ({ provide, useExisting: DemoDashboardMemoryService })),
];