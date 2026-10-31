import type {
  BackupConnection,
  BackupData,
  BackupPendingAttachmentUpload,
  BackupTask,
} from '../../supabase/functions/_shared/backup-utils';
import type { SavePendingAttachmentUploadInput } from './attachment-upload-outbox.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import {
  extractBackupActionQueueActions,
  mergeRestoredQueuedActions,
} from './action-queue-restore.helpers';
import {
  extractRestorableDeadLetters,
  mergeRestoredDeadLetters,
} from './action-queue-owner-dead-letter-restore.helpers';
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

export * from './import-backup-data-safety-metadata.helpers';

export interface BackupRestoreCheckpointOptions {
  checkpoint?: () => Promise<void>;
  runWrite?<T>(write: () => Promise<T>): Promise<T>;
}

export function convertBackupDataToExportData(backup: BackupData): ExportData | null {
  try {
    preflightAttachmentUploadOutboxFromBackup(backup);
    decodeConflictsFromBackup(backup);
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
    savePendingUpload(
      input: SavePendingAttachmentUploadInput,
      options?: { restoreWriterContinuation?: boolean },
    ): Promise<void>;
  },
  options: BackupRestoreCheckpointOptions = {},
): Promise<number> {
  const pendingUploads = decodeAttachmentUploadOutboxFromBackup(backup);
  return savePreparedAttachmentUploads(pendingUploads, uploadOutbox, options);
}

export async function restoreAttachmentUploadOutboxItems(
  pendingUploads: readonly (
    BackupPendingAttachmentUpload & { ownerUserId: string; operationId: string }
  )[],
  uploadOutbox: {
    savePendingUpload(
      input: SavePendingAttachmentUploadInput,
      options?: { restoreWriterContinuation?: boolean },
    ): Promise<void>;
  },
  options: BackupRestoreCheckpointOptions = {},
): Promise<number> {
  const preparedUploads = prepareAttachmentUploadItems(pendingUploads);
  return savePreparedAttachmentUploads(preparedUploads, uploadOutbox, options);
}

export function deriveAttachmentUploadOutboxRestoreTarget(
  preImage: readonly (
    BackupPendingAttachmentUpload & { ownerUserId: string; operationId: string }
  )[],
  backup: BackupData,
  expectedOwnerUserId: string,
): Array<BackupPendingAttachmentUpload & { ownerUserId: string; operationId: string }> {
  if (!isNonEmptyString(expectedOwnerUserId)) {
    throw invalidAttachmentUploadOutbox('restore owner is missing');
  }

  const target = new Map<
    string,
    BackupPendingAttachmentUpload & { ownerUserId: string; operationId: string }
  >();
  for (const upload of preImage) {
    if (upload.ownerUserId !== expectedOwnerUserId
      || !isNonEmptyString(upload.blobKey)
      || !isNonEmptyString(upload.operationId)) {
      throw invalidAttachmentUploadOutbox('pre-image owner or storage identity mismatch');
    }
    const identity = attachmentUploadIdentity(upload);
    if (target.has(identity)) {
      throw invalidAttachmentUploadOutbox('pre-image contains duplicate storage identity');
    }
    target.set(identity, normalizeAttachmentUploadSnapshot(upload));
  }

  const rawUploads = backup.localState?.attachmentUploadOutbox;
  const decodedUploads = decodeAttachmentUploadOutboxFromBackup(backup, expectedOwnerUserId);
  const restoredUploads = Array.isArray(rawUploads)
    ? rawUploads as Array<BackupPendingAttachmentUpload & { ownerUserId: string; operationId: string }>
    : [];
  if (restoredUploads.length !== decodedUploads.length) {
    throw invalidAttachmentUploadOutbox('decoded restore payload is incomplete');
  }
  for (const upload of restoredUploads) {
    const identity = attachmentUploadIdentity(upload);
    target.set(identity, normalizeAttachmentUploadSnapshot(upload));
  }

  return Array.from(target.values()).sort((left, right) => (
    left.blobKey.localeCompare(right.blobKey)
    || left.operationId.localeCompare(right.operationId)
  ));
}

