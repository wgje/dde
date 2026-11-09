import type { Attachment } from '../models';
import { ATTACHMENT_CONFIG } from '../config';
import { SCAN_STATUS } from '../config/virus-scan.config';
import type { EnqueueParams, AttachmentUploadPayload } from './action-queue.types';
import { FILE_TYPE_VALIDATION_CONFIG } from './file-type-validator.service';
import type {
  PendingAttachmentUploadIdentity,
  SavePendingAttachmentUploadInput,
} from './attachment-upload-outbox.service';
import {
  buildAttachmentStoragePath,
  isValidAttachmentPathSegment,
} from './attachment-storage-path.helpers';
import { resolveAttachmentType } from './attachment-mime.helpers';
import type { ScanResponse } from './virus-scan.service';

export interface AttachmentUploadContext {
  attachmentId: string;
  filePath: string;
  abortController: AbortController;
  scanMetadata?: Attachment['scanMetadata'];
  remoteUploadDeferred?: boolean;
}

export interface AttachmentUploadSuccess {
  success: true;
  attachment: Attachment;
  queuedUpload: QueuedAttachmentUploadReceipt;
}

export interface QueuedAttachmentUploadReceipt extends PendingAttachmentUploadIdentity {
  actionId: string;
}

export interface AttachmentUploadFailure {
  success: false;
  error: string;
  cancelled?: boolean;
  attachment?: Attachment;
  pendingUpload?: PendingAttachmentUploadIdentity;
}

export type AttachmentUploadResult = AttachmentUploadSuccess | AttachmentUploadFailure;

interface QueuePendingLocalAttachmentUploadInput {
  actionQueue: {
    enqueueDurably(action: EnqueueParams): Promise<string>;
    enqueueDurablyForOwner?(ownerUserId: string, action: EnqueueParams): Promise<string>;
  };
  context: AttachmentUploadContext;
  file: File;
  projectId: string;
  taskId: string;
  operationId?: string;
  ownerFence?: { isCurrent(): boolean };
  updateProgress(fileName: string, progress: number, status: 'pending'): void;
  uploadOutbox: {
    removePendingUpload(identity: PendingAttachmentUploadIdentity): Promise<void>;
    savePendingUpload(input: SavePendingAttachmentUploadInput): Promise<void>;
  };
  userId: string;
}

interface PendingLocalAttachmentEnqueueResult {
  actionId: string;
  enqueueCommitStateUnknown: boolean;
}

interface PrepareAttachmentFileUploadInput {
  createScanMetadata(result: NonNullable<ScanResponse['result']>): Attachment['scanMetadata'];
  file: File;
  projectId: string;
  scanBeforeUpload(file: File, fileName: string): Promise<ScanResponse>;
  supabaseConfigured: boolean;
  taskId: string;
  userId: string;
  validateFile(file: File): Promise<{ valid: boolean; error?: string }>;
}

interface CreateAttachmentUploadContextInput {
  attachmentId?: string;
  file: File;
  projectId: string;
  remoteUploadDeferred?: boolean;
  scanMetadata?: Attachment['scanMetadata'];
  taskId: string;
  userId: string;
}

export function createPendingAttachmentScanMetadata(
  now = new Date().toISOString(),
): Attachment['scanMetadata'] {
  return {
    lastScannedAt: now,
    scanStatus: SCAN_STATUS.PENDING,
    scanHistory: [
      {
        scannedAt: now,
        status: SCAN_STATUS.PENDING,
        scanner: 'local-offline',
      },
    ],
  };
}

export function isRecoverableAttachmentScanFailure(errorCode: string | undefined): boolean {
  return errorCode === 'SERVICE_UNAVAILABLE'
    || errorCode === 'SCAN_TIMEOUT'
    || errorCode === 'NETWORK_ERROR';
}

