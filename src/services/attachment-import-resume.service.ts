import { Injectable } from '@angular/core';
import { createStore, del, entries, get, set } from 'idb-keyval';
import type { Attachment } from '../models';

export type AttachmentImportCheckpointItemStatus =
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface AttachmentImportSourceDescriptor {
  index: number;
  itemKey: string;
  projectId: string;
  taskId: string;
  attachmentId: string;
  attachmentName: string;
  size: number;
  mimeType: string;
  zipPath: string | null;
  dataDigest: string;
}

export interface AttachmentImportPackageIdentity {
  packageDigest: string;
  descriptors: AttachmentImportSourceDescriptor[];
}

export interface AttachmentImportCheckpointItem extends AttachmentImportSourceDescriptor {
  operationId: string;
  status: AttachmentImportCheckpointItemStatus;
  error?: string;
  queuedUpload?: {
    ownerUserId: string;
    actionId: string;
    blobKey: string;
    operationId: string;
  };
  pendingUpload?: {
    ownerUserId: string;
    blobKey: string;
    operationId: string;
  };
  attachment?: Attachment;
  compensationStatus?: 'completed' | 'failed' | 'unknown';
}

export interface AttachmentImportCheckpoint {
  version: 1;
  kind: 'attachment-import-resume';
  ownerUserId: string;
  projectId: string;
  packageDigest: string;
  createdAt: string;
  updatedAt: string;
  state: 'active';
  items: AttachmentImportCheckpointItem[];
  lastError?: string;
}

export type AttachmentImportResumeLookup =
  | { status: 'new' }
  | { status: 'resume'; checkpoint: AttachmentImportCheckpoint }
  | { status: 'owner-mismatch'; checkpoint: AttachmentImportCheckpoint }
  | { status: 'changed-package'; checkpoint: AttachmentImportCheckpoint }
  | { status: 'invalid' }
  | { status: 'storage-failed' };

export const ATTACHMENT_IMPORT_RESUME_DB_NAME = 'nanoflow-attachment-import-resume';
export const ATTACHMENT_IMPORT_RESUME_STORE_NAME = 'checkpoints';
const RESUME_KEY_PREFIX = 'nanoflow.attachment-import-resume.v1:';
const resumeStore = createStore(ATTACHMENT_IMPORT_RESUME_DB_NAME, ATTACHMENT_IMPORT_RESUME_STORE_NAME);

/**
 * Durable, owner-scoped state for an attachment import package.
 *
 * The checkpoint intentionally stores source metadata and digests only. The
 * extracted bytes remain owned by the import package and by the existing
 * attachment upload outbox; this service never creates a second blob store.
 */
@Injectable({ providedIn: 'root' })
export class AttachmentImportResumeService {
  async buildPackageIdentity(
    projectId: string,
    items: ReadonlyArray<{
      projectId?: string;
      taskId: string;
      metadata: { id: string; name: string; size: number; mimeType: string };
      data?: Blob;
      zipPath?: string;
    }>,
  ): Promise<AttachmentImportPackageIdentity> {
    if (!isNonEmptyString(projectId)) {
      throw new Error('附件导入项目 ID 无效');
    }

    const descriptors: AttachmentImportSourceDescriptor[] = [];
    for (const [index, item] of items.entries()) {
      validateSourceItem(item, index);
      const targetProjectId = item.projectId ?? projectId;
      if (!isNonEmptyString(targetProjectId)) {
        throw new Error(`附件导入项目 ID 无效（第 ${index + 1} 项）`);
      }

      const dataDigest = item.data
        ? await digestBytes(await item.data.arrayBuffer())
        : 'missing';
      const itemKey = buildItemKey(index, targetProjectId, item.taskId, item.metadata.id);
      descriptors.push({
        index,
        itemKey,
        projectId: targetProjectId,
        taskId: item.taskId,
        attachmentId: item.metadata.id,
        attachmentName: item.metadata.name,
        size: item.metadata.size,
        mimeType: item.metadata.mimeType,
        zipPath: item.zipPath ?? null,
        dataDigest,
      });
    }

    const packageDigest = await digestText(canonicalize({
      projectId,
      descriptors,
    }));
    return { packageDigest, descriptors };
  }