function attachmentUploadIdentity(
  upload: Pick<BackupPendingAttachmentUpload, 'ownerUserId' | 'blobKey' | 'operationId'>,
): string {
  return JSON.stringify([upload.ownerUserId, upload.blobKey, upload.operationId]);
}

function normalizeAttachmentUploadSnapshot(
  upload: BackupPendingAttachmentUpload & { ownerUserId: string; operationId: string },
): BackupPendingAttachmentUpload & { ownerUserId: string; operationId: string } {
  return {
    ownerUserId: upload.ownerUserId,
    operationId: upload.operationId,
    attachmentId: upload.attachmentId,
    blobKey: upload.blobKey,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    size: upload.size,
    createdAt: upload.createdAt,
    encoding: 'base64',
    blobBase64: upload.blobBase64,
  };
}

async function savePreparedAttachmentUploads(
  pendingUploads: readonly SavePendingAttachmentUploadInput[],
  uploadOutbox: {
    savePendingUpload(
      input: SavePendingAttachmentUploadInput,
      options?: { restoreWriterContinuation?: boolean },
    ): Promise<void>;
  },
  options: BackupRestoreCheckpointOptions,
): Promise<number> {
  let restoredCount = 0;

  for (const pendingUpload of pendingUploads) {
    await options.checkpoint?.();
    const write = () => uploadOutbox.savePendingUpload(pendingUpload, {
      restoreWriterContinuation: options.runWrite !== undefined,
    });
    if (options.runWrite) await options.runWrite(write);
    else await write();
    await options.checkpoint?.();
    restoredCount += 1;
  }

  return restoredCount;
}

export function countRestorableAttachmentUploadsFromBackup(backup: BackupData): number {
  return decodeAttachmentUploadOutboxFromBackup(backup).length;
}

export function preflightAttachmentUploadOutboxFromBackup(
  backup: BackupData,
  expectedOwnerUserId?: string,
): void {
  decodeAttachmentUploadOutboxFromBackup(backup, expectedOwnerUserId);
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
  options: BackupRestoreCheckpointOptions = {},
): Promise<number> {
  const restoredQueue = extractBackupActionQueueActions(backup.localState?.actionQueue);
  if (restoredQueue.length === 0) {
    return 0;
  }

  let restoredCount = 0;
  await options.checkpoint?.();
  await queueBackup.updateQueue(ownerUserId, (currentQueue) => {
    const merged = mergeRestoredQueuedActions(currentQueue, restoredQueue);
    restoredCount = merged.restoredCount;
    return merged.queue;
  });
  await options.checkpoint?.();
  return restoredCount;
}

export async function restoreRetryQueueFromBackup(
  backup: BackupData,
  ownerUserId: string,
  retryQueue: {
    restoreFromBackupItems(items: unknown[], ownerUserId: string): Promise<number>;
  },
  options: BackupRestoreCheckpointOptions = {},
): Promise<number> {
  const pendingRetryItems = backup.localState?.retryQueue;
  if (!Array.isArray(pendingRetryItems) || pendingRetryItems.length === 0) {
    return 0;
  }

  await options.checkpoint?.();
  const restoredCount = await retryQueue.restoreFromBackupItems(pendingRetryItems, ownerUserId);
  await options.checkpoint?.();
  return restoredCount;
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

export interface DeadLetterRestoreTargetSnapshot {
  indexedDb: {
    id: string;
    ownerUserId: string;
    deadLetters: DeadLetterItem[];
    savedAt: string;
  } | null;
  localStorage: string | null;
}

/**
 * Projects the owner-scoped dead-letter merge before the storage mutation.
 * The persisted timestamp is intentionally left to the verifier because the
 * queue backup service generates it at write time.
 */
export function deriveDeadLetterRestoreTarget(
  preImage: DeadLetterRestoreTargetSnapshot,
  backup: BackupData,
  ownerUserId: string,
): DeadLetterRestoreTargetSnapshot {
  const current = [
    ...(preImage.indexedDb?.deadLetters ?? []),
    ...parseDeadLetterLocalStorage(preImage.localStorage),
  ];
  const incoming = Array.isArray(backup.localState?.deadLetters)
    ? extractRestorableDeadLetters(
      backup.localState.deadLetters,
      ownerUserId,
      item => resolveDeadLetterOwner(item, ownerUserId),
    )
    : [];
  const mergeResult = mergeRestoredDeadLetters(current, incoming);
  if (mergeResult.restoredCount === 0) {
    return {
      indexedDb: preImage.indexedDb,
      localStorage: preImage.localStorage,
    };
  }
  const merged = mergeResult.queue;
  const nextRecord = preImage.indexedDb
    ? { ...preImage.indexedDb, deadLetters: merged }
    : null;
  return {
    indexedDb: nextRecord,
    localStorage: preImage.localStorage === null && incoming.length === 0
      ? null
      : JSON.stringify(merged),
  };
}

function parseDeadLetterLocalStorage(value: string | null): DeadLetterItem[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as DeadLetterItem[] : [];
  } catch {
    return [];
  }
}

