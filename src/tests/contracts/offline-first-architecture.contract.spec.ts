import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const architectureDocPath = path.join(
  process.cwd(),
  'docs/offline-first-local-first-architecture.md',
);
const setEnvScriptPath = path.join(process.cwd(), 'scripts/set-env.cjs');
const ensureEnvFilesScriptPath = path.join(
  process.cwd(),
  'scripts/ensure-env-files.cjs',
);

const requiredSections = [
  '## 1. 当前项目的数据流审计结果',
  '## 2. 离线与弱网风险清单',
  '## 3. Offline-first 架构设计',
  '## 4. 新增和修改的模块列表',
  '## 5. 数据同步状态机',
  '## 6. 幂等与冲突处理策略',
  '## 7. 实际代码改造',
  '## 8. 自动化测试',
  '## 9. 手动验收步骤',
  '## 10. 尚未解决的边界问题和后续优化建议',
] as const;

const requiredModuleAnchors = [
  'src/services/action-queue.service.ts',
  'src/services/action-queue-restore.helpers.ts',
  'src/services/queue-backup.service.ts',
  'src/app/core/services/sync/retry-queue.service.ts',
  'src/app/core/services/sync/sync-state.service.ts',
  'src/app/core/services/simple-sync-runtime.controller.ts',
  'src/app/core/services/sync/project-offline-snapshot.service.ts',
  'src/services/sync-coordinator-conflicts.service.ts',
  'src/services/disaster-backup.service.ts',
  'restoreActionQueueFromBackup',
  'restoreRetryQueueFromBackup',
  'restoreDeadLettersFromBackup',
  'RetryQueueService.restoreFromBackupItems()',
  'ActionQueueStorageService.restoreDeadLettersFromBackupItems()',
  'attachmentUploadOutbox',
  'src/services/action-queue-attachment-processors.service.ts',
  'ActionQueueAttachmentProcessorsService',
  'follow-up task update durable 入队成功后才清理 Blob',
  '固定 storage path 幂等重放',
  'src/app/features/text/components/text-unassigned.component.ts',
  'TaskOperationAdapterService.updateTaskDraft()',
  'TaskAttributeService.updateTaskDraftDurably()',
  'title/content 单次 durable 写入',
  '一次 `recordAndUpdateDurably()` 同时保存 title/content',
  'Active project refresh',
  'downloadAndMerge',
  '本地项目集合签名',
  'src/app/core/services/sync/task-sync-push.service.ts',
  'TaskSyncPushService',
  'sync RPC probe rejection',
  'probe 判定客户端已过期',
  'queued-op-task-probe-rejected',
  '带 operationId 的 task upsert',
  'queued-op-task-rpc-unavailable',
  'src/app/core/services/sync/connection-sync-operations.service.ts',
  'ConnectionSyncOperationsService',
  '带 operationId 的 connection upsert',
  'connection-rpc-unavailable-operation-id',
  'pushConnection 带 operationId 且 sync RPC 不可用',
  'src/app/core/services/sync/project-push.service.ts',
  'ProjectPushService',
  '带 operationId 的 project metadata upsert',
  'project-rpc-unavailable-operation-id',
  'pushProject 带 operationId 且 sync RPC 不可用',
  'src/app/core/services/sync/task-sync-delete.service.ts',
  'TaskSyncDeleteService',
  '带 operationId 的 task purge',
  'task-delete-rpc-unavailable',
  'purgeTasksFromCloudDetailed 带 operationId 且 sync RPC 不可用',
  '带 operationId 的 batch soft delete',
  'op-soft-delete-rpc-unavailable',
  'softDeleteTasksBatch 带 operationId 且 sync RPC 不可用',
  'batch soft delete RPC rejected',
  'op-soft-delete-rpc-conflict',
  'softDeleteTasksBatch sync RPC 拒绝时应沿用调用方 operationId',
  'batch soft delete client rejected',
  'op-soft-delete-client-rejected',
  'softDeleteTasksBatch 在 sync RPC client rejected 且带 operationId',
  'src/app/core/services/sync/retry-queue-storage.service.ts',
  'RetryQueueStorageLayer',
  'mergeStoredRetryQueueItems',
  'persistNow 写入 IndexedDB',
  'src/app/core/services/sync/project-save-batch-executor.service.ts',
  'ProjectSaveBatchExecutorService',
  'task purge operationId',
  'queued-project-task-purge-op',
  'src/app/core/services/sync/project-save-task-batch.service.ts',
  'ProjectSaveTaskBatchService',
  'ProjectSave position-only operationId',
  'queued-project-position-op',
  'position-only 带 operationId',
  'unknownOutcome',
  'paused-auth',
  'src/services/action-queue-project-processors.service.ts',
  'project-delete-auth-pending-defer',
  'project:delete',
  'src/services/action-queue-owner-storage.service.ts',
  'settleSuccessfulActionForOwner()',
  'settleProjectDeleteSuccessForOwner()',
  'settleFailedActionForOwner()',
  'owner-successful-settlement-atomic',
  'owner-project-delete-settlement-atomic',
  'owner-failed-settlement-atomic',
  'owner-dead-letter-settlement-atomic',
  'dead-letter 保存失败',
  'IndexedDB-only 新操作',
  'src/services/action-queue-task-focus-processors.service.ts',
  'non-task-auth-pending-defer',
  'preference:update',
  'focus-session:*',
  'routine-task:*',
  'routine-completion:*',
  'SYNC_AUTH_PENDING',
  'blocked_by_auth',
  'src/services/sync-writer-lease.service.ts',
  'sync-writer-lease-default-enabled',
  'NG_APP_SYNC_LEASE_ENABLED=false',
  'memory-only fallback',
  'scripts/set-env.cjs',
  'scripts/ensure-env-files.cjs',
] as const;

function expectSyncLeaseFallbackEnabled(source: string): void {
  expect(source).toContain('NG_APP_SYNC_LEASE_ENABLED');
  expect(source).toMatch(
    /syncLeaseEnabled\s*=\s*parseBooleanEnv\(\s*process\.env\.NG_APP_SYNC_LEASE_ENABLED\s*\|\|\s*localEnv\.NG_APP_SYNC_LEASE_ENABLED,\s*true\s*\)/m,
  );
}

describe('offline-first architecture contract', () => {
  it('keeps a concrete audit and acceptance document tied to real modules', () => {
    const source = fs.readFileSync(architectureDocPath, 'utf8');

    expect(requiredSections.filter(section => !source.includes(section))).toEqual([]);
    expect(requiredModuleAnchors.filter(anchor => !source.includes(anchor))).toEqual([]);
    expect(source).toContain('任何已经成功写入本地持久化存储的用户操作');
    expect(source).toContain('operationId');
    expect(source).toContain('IndexedDB');
    expect(source).toContain('RetryQueue');
    expect(source).toContain('ActionQueue');
    expect(source).toContain('QueueBackupService.updateQueue()');
    expect(source).toContain('选择性恢复界面和逐项预览');
  });

  it('keeps sync writer lease enabled by default in generated environments', () => {
    expectSyncLeaseFallbackEnabled(fs.readFileSync(setEnvScriptPath, 'utf8'));
    expectSyncLeaseFallbackEnabled(
      fs.readFileSync(ensureEnvFilesScriptPath, 'utf8'),
    );
  });
});
