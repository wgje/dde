import type {
  BackupConnection,
  BackupData,
  BackupPendingAttachmentUpload,
  BackupTask,
} from '../../supabase/functions/_shared/backup-utils';
import type { SavePendingAttachmentUploadInput } from './attachment-upload-outbox.service';
import type { QueuedAction } from './action-queue.types';
import {
  extractBackupActionQueueActions,
  mergeRestoredQueuedActions,
} from './action-queue-restore.helpers';
import type { ConflictRecord } from './conflict-storage.service';
import type { OperationConflictRecord } from './conflict-storage.helpers';
import type {
  ExportAttachment,
  ExportConnection,
  ExportData,
  ExportMetadata,
  ExportProject,
  ExportTask,
} from './export.service';

export function convertBackupDataToExportData(backup: BackupData): ExportData | null {
  try {
    const tasksByProject = groupBackupTasksByProject(backup.tasks ?? []);
    const connectionsByProject = groupBackupConnectionsByProject(backup.connections ?? []);
    const projects = buildExportProjects(backup, tasksByProject, connectionsByProject);

    return {
      metadata: buildBackupExportMetadata(backup, projects.length),
      projects,
    };
  } catch {
    return null; // eslint-disable-line no-restricted-syntax -- 文件解析失败时保留原导入契约：null 触发调用方给出"本地备份数据转换失败"
  }
}

export async function restoreAttachmentUploadOutboxFromBackup(
  backup: BackupData,
  uploadOutbox: {
    savePendingUpload(input: SavePendingAttachmentUploadInput): Promise<void>;
  },
): Promise<number> {
  const pendingUploads = backup.localState?.attachmentUploadOutbox ?? [];
  let restoredCount = 0;

  for (const pendingUpload of pendingUploads) {
    if (!isRestorableAttachmentUpload(pendingUpload)) {
      continue;
    }

    await uploadOutbox.savePendingUpload({
      attachmentId: pendingUpload.attachmentId,
      blobKey: pendingUpload.blobKey,
      fileName: pendingUpload.fileName,
      mimeType: pendingUpload.mimeType,
      size: pendingUpload.size,
      createdAt: pendingUpload.createdAt,
      blob: base64ToBlob(pendingUpload.blobBase64, pendingUpload.mimeType),
    });
    restoredCount += 1;
  }

  return restoredCount;
}

export async function restoreActionQueueFromBackup(
  backup: BackupData,
  ownerUserId: string,
  queueBackup: {
    updateQueue(
      ownerUserId: string,
      updater: (
        queue: QueuedAction[],
        context: { recordFound: boolean },
      ) => QueuedAction[],
    ): Promise<QueuedAction[] | null>;
  },
): Promise<number> {
  const restoredQueue = extractBackupActionQueueActions(backup.localState?.actionQueue);
  if (restoredQueue.length === 0) {
    return 0;
  }

  let restoredCount = 0;
  await queueBackup.updateQueue(ownerUserId, (currentQueue) => {
    const merged = mergeRestoredQueuedActions(currentQueue, restoredQueue);
    restoredCount = merged.restoredCount;
    return merged.queue;
  });
  return restoredCount;
}

export async function restoreRetryQueueFromBackup(
  backup: BackupData,
  ownerUserId: string,
  retryQueue: {
    restoreFromBackupItems(items: unknown[], ownerUserId: string): Promise<number>;
  },
): Promise<number> {
  const pendingRetryItems = backup.localState?.retryQueue;
  if (!Array.isArray(pendingRetryItems) || pendingRetryItems.length === 0) {
    return 0;
  }

  return retryQueue.restoreFromBackupItems(pendingRetryItems, ownerUserId);
}

export function restoreDeadLettersFromBackup(
  backup: BackupData,
  ownerUserId: string,
  actionQueueStorage: {
    restoreDeadLettersFromBackupItems(items: unknown[], ownerUserId: string): number;
  },
): number {
  const deadLetters = backup.localState?.deadLetters;
  if (!Array.isArray(deadLetters) || deadLetters.length === 0) {
    return 0;
  }

  return actionQueueStorage.restoreDeadLettersFromBackupItems(deadLetters, ownerUserId);
}