  createCheckpoint(
    ownerUserId: string,
    projectId: string,
    identity: AttachmentImportPackageIdentity,
    now = new Date().toISOString(),
  ): AttachmentImportCheckpoint {
    if (!isNonEmptyString(ownerUserId)) throw new Error('附件导入 owner 无效');
    if (!isNonEmptyString(projectId)) throw new Error('附件导入项目 ID 无效');

    return {
      version: 1,
      kind: 'attachment-import-resume',
      ownerUserId,
      projectId,
      packageDigest: identity.packageDigest,
      createdAt: now,
      updatedAt: now,
      state: 'active',
      items: identity.descriptors.map(descriptor => ({
        ...descriptor,
        operationId: buildOperationId(identity.packageDigest, descriptor),
        status: descriptor.dataDigest === 'missing' ? 'skipped' : 'pending',
      })),
    };
  }

  matchesPackageIdentity(
    checkpoint: AttachmentImportCheckpoint,
    identity: AttachmentImportPackageIdentity,
  ): boolean {
    if (checkpoint.packageDigest !== identity.packageDigest
      || checkpoint.items.length !== identity.descriptors.length) {
      return false;
    }
    return checkpoint.items.every((item, index) => {
      const descriptor = identity.descriptors[index];
      return descriptor !== undefined
        && canonicalize(toDescriptor(item)) === canonicalize(descriptor)
        && item.operationId === buildOperationId(identity.packageDigest, descriptor);
    });
  }

  async inspect(
    ownerUserId: string,
    projectId: string,
    packageDigest: string,
  ): Promise<AttachmentImportResumeLookup> {
    if (!isNonEmptyString(ownerUserId) || !isNonEmptyString(projectId) || !isNonEmptyString(packageDigest)) {
      return { status: 'invalid' };
    }

    const loaded = await this.readAll();
    if (loaded.storageFailed) return { status: 'storage-failed' };
    if (loaded.invalid) return { status: 'invalid' };

    const samePackage = loaded.records.find(record =>
      record.projectId === projectId
      && record.packageDigest === packageDigest
      && record.ownerUserId === ownerUserId)
      ?? loaded.records.find(record =>
        record.projectId === projectId && record.packageDigest === packageDigest);
    if (samePackage) {
      return samePackage.ownerUserId === ownerUserId
        ? { status: 'resume', checkpoint: samePackage }
        : { status: 'owner-mismatch', checkpoint: samePackage };
    }

    const sameProject = loaded.records.find(record =>
      record.projectId === projectId && record.ownerUserId === ownerUserId);
    if (sameProject) return { status: 'changed-package', checkpoint: sameProject };

    return { status: 'new' };
  }

  async saveCheckpoint(checkpoint: AttachmentImportCheckpoint): Promise<void> {
    assertCheckpoint(checkpoint);
    const key = this.getStorageKey(checkpoint.ownerUserId, checkpoint.projectId, checkpoint.packageDigest);
    const stored = cloneCheckpoint(checkpoint);
    if (!getLocalStorage() || typeof indexedDB === 'undefined') {
      throw new Error('附件导入检查点双存储不可用');
    }

    await set(key, stored, resumeStore);
    const idbReadback = await get<unknown>(key, resumeStore);
    if (!isCheckpoint(idbReadback) || canonicalize(idbReadback) !== canonicalize(stored)) {
      throw new Error('附件导入检查点 IndexedDB 读回校验失败');
    }

    if (!this.saveFallbackRecord(key, stored)) {
      throw new Error('附件导入检查点 localStorage 写入失败');
    }
    const readback = await this.readMirrorRecord(key);
    if (!readback || canonicalize(readback) !== canonicalize(stored)) {
      throw new Error('附件导入检查点双存储读回不一致');
    }
  }

  async readCheckpoint(
    ownerUserId: string,
    projectId: string,
    packageDigest: string,
  ): Promise<AttachmentImportCheckpoint | null> {
    const key = this.getStorageKey(ownerUserId, projectId, packageDigest);
    const candidate = await this.readMirrorRecord(key);
    if (!candidate) return null;
    if (candidate.ownerUserId !== ownerUserId
      || candidate.projectId !== projectId
      || candidate.packageDigest !== packageDigest) {
      throw new Error('附件导入检查点身份不匹配');
    }
    return candidate;
  }

  async removeCheckpoint(
    ownerUserId: string,
    projectId: string,
    packageDigest: string,
  ): Promise<void> {
    const key = this.getStorageKey(ownerUserId, projectId, packageDigest);
    if (!getLocalStorage() || typeof indexedDB === 'undefined') {
      throw new Error('附件导入检查点双存储不可用');
    }
    await del(key, resumeStore);
    const idbReadback = await get<unknown>(key, resumeStore);
    if (idbReadback !== undefined) throw new Error('附件导入检查点 IndexedDB 删除未确认');
    this.removeFallbackRecord(key);
    if (this.readFallbackRecord(key) !== null) {
      throw new Error('附件导入检查点 localStorage 删除未确认');
    }
  }