export async function prepareAttachmentFileUpload(
  input: PrepareAttachmentFileUploadInput,
): Promise<AttachmentUploadFailure | { success: true; scanMetadata?: Attachment['scanMetadata']; remoteUploadDeferred?: boolean }> {
  if (input.file.size > ATTACHMENT_CONFIG.MAX_FILE_SIZE) {
    return { success: false, error: `文件大小不能超过 ${ATTACHMENT_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB` };
  }

  const typeValidationFailure = await validateAttachmentUploadFileType(input.file, input.validateFile);
  if (typeValidationFailure) {
    return typeValidationFailure;
  }

  if (!input.supabaseConfigured) {
    return createDeferredAttachmentUploadResult(input);
  }

  const scanResult = await input.scanBeforeUpload(input.file, input.file.name);
  if (!scanResult.success || scanResult.result?.status === SCAN_STATUS.THREAT_DETECTED) {
    if (isRecoverableAttachmentScanFailure(scanResult.errorCode)) {
      return createDeferredAttachmentUploadResult(input);
    }
    return { success: false, error: scanResult.error || '文件安全扫描未通过' };
  }

  const pathValidationFailure = validateAttachmentUploadPathSegments(
    input.userId,
    input.projectId,
    input.taskId,
  );
  if (pathValidationFailure) return pathValidationFailure;

  return {
    success: true,
    scanMetadata: scanResult.result ? input.createScanMetadata(scanResult.result) : undefined,
  };
}

function createDeferredAttachmentUploadResult(
  input: Pick<PrepareAttachmentFileUploadInput, 'projectId' | 'taskId' | 'userId'>,
): AttachmentUploadFailure | { success: true; scanMetadata: Attachment['scanMetadata']; remoteUploadDeferred: true } {
  const pathValidationFailure = validateAttachmentUploadPathSegments(
    input.userId,
    input.projectId,
    input.taskId,
  );
  if (pathValidationFailure) return pathValidationFailure;
  return {
    success: true,
    scanMetadata: createPendingAttachmentScanMetadata(),
    remoteUploadDeferred: true,
  };
}

export function createAttachmentUploadContext(
  input: CreateAttachmentUploadContextInput,
): AttachmentUploadContext {
  const attachmentId = input.attachmentId ?? crypto.randomUUID();
  return {
    attachmentId,
    filePath: buildAttachmentStoragePath({
      userId: input.userId,
      projectId: input.projectId,
      taskId: input.taskId,
      attachmentId,
      fileName: input.file.name,
    }),
    abortController: new AbortController(),
    scanMetadata: input.scanMetadata,
    remoteUploadDeferred: input.remoteUploadDeferred ?? false,
  };
}

export function createAttachmentUploadContextForPayload(
  payload: AttachmentUploadPayload,
  scanMetadata?: Attachment['scanMetadata'],
): AttachmentUploadContext {
  return {
    attachmentId: payload.attachment.id,
    filePath: buildAttachmentStoragePath({
      userId: payload.userId,
      projectId: payload.projectId,
      taskId: payload.taskId,
      attachmentId: payload.attachment.id,
      fileName: payload.fileName,
    }),
    abortController: new AbortController(),
    scanMetadata,
    remoteUploadDeferred: false,
  };
}

export async function queuePendingLocalAttachmentUpload(
  input: QueuePendingLocalAttachmentUploadInput,
): Promise<AttachmentUploadResult> {
  if (input.ownerFence && !input.ownerFence.isCurrent()) {
    return { success: false, error: '附件导入 owner 已变化，已拒绝入队' };
  }
  const attachment = createLocalPendingAttachment(input.file, input.context);
  const blobKey = input.context.attachmentId;
  const operationId = input.operationId ?? buildAttachmentCreateOperationId(input.context.attachmentId);
  const payload = buildAttachmentUploadPayload(input, attachment, blobKey);

  try {
    await input.uploadOutbox.savePendingUpload({
      ownerUserId: input.userId,
      operationId,
      attachmentId: input.context.attachmentId,
      blobKey,
      fileName: input.file.name,
      mimeType: input.file.type,
      size: input.file.size,
      blob: input.file,
      recovery: {
        operationId,
        payload,
      },
    });
  } catch {
    return { success: false, error: '附件上传队列持久化失败' };
  }
  if (input.ownerFence && !input.ownerFence.isCurrent()) {
    return {
      success: false,
      error: '附件导入 owner 已变化，已保留 outbox 证据',
      attachment,
      pendingUpload: {
        ownerUserId: input.userId,
        blobKey,
        operationId,
      },
    };
  }
  const { actionId, enqueueCommitStateUnknown } = await enqueuePendingLocalAttachmentAction(
    input,
    operationId,
    payload,
  );
  if (input.ownerFence && !input.ownerFence.isCurrent()) {
    return { success: false, error: '附件导入 owner 已变化，已保留 queue 证据' };
  }

  if (!actionId) {
    if (!enqueueCommitStateUnknown) {
      await input.uploadOutbox.removePendingUpload({
        ownerUserId: input.userId,
        operationId,
        blobKey,
      });
    }
    return { success: false, error: '附件上传队列持久化失败' };
  }

  input.updateProgress(input.file.name, 0, 'pending');
  return {
    success: true,
    attachment,
    queuedUpload: createQueuedAttachmentUploadReceipt(input.userId, actionId, operationId, blobKey),
  };
}

