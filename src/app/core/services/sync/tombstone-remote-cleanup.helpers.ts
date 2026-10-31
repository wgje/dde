import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AttachmentCleanupOutboxService,
  PendingAttachmentCleanupRecord,
} from '../../../../services/attachment-cleanup-outbox.service';
import type { CategoryLogger } from '../../../../services/logger.service';

interface TombstoneRemoteCleanupOptions {
  client: SupabaseClient | null;
  paths: string[];
  attachmentCleanupOutbox: Pick<
    AttachmentCleanupOutboxService,
    'enqueuePaths' | 'removePendingCleanups'
  >;
  logger: CategoryLogger;
}

export async function deleteRemoteAttachmentFilesFromStorage({
  client,
  paths,
  attachmentCleanupOutbox,
  logger,
}: TombstoneRemoteCleanupOptions): Promise<void> {
  const pendingRecords = await enqueueAttachmentCleanupRecords(
    paths,
    attachmentCleanupOutbox,
    logger,
  );
  if (!pendingRecords) return;

  if (!client) return;

  try {
    // 批量删除，每次最多 100 个
    const batchSize = 100;
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      const { error } = await client.storage.from('attachments').remove(batch);

      if (error) {
        logger.warn('deleteAttachmentFilesFromStorage: 批量删除失败', {
          batch: batch.slice(0, 5),
          batchSize: batch.length,
          error: error.message
        });
        // 继续删除下一批，不抛出异常
      } else {
        logger.debug('deleteAttachmentFilesFromStorage: 批量删除成功', {
          batchIndex: i / batchSize,
          batchSize: batch.length
        });
        try {
          const batchPaths = new Set(batch);
          await attachmentCleanupOutbox.removePendingCleanups(
            pendingRecords.filter(record => batchPaths.has(record.path)),
          );
        } catch (removePendingError) {
          logger.warn('deleteAttachmentFilesFromStorage: 清理队列记录删除失败，将保持可重试', {
            batch: batch.slice(0, 5),
            batchSize: batch.length,
            error: removePendingError
          });
        }
      }
    }

    logger.info('deleteAttachmentFilesFromStorage: 完成', {
      totalPaths: paths.length
    });
  } catch (e) {
    logger.error('deleteAttachmentFilesFromStorage: 异常', e);
    // 不抛出，因为任务已经删除，附件清理失败只是资源浪费，不影响功能
  }
}

async function enqueueAttachmentCleanupRecords(
  paths: string[],
  attachmentCleanupOutbox: Pick<AttachmentCleanupOutboxService, 'enqueuePaths'>,
  logger: CategoryLogger,
): Promise<PendingAttachmentCleanupRecord[] | null> {
  const ownerUserId = resolveAttachmentCleanupOwnerUserId(paths);
  if (!ownerUserId) {
    logger.error('deleteAttachmentFilesFromStorage: 附件路径 owner 缺失或不一致，已拒绝入队', {
      paths: paths.slice(0, 5),
    });
    return null;
  }

  try {
    return await attachmentCleanupOutbox.enqueuePaths(paths, { ownerUserId });
  } catch (error) {
    logger.error('deleteAttachmentFilesFromStorage: 清理队列持久化失败', error);
    return null; // eslint-disable-line no-restricted-syntax -- durable enqueue failure aborts remote cleanup
  }
}

function resolveAttachmentCleanupOwnerUserId(paths: string[]): string | null {
  const owners = new Set(paths.map(path => path.trim().split('/')[0]).filter(Boolean));
  return owners.size === 1 ? Array.from(owners)[0] ?? null : null;
}