  async clearCheckpointsForTests(): Promise<void> {
    try {
      const stored = await entries<string, unknown>(resumeStore);
      await Promise.all(stored.map(([key]) => del(key, resumeStore)));
    } catch {
      // The fallback is still cleared below.
    }
    const storage = getLocalStorage();
    if (storage) {
      for (const key of this.listFallbackKeys()) storage.removeItem(key);
    }
  }

  private async readAll(): Promise<{
    records: AttachmentImportCheckpoint[];
    invalid: boolean;
    storageFailed: boolean;
  }> {
    const recordsByKey = new Map<string, AttachmentImportCheckpoint>();
    const storage = getLocalStorage();
    if (!storage || typeof indexedDB === 'undefined') {
      return { records: [], invalid: false, storageFailed: true };
    }

    let idbEntries: Array<[string, unknown]>;
    try {
      idbEntries = await entries<string, unknown>(resumeStore);
    } catch {
      return { records: [], invalid: false, storageFailed: true };
    }
    const idbMap = new Map(idbEntries);
    const localKeys = this.listFallbackKeys();
    if (idbMap.size !== localKeys.length || localKeys.some(key => !idbMap.has(key))) {
      return { records: [], invalid: false, storageFailed: true };
    }
    for (const [key, idbCandidate] of idbEntries) {
      const localCandidate = this.readFallbackRecord(key);
      if (!isCheckpoint(idbCandidate) || !isCheckpoint(localCandidate)
        || canonicalize(idbCandidate) !== canonicalize(localCandidate)
        || key !== this.getStorageKey(idbCandidate.ownerUserId, idbCandidate.projectId, idbCandidate.packageDigest)) {
        return { records: [], invalid: false, storageFailed: true };
      }
      recordsByKey.set(key, cloneCheckpoint(idbCandidate));
    }

    return {
      records: [...recordsByKey.values()],
      invalid: false,
      storageFailed: false,
    };
  }

  private async readMirrorRecord(key: string): Promise<AttachmentImportCheckpoint | null> {
    if (!getLocalStorage() || typeof indexedDB === 'undefined') {
      throw new Error('附件导入检查点双存储不可用');
    }
    const idbCandidate = await get<unknown>(key, resumeStore);
    const localCandidate = this.readFallbackRecord(key);
    const idbMissing = idbCandidate === undefined;
    const localMissing = localCandidate === null;
    if (idbMissing && localMissing) return null;
    if (idbMissing !== localMissing) throw new Error('附件导入检查点镜像不一致');
    if (!isCheckpoint(idbCandidate) || !isCheckpoint(localCandidate)
      || canonicalize(idbCandidate) !== canonicalize(localCandidate)) {
      throw new Error('附件导入检查点镜像内容不一致');
    }
    return cloneCheckpoint(idbCandidate);
  }

  private getStorageKey(ownerUserId: string, projectId: string, packageDigest: string): string {
    return `${RESUME_KEY_PREFIX}${JSON.stringify([ownerUserId, projectId, packageDigest])}`;
  }

  private saveFallbackRecord(key: string, checkpoint: AttachmentImportCheckpoint): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      localStorage.setItem(key, JSON.stringify(checkpoint));
      return true;
    } catch {
      return false;
    }
  }

  private readFallbackRecord(key: string): unknown {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  private removeFallbackRecord(key: string): void {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  }

  private listFallbackKeys(): string[] {
    if (typeof localStorage === 'undefined') return [];
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(RESUME_KEY_PREFIX)) keys.push(key);
    }
    return keys;
  }
}

export async function digestAttachmentImportBytes(bytes: ArrayBuffer): Promise<string> {
  return digestBytes(bytes);
}

async function digestBytes(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 不可用');
  const digest = await subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')).join('')}`;
}

async function digestText(value: string): Promise<string> {
  return digestBytes(new TextEncoder().encode(value).buffer);
}

function buildItemKey(index: number, projectId: string, taskId: string, attachmentId: string): string {
  return `${index}:${projectId}:${taskId}:${attachmentId}`;
}

function buildOperationId(packageDigest: string, descriptor: AttachmentImportSourceDescriptor): string {
  return `attachment-import:${packageDigest}:${descriptor.index}:${encodeURIComponent(descriptor.attachmentId)}`;
}