function resolveDeadLetterOwner(item: DeadLetterItem, ownerUserId: string): string {
  const payload = item.action.payload as unknown;
  return payload && typeof payload === 'object'
    && 'sourceUserId' in payload
    && typeof payload.sourceUserId === 'string'
    ? payload.sourceUserId
    : ownerUserId;
}

export async function restoreConflictsFromBackup(
  backup: BackupData,
  ownerUserId: string,
  conflictStorage: {
    saveConflict(
      record: ConflictRecord,
      options?: { restoreWriterContinuation?: boolean },
    ): Promise<boolean>;
  },
  options: BackupRestoreCheckpointOptions = {},
): Promise<number> {
  const conflicts = decodeConflictsFromBackup(backup, ownerUserId);

  let restoredCount = 0;
  for (const conflict of conflicts) {
    await options.checkpoint?.();
    const write = () => conflictStorage.saveConflict(conflict, {
      restoreWriterContinuation: options.runWrite !== undefined,
    });
    const saved = options.runWrite ? await options.runWrite(write) : await write();
    await options.checkpoint?.();
    if (!saved) {
      throw invalidConflictRestore(`failed to persist ${conflict.projectId}`);
    }
    restoredCount += 1;
  }

  return restoredCount;
}

export function decodeConflictsFromBackup(
  backup: BackupData,
  expectedOwnerUserId?: string,
): ConflictRecord[] {
  const conflicts = backup.localState?.conflicts as unknown;
  if (conflicts === undefined || (Array.isArray(conflicts) && conflicts.length === 0)) return [];
  if (!Array.isArray(conflicts)) throw invalidConflictRestore('expected an array');

  const candidates = conflicts.map((candidate, index) => ({
    candidate,
    ownerUserId: readConflictOwner(candidate, index),
  }));
  const ownerUserId = resolveConflictBackupOwner(backup, candidates.map(item => item.ownerUserId));
  if (expectedOwnerUserId !== undefined && ownerUserId !== expectedOwnerUserId) {
    throw invalidConflictRestore('owner does not match the active restore');
  }
  assertConflictProjectOwner(backup, ownerUserId);

  const identities = new Set<string>();
  return candidates.map(({ candidate }, index) => {
    if (!isRestorableConflictRecord(candidate, ownerUserId)) {
      throw invalidConflictRestore(`row ${index} is malformed or foreign`);
    }
    const identity = JSON.stringify([ownerUserId, candidate.projectId]);
    if (identities.has(identity)) throw invalidConflictRestore('duplicate storage identity');
    identities.add(identity);
    return candidate;
  });
}

function readConflictOwner(candidate: unknown, index: number): string {
  if (!isUnknownRecord(candidate) || !isNonBlankString(candidate['ownerUserId'])) {
    throw invalidConflictRestore(`row ${index} owner is missing`);
  }
  return candidate['ownerUserId'];
}