function createQueuedAttachmentUploadReceipt(
  ownerUserId: string,
  actionId: string,
  operationId: string,
  blobKey: string,
): QueuedAttachmentUploadReceipt {
  return { actionId, ownerUserId, operationId, blobKey };
}

async function enqueuePendingLocalAttachmentAction(
  input: QueuePendingLocalAttachmentUploadInput,
  operationId: string,
  payload: AttachmentUploadPayload,
): Promise<PendingLocalAttachmentEnqueueResult> {
  try {
    const action = {
      type: 'create',
      entityType: 'attachment',
      entityId: payload.attachment.id,
      operationId,
      payload,
      priority: 'normal',
    } satisfies EnqueueParams;
    const actionId = input.actionQueue.enqueueDurablyForOwner
      ? await input.actionQueue.enqueueDurablyForOwner(input.userId, action)
      : await input.actionQueue.enqueueDurably(action);
    return { actionId, enqueueCommitStateUnknown: false };
  } catch {
    return { actionId: '', enqueueCommitStateUnknown: true };
  }
}

function buildAttachmentUploadPayload(
  input: QueuePendingLocalAttachmentUploadInput,
  attachment: Attachment,
  blobKey: string,
): AttachmentUploadPayload {
  return {
    attachment,
    blobKey,
    fileName: input.file.name,
    mimeType: input.file.type,
    projectId: input.projectId,
    taskId: input.taskId,
    userId: input.userId,
    sourceUserId: input.userId,
  };
}

function buildAttachmentCreateOperationId(attachmentId: string): string {
  return `attachment:create:${attachmentId}`;
}

function createLocalPendingAttachment(file: File, context: AttachmentUploadContext): Attachment {
  const now = new Date().toISOString();
  return {
    id: context.attachmentId,
    type: resolveAttachmentType(file.type),
    name: file.name,
    url: `nanoflow-local-attachment://${context.attachmentId}`,
    mimeType: file.type,
    size: file.size,
    createdAt: now,
    signedAt: now,
    scanMetadata: context.scanMetadata,
  };
}

async function validateAttachmentUploadFileType(
  file: File,
  validateFile: PrepareAttachmentFileUploadInput['validateFile'],
): Promise<AttachmentUploadFailure | null> {
  if (!FILE_TYPE_VALIDATION_CONFIG.ENABLED) return null;

  const typeValidation = await validateFile(file);
  if (typeValidation.valid) return null;

  return { success: false, error: typeValidation.error || '文件类型验证失败' };
}

function validateAttachmentUploadPathSegments(
  userId: string,
  projectId: string,
  taskId: string,
): AttachmentUploadFailure | null {
  if (!isValidAttachmentPathSegment(userId)) return { success: false, error: '用户 ID 包含不安全字符' };
  if (!isValidAttachmentPathSegment(projectId)) return { success: false, error: '项目 ID 包含不安全字符' };
  if (!isValidAttachmentPathSegment(taskId)) return { success: false, error: '任务 ID 包含不安全字符' };
  return null;
}