function toDescriptor(item: AttachmentImportCheckpointItem): AttachmentImportSourceDescriptor {
  return {
    index: item.index,
    itemKey: item.itemKey,
    projectId: item.projectId,
    taskId: item.taskId,
    attachmentId: item.attachmentId,
    attachmentName: item.attachmentName,
    size: item.size,
    mimeType: item.mimeType,
    zipPath: item.zipPath,
    dataDigest: item.dataDigest,
  };
}

function validateSourceItem(
  item: {
    taskId: string;
    metadata: { id: string; name: string; size: number; mimeType: string };
    data?: Blob;
    zipPath?: string;
  },
  index: number,
): void {
  if (!isNonEmptyString(item.taskId)
    || !item.metadata
    || !isNonEmptyString(item.metadata.id)
    || !isNonEmptyString(item.metadata.name)
    || !isNonEmptyString(item.metadata.mimeType)
    || !Number.isFinite(item.metadata.size)
    || item.metadata.size < 0
    || (item.data !== undefined && !(item.data instanceof Blob))) {
    throw new Error(`附件导入包格式无效（第 ${index + 1} 项）`);
  }
}

function assertCheckpoint(checkpoint: AttachmentImportCheckpoint): void {
  if (!isCheckpoint(checkpoint)) throw new Error('附件导入检查点格式无效');
}

function isCheckpoint(candidate: unknown): candidate is AttachmentImportCheckpoint {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Partial<AttachmentImportCheckpoint>;
  if (value.version !== 1
    || value.kind !== 'attachment-import-resume'
    || value.state !== 'active'
    || !isNonEmptyString(value.ownerUserId)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.packageDigest)
    || !isNonEmptyString(value.createdAt)
    || !isNonEmptyString(value.updatedAt)
    || !Array.isArray(value.items)) {
    return false;
  }
  return value.items.every(item => isCheckpointItem(item)
    && (!item.queuedUpload || item.queuedUpload.ownerUserId === value.ownerUserId)
    && (!item.queuedUpload || !item.attachment || item.queuedUpload.blobKey === item.attachment.id));
}

function isCheckpointItem(candidate: unknown): candidate is AttachmentImportCheckpointItem {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Partial<AttachmentImportCheckpointItem>;
  const index = value.index;
  if (typeof index !== 'number'
    || !Number.isInteger(index)
    || !isNonEmptyString(value.itemKey)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.taskId)
    || !isNonEmptyString(value.attachmentId)
    || !isNonEmptyString(value.attachmentName)
    || !Number.isFinite(value.size)
    || !isNonEmptyString(value.mimeType)
    || (value.zipPath !== null && typeof value.zipPath !== 'string')
    || !isNonEmptyString(value.dataDigest)
    || !isNonEmptyString(value.operationId)
    || (value.status !== 'pending'
      && value.status !== 'in-progress'
      && value.status !== 'completed'
      && value.status !== 'failed'
      && value.status !== 'skipped')
    || (value.compensationStatus !== undefined
      && value.compensationStatus !== 'completed'
      && value.compensationStatus !== 'failed'
      && value.compensationStatus !== 'unknown')
    || (value.queuedUpload !== undefined && !isQueuedUpload(value.queuedUpload))
    || (value.pendingUpload !== undefined && !isPendingUpload(value.pendingUpload))
    || (value.attachment !== undefined && !isAttachment(value.attachment))) {
    return false;
  }
  return value.itemKey === buildItemKey(
    index,
    value.projectId,
    value.taskId,
    value.attachmentId,
  );
}

function isQueuedUpload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return isNonEmptyString(receipt['ownerUserId'])
    && isNonEmptyString(receipt['actionId'])
    && isNonEmptyString(receipt['blobKey'])
    && isNonEmptyString(receipt['operationId']);
}

function isPendingUpload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Record<string, unknown>;
  return isNonEmptyString(pending['ownerUserId'])
    && isNonEmptyString(pending['blobKey'])
    && isNonEmptyString(pending['operationId']);
}

function isAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as Partial<Attachment>;
  return isNonEmptyString(attachment.id)
    && isNonEmptyString(attachment.name)
    && typeof attachment.url === 'string'
    && isNonEmptyString(attachment.createdAt);
}

function cloneCheckpoint(checkpoint: AttachmentImportCheckpoint): AttachmentImportCheckpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as AttachmentImportCheckpoint;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function getLocalStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}