function resolveConflictBackupOwner(backup: BackupData, rowOwners: readonly string[]): string {
  const dataSafety = backup.localState?.dataSafety as unknown;
  if (dataSafety !== undefined && !isUnknownRecord(dataSafety)) {
    throw invalidConflictRestore('package owner evidence is malformed');
  }
  const hasPackageOwner = isUnknownRecord(dataSafety)
    && Object.prototype.hasOwnProperty.call(dataSafety, 'ownerUserId');
  let packageOwnerUserId: string | undefined;
  if (hasPackageOwner) {
    const ownerValue = dataSafety['ownerUserId'];
    if (!isNonBlankString(ownerValue)) {
      throw invalidConflictRestore('package owner is empty or malformed');
    }
    packageOwnerUserId = ownerValue;
  }
  const uniqueRowOwners = new Set(rowOwners);
  const resolvedOwnerUserId = hasPackageOwner
    ? packageOwnerUserId
    : uniqueRowOwners.size === 1 ? rowOwners[0] : undefined;
  if (!resolvedOwnerUserId || uniqueRowOwners.size !== 1
    || uniqueRowOwners.values().next().value !== resolvedOwnerUserId) {
    throw invalidConflictRestore('owner evidence is missing or ambiguous');
  }
  return resolvedOwnerUserId;
}