export async function restoreConflictsFromBackup(
  backup: BackupData,
  ownerUserId: string,
  conflictStorage: {
    saveConflict(record: ConflictRecord): Promise<boolean>;
  },
): Promise<number> {
  const conflicts = backup.localState?.conflicts;
  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    return 0;
  }

  let restoredCount = 0;
  for (const conflict of conflicts) {
    if (!isRestorableConflictRecord(conflict, ownerUserId)) {
      continue;
    }

    const saved = await conflictStorage.saveConflict({
      ...conflict,
      ownerUserId,
    });
    if (saved) {
      restoredCount += 1;
    }
  }

  return restoredCount;
}

function isRestorableAttachmentUpload(
  upload: BackupPendingAttachmentUpload,
): upload is BackupPendingAttachmentUpload {
  return upload.encoding === 'base64'
    && !!upload.attachmentId
    && !!upload.blobKey
    && !!upload.fileName
    && !!upload.mimeType
    && Number.isFinite(upload.size)
    && typeof upload.blobBase64 === 'string';
}

function isRestorableConflictRecord(
  conflict: unknown,
  ownerUserId: string,
): conflict is ConflictRecord {
  if (!conflict || typeof conflict !== 'object') {
    return false;
  }

  const record = conflict as Partial<ConflictRecord>;
  if (record.ownerUserId && record.ownerUserId !== ownerUserId) {
    return false;
  }

  return typeof record.projectId === 'string'
    && record.projectId.length > 0
    && !!record.localProject
    && typeof record.localProject === 'object'
    && typeof record.conflictedAt === 'string'
    && record.conflictedAt.length > 0
    && typeof record.localVersion === 'number'
    && typeof record.reason === 'string'
    && isRestorableOperationConflicts(record.operationConflicts);
}

function isRestorableOperationConflicts(
  operationConflicts: ConflictRecord['operationConflicts'],
): operationConflicts is OperationConflictRecord[] | undefined {
  if (operationConflicts === undefined) {
    return true;
  }

  if (!Array.isArray(operationConflicts)) {
    return false;
  }

  return operationConflicts.every(isRestorableOperationConflict);
}

function isRestorableOperationConflict(
  conflict: unknown,
): conflict is OperationConflictRecord {
  if (!conflict || typeof conflict !== 'object') {
    return false;
  }

  const record = conflict as Partial<OperationConflictRecord>;
  return isRestorableOperationActionType(record.actionType)
    && isRestorableOperationEntityType(record.entityType)
    && typeof record.entityId === 'string'
    && record.entityId.length > 0
    && typeof record.projectId === 'string'
    && record.projectId.length > 0
    && !!record.localEntity
    && typeof record.localEntity === 'object'
    && (record.remoteEntity === undefined || typeof record.remoteEntity === 'object')
    && typeof record.message === 'string'
    && record.message.length > 0
    && typeof record.conflictedAt === 'string'
    && record.conflictedAt.length > 0
    && isRestorableOperationReason(record.reason);
}

function isRestorableOperationActionType(
  actionType: unknown,
): actionType is OperationConflictRecord['actionType'] {
  return actionType === 'task:create'
    || actionType === 'task:update'
    || actionType === 'task:delete'
    || actionType === 'connection:create'
    || actionType === 'connection:update'
    || actionType === 'connection:delete';
}

function isRestorableOperationEntityType(
  entityType: unknown,
): entityType is OperationConflictRecord['entityType'] {
  return entityType === 'task' || entityType === 'connection';
}

