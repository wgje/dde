import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { SyncWriterLeaseService, type LeaseHandle } from './sync-writer-lease.service';

const SYNC_WRITER_LEASE_PROJECT_SCOPE = '__global__';
const SYNC_WRITER_LEASE_WAIT_MS = 5_000;

export type ActionQueueSyncWriterLeaseHandle = LeaseHandle;

@Injectable({ providedIn: 'root' })
export class ActionQueueSyncWriterLeaseService {
  private readonly logger = inject(LoggerService).category('ActionQueue');
  private readonly syncWriterLease = inject(SyncWriterLeaseService, { optional: true });

  isRequired(): boolean {
    try {
      return this.syncWriterLease?.isFeatureEnabled() === true;
    } catch {
      return false;
    }
  }

  async acquire(userId: string): Promise<ActionQueueSyncWriterLeaseHandle | null> {
    if (!this.syncWriterLease) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_WRITER_LEASE_WAIT_MS);
    let leaseHandle: ActionQueueSyncWriterLeaseHandle | null = null;
    try {
      leaseHandle = await this.syncWriterLease.requestLease({
        userId,
        projectId: SYNC_WRITER_LEASE_PROJECT_SCOPE,
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warn('sync writer lease 获取失败，本轮 ActionQueue flush 已延后', { message });
    } finally {
      clearTimeout(timeout);
    }

    return leaseHandle;
  }

  private warn(message: string, context?: unknown): void {
    try {
      this.logger.warn(message, context);
    } catch {
      // Lease acquisition fallback must not depend on observability sinks.
    }
  }
}
