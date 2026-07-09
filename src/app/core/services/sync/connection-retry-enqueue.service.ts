import { Injectable, inject } from '@angular/core';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { RetryQueueService, type RetryQueueLastFailure } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';

@Injectable({ providedIn: 'root' })
export class ConnectionRetryEnqueueService {
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');
  private readonly retryQueueService = inject(RetryQueueService);
  private readonly syncStateService = inject(SyncStateService);

  async enqueueConnectionUpsert(
    connection: Connection,
    projectId: string,
    sourceUserId?: string,
    allowWhenSessionExpired = false,
    operationId?: string,
    lastFailure?: RetryQueueLastFailure,
  ): Promise<boolean> {
    if (this.syncStateService.isSessionExpired() && !allowWhenSessionExpired) {
      return false;
    }

    if (!connection?.id) {
      this.logger.warn('enqueueConnectionUpsert: 跳过无效连接（缺少 id）', {
        operation: 'upsert',
      });
      return false;
    }

    if (!projectId) {
      this.logger.warn('enqueueConnectionUpsert: 跳过无效连接（缺少 projectId）', {
        operation: 'upsert',
        id: connection.id,
      });
      return false;
    }

    const addArgs = [
      'connection',
      'upsert',
      connection,
      projectId,
      sourceUserId,
      undefined,
      undefined,
      undefined,
      operationId,
    ] as const;
    const enqueued = lastFailure === undefined
      ? await this.retryQueueService.addDurably(...addArgs)
      : await this.retryQueueService.addDurably(...addArgs, lastFailure);

    if (enqueued) {
      this.syncStateService.setPendingCount(this.retryQueueService.length);
      return true;
    }

    this.syncStateService.setSyncError('同步队列已满，暂未写入重试队列');
    return false;
  }
}