function assertConflictProjectOwner(backup: BackupData, ownerUserId: string): void {
  const projectOwners = Array.isArray(backup.projects)
    ? backup.projects.map(project => project.userId)
    : [];
  const uniqueProjectOwners = new Set(projectOwners);
  if (projectOwners.length === 0
    || projectOwners.some(projectOwner => !isNonBlankString(projectOwner))
    || uniqueProjectOwners.size !== 1
    || uniqueProjectOwners.values().next().value !== ownerUserId) {
    throw invalidConflictRestore('project owner evidence is missing, ambiguous, or mismatched');
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidConflictRestore(reason: string): Error {
  return new Error(`conflict restore payload is invalid: ${reason}`);
}

function decodeAttachmentUploadOutboxFromBackup(
  backup: BackupData,
  expectedOwnerUserId?: string,
): SavePendingAttachmentUploadInput[] {
  const pendingUploads = backup.localState?.attachmentUploadOutbox as unknown;
  if (pendingUploads === undefined || (Array.isArray(pendingUploads) && pendingUploads.length === 0)) {
    return [];
  }
  if (!Array.isArray(pendingUploads)) throw invalidAttachmentUploadOutbox('expected an array');
  const ownerUserId = backup.localState?.dataSafety?.ownerUserId;
  if (!isNonEmptyString(ownerUserId)
    || (expectedOwnerUserId !== undefined && ownerUserId !== expectedOwnerUserId)) {
    throw invalidAttachmentUploadOutbox('owner is missing or mismatched');
  }
  return prepareAttachmentUploadItems(pendingUploads, ownerUserId);
}

function prepareAttachmentUploadItems(
  pendingUploads: readonly unknown[],
  expectedOwnerUserId?: string,
): SavePendingAttachmentUploadInput[] {
  const identities = new Set<string>();
  return pendingUploads.map((candidate, index) => {
    if (!isUnknownRecord(candidate)) throw invalidAttachmentUploadOutbox(`row ${index} is malformed`);
    const ownerUserId = candidate['ownerUserId'];
    const operationId = candidate['operationId'];
    const attachmentId = candidate['attachmentId'];
    const blobKey = candidate['blobKey'];
    const fileName = candidate['fileName'];
    const mimeType = candidate['mimeType'];
    const size = candidate['size'];
    const createdAt = candidate['createdAt'];
    const blobBase64 = candidate['blobBase64'];
    if (!isNonEmptyString(ownerUserId)
      || (expectedOwnerUserId !== undefined && ownerUserId !== expectedOwnerUserId)
      || !isNonEmptyString(operationId)
      || !isNonEmptyString(attachmentId)
      || !isNonEmptyString(blobKey)
      || !isNonEmptyString(fileName)
      || typeof mimeType !== 'string'
      || typeof size !== 'number' || !Number.isInteger(size) || size < 0
      || !isNonEmptyString(createdAt)
      || candidate['encoding'] !== 'base64'
      || typeof blobBase64 !== 'string') {
      throw invalidAttachmentUploadOutbox(`row ${index} is malformed`);
    }
    const identity = JSON.stringify([ownerUserId, blobKey, operationId]);
    if (identities.has(identity)) throw invalidAttachmentUploadOutbox('duplicate storage identity');
    identities.add(identity);
    let blob: Blob;
    try {
      blob = base64ToBlob(blobBase64, mimeType);
    } catch {
      throw invalidAttachmentUploadOutbox(`row ${index} has invalid base64`);
    }
    if (blob.size !== size) throw invalidAttachmentUploadOutbox(`row ${index} size does not match bytes`);
    return { ownerUserId, operationId, attachmentId, blobKey, fileName, mimeType, size, createdAt, blob };
  });
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function invalidAttachmentUploadOutbox(reason: string): Error {
  return new Error(`attachment upload outbox is invalid: ${reason}`);
}

export function isRestorableConflictRecord(
  conflict: unknown,
  ownerUserId: string,
): conflict is ConflictRecord {
  if (!conflict || typeof conflict !== 'object') {
    return false;
  }

  const record = conflict as Partial<ConflictRecord>;
  if (record.ownerUserId !== ownerUserId) {
    return false;
  }

  return typeof record.projectId === 'string'
    && record.projectId.length > 0
    && isRestorableConflictProject(record.localProject, record.projectId)
    && (record.remoteProject === undefined
      || isRestorableConflictProject(record.remoteProject, record.projectId))
    && typeof record.conflictedAt === 'string'
    && record.conflictedAt.length > 0
    && typeof record.localVersion === 'number'
    && isRestorableConflictReason(record.reason)
    && isRestorableOperationConflicts(record.operationConflicts, record.projectId);
}

function isRestorableOperationConflicts(
  operationConflicts: ConflictRecord['operationConflicts'],
  projectId: string,
): operationConflicts is OperationConflictRecord[] | undefined {
  if (operationConflicts === undefined) {
    return true;
  }

  if (!Array.isArray(operationConflicts)) {
    return false;
  }

  return operationConflicts.every(conflict => isRestorableOperationConflict(conflict, projectId));
}

function isRestorableOperationConflict(
  conflict: unknown,
  projectId: string,
): conflict is OperationConflictRecord {
  if (!conflict || typeof conflict !== 'object') {
    return false;
  }

  const record = conflict as Partial<OperationConflictRecord>;
  return isRestorableOperationActionType(record.actionType)
    && isRestorableOperationEntityType(record.entityType)
    && typeof record.entityId === 'string'
    && record.entityId.length > 0
    && record.projectId === projectId
    && isRestorableOperationEntity(record.localEntity, record.entityType)
    && (record.remoteEntity === undefined
      || isRestorableOperationEntity(record.remoteEntity, record.entityType))
    && typeof record.message === 'string'
    && record.message.length > 0
    && typeof record.conflictedAt === 'string'
    && record.conflictedAt.length > 0
    && isRestorableOperationReason(record.reason);
}

function isRestorableConflictProject(value: unknown, projectId: string): boolean {
  return isUnknownRecord(value)
    && value['id'] === projectId
    && Array.isArray(value['tasks'])
    && Array.isArray(value['connections'])
    && value['tasks'].every(task => isUnknownRecord(task) && typeof task['content'] === 'string');
}

function isRestorableOperationEntity(value: unknown, entityType: unknown): boolean {
  return isUnknownRecord(value)
    && (entityType !== 'task' || typeof value['content'] === 'string');
}

function isRestorableConflictReason(reason: unknown): reason is ConflictRecord['reason'] {
  return reason === 'version_mismatch'
    || reason === 'concurrent_edit'
    || reason === 'network_recovery'
    || reason === 'status_conflict'
    || reason === 'field_conflict';
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
  if (typeof task.content !== 'string') {
    throw new Error(`Backup task ${task.id || '<unknown>'} is missing required content`);
  }

  return {
    id: task.id,
    title: task.title,
    content: task.content,
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