function isRestorableOperationReason(
  reason: unknown,
): reason is OperationConflictRecord['reason'] {
  return reason === 'remote-newer'
    || reason === 'remote-tombstone'
    || reason === 'version_mismatch';
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function groupBackupTasksByProject(tasks: BackupTask[]): Map<string, ExportTask[]> {
  const tasksByProject = new Map<string, ExportTask[]>();
  for (const task of tasks) {
    appendGroupedValue(tasksByProject, task.projectId, toExportTask(task));
  }
  return tasksByProject;
}

function groupBackupConnectionsByProject(
  connections: BackupConnection[]
): Map<string, ExportConnection[]> {
  const connectionsByProject = new Map<string, ExportConnection[]>();
  for (const connection of connections) {
    appendGroupedValue(connectionsByProject, connection.projectId, toExportConnection(connection));
  }
  return connectionsByProject;
}

function buildExportProjects(
  backup: BackupData,
  tasksByProject: ReadonlyMap<string, ExportTask[]>,
  connectionsByProject: ReadonlyMap<string, ExportConnection[]>
): ExportProject[] {
  return (backup.projects ?? []).map(project => ({
    id: project.id,
    name: project.name,
    description: project.description ?? '',
    tasks: tasksByProject.get(project.id) ?? [],
    connections: connectionsByProject.get(project.id) ?? [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    version: project.version,
  }));
}

function buildBackupExportMetadata(backup: BackupData, projectCount: number): ExportMetadata {
  return {
    exportedAt: backup.createdAt ?? new Date().toISOString(),
    version: backup.payloadVersion ?? backup.version ?? '1.0',
    appVersion: 'backup-restore',
    projectCount,
    taskCount: (backup.tasks ?? []).length,
    connectionCount: (backup.connections ?? []).length,
    attachmentCount: countBackupTaskAttachments(backup.tasks ?? []),
    checksum: '',
    exportType: 'full',
  };
}

function toExportTask(task: BackupTask): ExportTask {
  return {
    id: task.id,
    title: task.title,
    content: task.content ?? '',
    stage: task.stage ?? null,
    parentId: task.parentId ?? null,
    order: task.order ?? 0,
    rank: task.rank ?? 0,
    status: task.status ?? 'active',
    x: task.x ?? 0,
    y: task.y ?? 0,
    displayId: task.displayId ?? task.shortId ?? task.id.slice(0, 6),
    shortId: task.shortId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    deletedAt: task.deletedAt,
    attachments: task.attachments?.map(toExportAttachment),
    tags: task.tags,
    priority: task.priority as ExportTask['priority'],
    dueDate: task.dueDate,
    expected_minutes: task.expected_minutes ?? null,
    cognitive_load: task.cognitive_load ?? null,
    wait_minutes: task.wait_minutes ?? null,
    parkingMeta: task.parkingMeta as ExportTask['parkingMeta'],
    attentionMeta: task.attentionMeta as ExportTask['attentionMeta'],
    externalSourceLinks: task.externalSourceLinks,
  } as ExportTask;
}

function toExportConnection(connection: BackupConnection): ExportConnection {
  return {
    id: connection.id,
    source: connection.source,
    target: connection.target,
    title: connection.title,
    description: connection.description,
    updatedAt: connection.updatedAt,
    deletedAt: connection.deletedAt,
  };
}

function toExportAttachment(attachment: unknown): ExportAttachment {
  if (typeof attachment !== 'object' || attachment === null) {
    return { id: '', name: '', size: 0, mimeType: '' };
  }

  const rawAttachment = attachment as Record<string, unknown>;
  return {
    id: String(rawAttachment['id'] ?? ''),
    name: String(rawAttachment['name'] ?? ''),
    size: Number(rawAttachment['size'] ?? 0),
    mimeType: String(rawAttachment['mimeType'] ?? rawAttachment['mime_type'] ?? ''),
    type: rawAttachment['type'] as ExportAttachment['type'],
  };
}

function countBackupTaskAttachments(tasks: BackupTask[]): number {
  return tasks.reduce((sum, task) => sum + (task.attachments?.length ?? 0), 0);
}

function appendGroupedValue<TKey, TValue>(
  map: Map<TKey, TValue[]>,
  key: TKey,
  value: TValue
): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}
