/**
 * AttachmentImportService - 附件导入服务
 * 
 * 【Week 8-9 数据保护 - 附件导入（分批）】
 * 职责：
 * - 从 ZIP 文件中提取附件
 * - 分批上传到 Supabase Storage
 * - 配额检查和进度反馈
 * - 错误处理和重试
 * 
 * 设计理念：
 * - 分批上传避免内存溢出
 * - 配额检查在上传前
 * - 断点续传支持（后续迭代）
 */
import { Injectable, Injector, inject, signal } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { AttachmentService, type AttachmentUploadOwnerFence } from './attachment.service';
import { AuthService } from './auth.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ActionQueueService } from './action-queue.service';
import type { AttachmentUploadPayload, QueuedAction } from './action-queue.types';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import type { QueuedAttachmentUploadReceipt } from './attachment-upload-queue.helpers';
import { ProjectStateService, type ActiveProjectOwner } from './project-state.service';
import { Attachment } from '../models';
import { ATTACHMENT_CONFIG } from '../config/attachment.config';
import { extractAttachmentItemsFromZip, type AttachmentImportZipLimits } from './attachment-import-zip.helpers';
import {
  AttachmentImportResumeService,
  type AttachmentImportCheckpoint,
  type AttachmentImportCheckpointItem,
  type AttachmentImportPackageIdentity,
} from './attachment-import-resume.service';

// ============================================
// 配置
// ============================================

export const ATTACHMENT_IMPORT_CONFIG = {
  /** 并发上传数量 */
  CONCURRENT_UPLOADS: 3,
  
  /** 单批最大文件数 */
  BATCH_SIZE: 10,
  
  /** 重试次数 */
  MAX_RETRIES: 2,
  
  /** 重试延迟（毫秒） */
  RETRY_DELAY: 1000,
  
  /** 配额警告阈值（使用百分比） */
  QUOTA_WARNING_THRESHOLD: 0.8,

  /** 默认远端存储配额（100MB，无法读取服务端配额时使用） */
  REMOTE_STORAGE_LIMIT_BYTES: 100 * 1024 * 1024,

  /** 附件包 Manifest 文件名 */
  MANIFEST_FILENAME: 'manifest.json',

  /** ZIP 中最多允许的文件条目数，防止异常包拖垮解析 */
  MAX_ZIP_ENTRIES: 500,

  /** 单个 ZIP 条目解压后的最大大小 */
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES: ATTACHMENT_CONFIG.MAX_FILE_SIZE,

  /** 整个 ZIP 解压后的最大总大小 */
  MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES: 100 * 1024 * 1024,
} as const;

// ============================================
// 类型定义
// ============================================

export interface AttachmentImportItem {
  /** 项目 ID（从 ZIP manifest 解析） */
  projectId?: string;
  /** 任务 ID */
  taskId: string;
  /** 附件元数据 */
  metadata: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
  };
  /** 文件数据（从 ZIP 提取） */
  data?: Blob;
  /** 在 ZIP 中的路径 */
  zipPath?: string;
}

export interface AttachmentImportProgress {
  stage: 'idle' | 'extracting' | 'checking-quota' | 'uploading' | 'completed' | 'error';
  percentage: number;
  currentItem?: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
}

export interface AttachmentImportResult {
  success: boolean;
  imported: number;
  queued: number;
  failed: number;
  skipped: number;
  errors: Array<{
    taskId: string;
    attachmentName: string;
    error: string;
  }>;
}

export interface QuotaCheckResult {
  hasQuota: boolean;
  usedBytes: number;
  totalBytes: number;
  requiredBytes: number;
  message?: string;
}

interface BatchUploadResult {
  status: 'queued' | 'failed' | 'skipped';
  itemKey: string;
  taskId: string;
  attachmentName: string;
  attachment?: Attachment;
  queuedUpload?: QueuedAttachmentUploadReceipt;
  pendingUpload?: { ownerUserId: string; blobKey: string; operationId: string };
  compensationStatus?: 'completed' | 'failed' | 'unknown';
  error?: string;
}

interface AttachmentImportWorkItem {
  item: AttachmentImportItem;
  checkpointItem: AttachmentImportCheckpointItem;
}

interface AttachmentImportRun {
  result: AttachmentImportResult;
  validItems: AttachmentImportWorkItem[];
  checkpoint: AttachmentImportCheckpoint;
  identity: AttachmentImportPackageIdentity;
  completedBeforeRun: number;
  skippedBeforeRun: number;
  processedCount: number;
  ownerFence: AttachmentImportOwnerFence;
}

interface AttachmentImportOwnerFence extends AttachmentUploadOwnerFence {
  readonly ownerUserId: string;
  readonly projectOwner: ActiveProjectOwner;
}

interface ReconciledAttachmentUpload {
  attachment: Attachment;
  queuedUpload: QueuedAttachmentUploadReceipt;
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class AttachmentImportService {
  private readonly injector = inject(Injector);
  private readonly logger = inject(LoggerService).category('AttachmentImport');
  private readonly toast = inject(ToastService);
  private readonly attachmentService = inject(AttachmentService);
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly projectState = inject(ProjectStateService, { optional: true });
  private readonly resume = inject(AttachmentImportResumeService, { optional: true })
    ?? new AttachmentImportResumeService();
  private readonly zipLimits: AttachmentImportZipLimits = {
    maxEntries: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRIES,
    maxEntryUncompressedBytes: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    maxTotalUncompressedBytes: ATTACHMENT_IMPORT_CONFIG.MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
  };

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }
  
  // ==================== 状态 ====================
  
  private readonly _progress = signal<AttachmentImportProgress>({
    stage: 'idle',
    percentage: 0,
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    skippedItems: 0,
  });
  readonly progress = this._progress.asReadonly();
  
  private readonly _isImporting = signal(false);
  readonly isImporting = this._isImporting.asReadonly();
  
  private abortController: AbortController | null = null;
  
  // ==================== 公共方法 ====================
  
  /**
   * 导入附件
   * 
   * @param projectId 项目 ID
   * @param items 待导入的附件列表
   * @returns 导入结果
   */
  async importAttachments(
    projectId: string,
    items: AttachmentImportItem[]
  ): Promise<AttachmentImportResult> {
    if (this._isImporting()) {
      return {
        success: false,
        imported: 0,
        queued: 0,
        failed: 0,
        skipped: 0,
        errors: [{ taskId: '', attachmentName: '', error: '已有导入任务进行中' }]
      };
    }
    
    const userId = this.auth.currentUserId();
    if (!userId) {
      return {
        success: false,
        imported: 0,
        queued: 0,
        failed: 0,
        skipped: items.length,
        errors: [{ taskId: '', attachmentName: '', error: '未登录' }]
      };
    }
    
    this._isImporting.set(true);
    this.abortController = new AbortController();
    const projectOwner = this.projectState
      && typeof this.projectState.captureActiveProjectOwner === 'function'
      ? this.projectState.captureActiveProjectOwner()
      : { projectId, generation: 0 };
    const ownerFence: AttachmentImportOwnerFence = Object.freeze({
      ownerUserId: userId,
      projectOwner,
      isCurrent: () => (
        this.auth.currentUserId() === userId
        && (!this.projectState
          || typeof this.projectState.isActiveProjectOwnerCurrent !== 'function'
          || this.projectState.isActiveProjectOwnerCurrent(projectOwner))
      ),
    });
    let run: AttachmentImportRun | null = null;
    
    try {
      if (!ownerFence.isCurrent()) {
        return this.createImportFailure('附件导入 owner 已变化，已拒绝写入', items.length);
      }
      const identity = await this.resume.buildPackageIdentity(projectId, items);
      if (!ownerFence.isCurrent()) {
        return this.createImportFailure('附件导入 owner 已变化，已拒绝写入', items.length);
      }
      const lookup = await this.resume.inspect(userId, projectId, identity.packageDigest);
      if (lookup.status === 'owner-mismatch') {
        return this.createImportFailure('附件导入检查点属于其他用户，已拒绝续传', items.length);
      }
      if (lookup.status === 'changed-package') {
        return this.createImportFailure('附件导入包已改变，已拒绝续传', items.length);
      }
      if (lookup.status === 'invalid') {
        return this.createImportFailure('附件导入检查点格式无效，已保留原诊断数据', items.length);
      }
      if (lookup.status === 'storage-failed') {
        return this.createImportFailure('附件导入检查点存储不可用，已拒绝写入', items.length);
      }
      if (!ownerFence.isCurrent()) {
        return this.createImportFailure('附件导入 owner 已变化，已拒绝写入', items.length);
      }

      const checkpoint = lookup.status === 'resume'
        ? lookup.checkpoint
        : this.resume.createCheckpoint(userId, projectId, identity);
      if (checkpoint.ownerUserId !== userId || checkpoint.projectId !== projectId
        || checkpoint.packageDigest !== identity.packageDigest) {
        return this.createImportFailure('附件导入检查点身份不匹配，已拒绝写入', items.length);
      }
      if (!this.resume.matchesPackageIdentity(checkpoint, identity)) {
        return this.createImportFailure('附件导入检查点与来源包不一致，已拒绝写入', items.length);
      }
      run = this.createImportRun(items, identity, checkpoint, ownerFence);

      if (run.validItems.length === 0) {
        if (this.isCheckpointTerminal(run.checkpoint)) {
          await this.resume.removeCheckpoint(userId, projectId, identity.packageDigest);
        }
        this.finishEmptyImport(run);
        return run.result;
      }

      await this.persistCheckpoint(run);
      
      const hasQuota = await this.ensureImportQuota(run);
      if (!hasQuota) {
        try {
          await this.persistCheckpoint(run, run.result.errors.at(-1)?.error);
        } catch (persistError) {
          this.logger.error('附件导入配额失败诊断持久化失败', persistError);
        }
        return run.result;
      }
      
      await this.uploadImportBatches(userId, projectId, run);
      await this.finishImportRun(run);
      this.logger.info('附件导入完成', {
        imported: run.result.imported,
        queued: run.result.queued,
        failed: run.result.failed,
        skipped: run.result.skipped,
      });
      
      return run.result;
      
    } catch (error) {
      if (run) return this.failImportRun(run, error);
      return this.createImportFailure(
        error instanceof Error ? error.message : '未知错误',
        items.length,
      );
      
    } finally {
      this._isImporting.set(false);
      this.abortController = null;
    }
  }

  private createImportRun(
    items: AttachmentImportItem[],
    identity: AttachmentImportPackageIdentity,
    checkpoint: AttachmentImportCheckpoint,
    ownerFence: AttachmentImportOwnerFence,
  ): AttachmentImportRun {
    const checkpointByKey = new Map(checkpoint.items.map(item => [item.itemKey, item]));
    const validItems: AttachmentImportWorkItem[] = [];
    for (const [index, item] of items.entries()) {
      const descriptor = identity.descriptors[index];
      const checkpointItem = descriptor ? checkpointByKey.get(descriptor.itemKey) : undefined;
      if (!checkpointItem || checkpointItem.status === 'completed' || checkpointItem.status === 'skipped') {
        continue;
      }
      if (item.data) validItems.push({ item, checkpointItem });
    }

    const completedBeforeRun = checkpoint.items.filter(item => item.status === 'completed').length;
    const skippedBeforeRun = checkpoint.items.filter(item => item.status === 'skipped').length;
    return {
      validItems,
      checkpoint,
      identity,
      completedBeforeRun,
      skippedBeforeRun,
      processedCount: completedBeforeRun,
      ownerFence,
      result: {
        success: false,
        imported: completedBeforeRun,
        queued: completedBeforeRun,
        failed: 0,
        skipped: skippedBeforeRun,
        errors: [],
      },
    };
  }

  private createImportFailure(error: string, skipped: number): AttachmentImportResult {
    return {
      success: false,
      imported: 0,
      queued: 0,
      failed: 0,
      skipped,
      errors: [{ taskId: '', attachmentName: '', error }],
    };
  }

  private async persistCheckpoint(run: AttachmentImportRun, lastError?: string): Promise<void> {
    if (lastError) run.checkpoint.lastError = lastError;
    run.checkpoint.updatedAt = new Date().toISOString();
    await this.resume.saveCheckpoint(run.checkpoint);
  }

  private isCheckpointTerminal(checkpoint: AttachmentImportCheckpoint): boolean {
    return checkpoint.items.every(item => item.status === 'completed' || item.status === 'skipped');
  }

  private finishEmptyImport(run: AttachmentImportRun): boolean {
    if (run.validItems.length > 0) return false;

    this.logger.info('无有效附件需要导入');
    this._progress.set({
      stage: 'completed',
      percentage: 100,
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      skippedItems: run.result.skipped,
    });
    run.result.success = true;
    return true;
  }

  private async ensureImportQuota(run: AttachmentImportRun): Promise<boolean> {
    this.updateProgress('checking-quota', 5, undefined, run.validItems.length);

    const totalSize = run.validItems.reduce((sum, workItem) => sum + workItem.item.metadata.size, 0);
    const quotaCheck = await this.checkQuota(totalSize);
    if (!run.ownerFence.isCurrent()) {
      run.result.errors.push({ taskId: '', attachmentName: '', error: '附件导入 owner 已变化，已停止写入' });
      return false;
    }
    if (!quotaCheck.hasQuota) {
      this.toast.error(
        '存储配额不足',
        quotaCheck.message ?? '请清理一些附件后重试',
        { duration: 5000 }
      );
      run.result.errors.push({
        taskId: '',
        attachmentName: '',
        error: quotaCheck.message ?? '存储配额不足',
      });
      return false;
    }

    if (quotaCheck.message) {
      this.toast.warning('存储空间提醒', quotaCheck.message);
    }

    return true;
  }

  private async uploadImportBatches(userId: string, projectId: string, run: AttachmentImportRun): Promise<void> {
    const totalItems = run.checkpoint.items.filter(item => item.dataDigest !== 'missing').length;
    this.updateProgress('uploading', 10, undefined, totalItems);

    const batches = this.createBatches(run.validItems, ATTACHMENT_IMPORT_CONFIG.BATCH_SIZE);

    for (const batch of batches) {
      if (this.abortController?.signal.aborted) {
        this.logger.info('导入已被用户取消');
        break;
      }

      for (const workItem of batch) {
        workItem.checkpointItem.status = 'in-progress';
        delete workItem.checkpointItem.error;
      }
      await this.persistCheckpoint(run);

      const batchResults = await this.processBatch(userId, projectId, batch, run.ownerFence);
      for (const batchResult of batchResults) {
        run.processedCount++;
        await this.applyBatchResult(run, batchResult, run.processedCount);
      }
    }
  }

  private async applyBatchResult(
    run: AttachmentImportRun,
    batchResult: BatchUploadResult,
    processedCount: number,
  ): Promise<void> {
    const checkpointItem = run.checkpoint.items.find(item => item.itemKey === batchResult.itemKey);
    if (!checkpointItem) {
      throw new Error('附件导入检查点条目不存在');
    }

    if (batchResult.status === 'queued') {
      run.result.imported++;
      run.result.queued++;
      checkpointItem.status = 'completed';
      checkpointItem.attachment = batchResult.attachment;
      checkpointItem.queuedUpload = batchResult.queuedUpload;
      checkpointItem.pendingUpload = batchResult.pendingUpload;
      delete checkpointItem.error;
    } else if (batchResult.status === 'skipped') {
      run.result.skipped++;
      checkpointItem.status = 'skipped';
      checkpointItem.error = batchResult.error;
    } else {
      run.result.failed++;
      run.result.errors.push({
        taskId: batchResult.taskId,
        attachmentName: batchResult.attachmentName,
        error: batchResult.error ?? '上传失败',
      });
      checkpointItem.status = 'failed';
      checkpointItem.error = batchResult.error ?? '上传失败';
      checkpointItem.queuedUpload = batchResult.queuedUpload;
      checkpointItem.pendingUpload = batchResult.pendingUpload;
      checkpointItem.attachment = batchResult.attachment;
      checkpointItem.compensationStatus = batchResult.compensationStatus;
    }

    const totalItems = run.checkpoint.items.filter(item => item.dataDigest !== 'missing').length;
    const percentage = 10 + (processedCount / Math.max(1, totalItems)) * 85;
    this._progress.update(p => ({
      ...p,
      stage: 'uploading',
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem: batchResult.attachmentName,
      totalItems,
      completedItems: run.result.imported,
      failedItems: run.result.failed,
      skippedItems: run.result.skipped,
    }));
    await this.persistCheckpoint(run);
  }

  private async finishImportRun(run: AttachmentImportRun): Promise<void> {
    const terminal = this.isCheckpointTerminal(run.checkpoint);
    const totalItems = run.checkpoint.items.filter(item => item.dataDigest !== 'missing').length;
    this._progress.update(p => ({
      ...p,
      stage: 'completed',
      percentage: 100,
      totalItems,
      completedItems: run.result.imported,
      failedItems: run.result.failed,
      skippedItems: run.result.skipped,
    }));
    run.result.success = terminal && run.result.failed === 0;

    if (terminal && run.result.failed === 0) {
      await this.resume.removeCheckpoint(
        run.checkpoint.ownerUserId,
        run.checkpoint.projectId,
        run.checkpoint.packageDigest,
      );
    } else {
      await this.persistCheckpoint(run);
    }
  }

  private async failImportRun(run: AttachmentImportRun, error: unknown): Promise<AttachmentImportResult> {
    this.logger.error('附件导入失败', error);
    this._progress.update(p => ({
      ...p,
      stage: 'error',
      percentage: 0,
      completedItems: run.result.imported,
      failedItems: run.result.failed,
      skippedItems: run.result.skipped,
    }));
    run.result.errors.push({
      taskId: '',
      attachmentName: '',
      error: error instanceof Error ? error.message : '未知错误',
    });
    try {
      await this.persistCheckpoint(run, error instanceof Error ? error.message : '未知错误');
    } catch (persistError) {
      this.logger.error('附件导入检查点持久化失败', persistError);
    }
    return run.result;
  }
  
  /**
   * 取消导入
   */
  cancelImport(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.logger.info('用户取消了附件导入');
    }
  }
  
  /**
   * 重置进度
   */
  resetProgress(): void {
    this._progress.set({
      stage: 'idle',
      percentage: 0,
      totalItems: 0,
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0,
    });
  }
  
  /**
   * 检查存储配额
   * 
   * @param requiredBytes 需要的字节数
   */
  async checkQuota(requiredBytes: number): Promise<QuotaCheckResult> {
    const storageLimit = ATTACHMENT_IMPORT_CONFIG.REMOTE_STORAGE_LIMIT_BYTES;
    let usedBytes = 0;

    const userId = this.auth.currentUserId();
    if (userId && this.supabase.isConfigured) {
      try {
        usedBytes = await this.estimateRemoteStorageUsage(userId);
      } catch (error) {
        this.logger.warn('估算远端存储占用失败，回退到浏览器估算', { error });
        usedBytes = await this.estimateBrowserStorageUsage();
      }
    } else {
      usedBytes = await this.estimateBrowserStorageUsage();
    }

    const remainingBytes = storageLimit - usedBytes;
    const hasQuota = remainingBytes >= requiredBytes;
    
    if (!hasQuota) {
      return {
        hasQuota: false,
        usedBytes,
        totalBytes: storageLimit,
        requiredBytes,
        message: `存储空间不足：需要 ${this.formatBytes(requiredBytes)}，剩余 ${this.formatBytes(remainingBytes)}`,
      };
    }
    
    // 检查警告阈值
    const usageRatio = (usedBytes + requiredBytes) / storageLimit;
    if (usageRatio > ATTACHMENT_IMPORT_CONFIG.QUOTA_WARNING_THRESHOLD) {
      return {
        hasQuota: true,
        usedBytes,
        totalBytes: storageLimit,
        requiredBytes,
        message: `警告：导入后存储使用率将达到 ${Math.round(usageRatio * 100)}%`,
      };
    }
    
    return {
      hasQuota: true,
      usedBytes,
      totalBytes: storageLimit,
      requiredBytes,
    };
  }
  
  /**
   * 从 ZIP 数据中提取附件信息
   * 这是一个占位方法，实际实现需要 ZIP 解析库
   * 
   * @param zipData ZIP 文件数据
   * @returns 附件导入项列表
   */
  async extractAttachmentsFromZip(
    zipData: ArrayBuffer,
    taskAttachmentMap: Map<string, Array<{ id: string; name: string; size: number; mimeType: string }>>
  ): Promise<AttachmentImportItem[]> {
    this.updateProgress('extracting', 5);

    const items = await extractAttachmentItemsFromZip(zipData, taskAttachmentMap, {
      limits: this.zipLimits,
      logger: this.logger,
    });
    this.updateProgress('extracting', 100, undefined, items.length);
    return items;
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 创建批次
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
  
  /**
   * 处理单个批次
   */
  private async processBatch(
    userId: string,
    projectId: string,
    batch: AttachmentImportWorkItem[],
    ownerFence: AttachmentImportOwnerFence,
  ): Promise<BatchUploadResult[]> {
    // 并发上传，但限制并发数
    const semaphore = new Semaphore(ATTACHMENT_IMPORT_CONFIG.CONCURRENT_UPLOADS);
    
    const promises = batch.map(async (workItem) => {
      await semaphore.acquire();
      
      try {
        return await this.processBatchItem(userId, projectId, workItem, ownerFence);
      } catch (error) {
        return {
          status: 'failed' as const,
          itemKey: workItem.checkpointItem.itemKey,
          taskId: workItem.item.taskId,
          attachmentName: workItem.item.metadata.name,
          error: error instanceof Error ? error.message : '未知错误',
        };
        
      } finally {
        semaphore.release();
      }
    });
    
    return Promise.all(promises);
  }

  private async processBatchItem(
    userId: string,
    projectId: string,
    workItem: AttachmentImportWorkItem,
    ownerFence: AttachmentImportOwnerFence,
  ): Promise<BatchUploadResult> {
    const item = workItem.item;
    const itemKey = workItem.checkpointItem.itemKey;
    if (!ownerFence.isCurrent()) {
      return {
        status: 'failed',
        itemKey,
        taskId: item.taskId,
        attachmentName: item.metadata.name,
        error: '附件导入 owner 已变化，已停止写入',
      };
    }

    const reconciled = await this.reconcileRetainedUpload(workItem.checkpointItem, ownerFence);
    if (reconciled) {
      return this.writeImportedAttachment(
        projectId,
        item,
        itemKey,
        reconciled.attachment,
        reconciled.queuedUpload,
        workItem.checkpointItem.operationId,
        ownerFence,
      );
    }
    if (!item.data) {
      return {
        status: 'skipped',
        itemKey,
        taskId: item.taskId,
        attachmentName: item.metadata.name,
        error: '附件数据缺失',
      };
    }

    const targetProjectId = item.projectId ?? projectId;
    if (!this.hasImportTarget(targetProjectId, item.taskId)) {
      return this.createMissingTargetResult(item, itemKey);
    }

    const file = new File([item.data], item.metadata.name, {
      type: item.metadata.mimeType,
    });
    const uploadResult = await this.attachmentService.uploadFile(
      userId,
      targetProjectId,
      item.taskId,
      file,
      {
        attachmentId: workItem.checkpointItem.attachment?.id ?? item.metadata.id,
        operationId: workItem.checkpointItem.operationId,
        ownerFence,
      },
    );

    if (!uploadResult.success) {
      return {
        status: 'failed',
        itemKey,
        taskId: item.taskId,
        attachmentName: item.metadata.name,
        error: uploadResult.error,
        attachment: uploadResult.attachment,
        pendingUpload: uploadResult.pendingUpload,
      };
    }

    return this.writeImportedAttachment(
      targetProjectId,
      item,
      itemKey,
      this.restoreImportedAttachmentId(uploadResult.attachment, item),
      uploadResult.queuedUpload,
      workItem.checkpointItem.operationId,
      ownerFence,
    );
  }

  private async writeImportedAttachment(
    projectId: string,
    item: AttachmentImportItem,
    itemKey: string,
    attachment: Attachment,
    queuedUpload: QueuedAttachmentUploadReceipt,
    operationId: string,
    ownerFence: AttachmentImportOwnerFence,
  ): Promise<BatchUploadResult> {
    if (!ownerFence.isCurrent()) {
      const compensationStatus = await this.compensateQueuedUpload(queuedUpload);
      return this.createMissingTargetResult(item, itemKey, queuedUpload, attachment, compensationStatus);
    }
    const written = await this.taskOpsAdapter.addTaskAttachmentToProject(
      projectId,
      item.taskId,
      attachment,
      { operationId },
    );
    if (!written || !ownerFence.isCurrent()) {
      const compensationStatus = await this.compensateQueuedUpload(queuedUpload);
      return this.createMissingTargetResult(item, itemKey, queuedUpload, attachment, compensationStatus);
    }

    return {
      status: 'queued',
      itemKey,
      taskId: item.taskId,
      attachmentName: item.metadata.name,
      attachment,
      queuedUpload,
    };
  }

  private async reconcileRetainedUpload(
    checkpointItem: AttachmentImportCheckpointItem,
    ownerFence: AttachmentImportOwnerFence,
  ): Promise<ReconciledAttachmentUpload | null> {
    if (checkpointItem.compensationStatus === 'completed') return null;
    const receipt = checkpointItem.queuedUpload;
    const pending = checkpointItem.pendingUpload;
    const identity = receipt ?? pending;
    if (!identity) {
      if (checkpointItem.attachment && checkpointItem.status === 'failed') {
        throw new Error('附件导入保留了附件但缺少可重放 receipt，已拒绝重复上传');
      }
      return null;
    }
    if (!ownerFence.isCurrent()) throw new Error('附件导入 owner 已变化，已保留原 receipt');

    const outbox = this.injector.get(AttachmentUploadOutboxService);
    const readback = await outbox.readPendingUploadStrictly({
      ownerUserId: identity.ownerUserId,
      blobKey: identity.blobKey,
      operationId: identity.operationId,
    });
    if (readback.status !== 'found') {
      throw new Error(`附件导入 retained receipt 无法读回：${readback.status}`);
    }
    const recovery = readback.record.recovery?.payload;
    if (!recovery || !outbox.matchesPendingUploadForReplay(readback.record, identity.operationId, recovery)) {
      throw new Error('附件导入 retained receipt 身份不匹配，已拒绝重复上传');
    }

    const actionQueue = this.injector.get(ActionQueueService);
    const pendingActions = typeof actionQueue.pendingActions === 'function'
      ? actionQueue.pendingActions()
      : [];
    const existingAction = pendingActions.find(action => {
      if (action.operationId !== identity.operationId
        || action.type !== 'create'
        || action.entityType !== 'attachment'
        || action.entityId !== identity.blobKey) {
        return false;
      }
      const payload = action.payload as Partial<AttachmentUploadPayload>;
      return (payload.sourceUserId ?? payload.userId) === identity.ownerUserId
        && payload.blobKey === identity.blobKey;
    });

    let actionId = existingAction?.id ?? (receipt?.actionId ?? '');
    if (!existingAction) {
      if (!ownerFence.isCurrent()) throw new Error('附件导入 owner 已变化，已保留原 receipt');
      const action = {
        type: 'create' as const,
        entityType: 'attachment' as const,
        entityId: recovery.attachment.id,
        operationId: identity.operationId,
        payload: recovery,
        priority: 'normal' as const,
      };
      actionId = typeof actionQueue.enqueueDurablyForOwner === 'function'
        ? await actionQueue.enqueueDurablyForOwner(identity.ownerUserId, action)
        : await actionQueue.enqueueDurably(action);
      if (!actionId) throw new Error('附件导入 retained receipt action 重放失败');
    }
    if (!ownerFence.isCurrent()) throw new Error('附件导入 owner 已变化，已保留原 receipt');

    const reconciledReceipt = {
      ownerUserId: identity.ownerUserId,
      blobKey: identity.blobKey,
      operationId: identity.operationId,
      actionId,
    };
    checkpointItem.queuedUpload = reconciledReceipt;
    checkpointItem.attachment = recovery.attachment;
    return { attachment: recovery.attachment, queuedUpload: reconciledReceipt };
  }

  private hasImportTarget(projectId: string, taskId: string): boolean {
    if (!this.projectState) return true;
    return this.projectState.projects().some(project =>
      project.id === projectId && project.tasks.some(task => task.id === taskId));
  }

  private createMissingTargetResult(
    item: AttachmentImportItem,
    itemKey: string,
    queuedUpload?: QueuedAttachmentUploadReceipt,
    attachment?: Attachment,
    compensationStatus?: 'completed' | 'failed' | 'unknown',
  ): BatchUploadResult {
    return {
      status: 'failed',
      itemKey,
      taskId: item.taskId,
      attachmentName: item.metadata.name,
      queuedUpload,
      attachment,
      compensationStatus,
      error: '目标任务不存在，附件未写入项目',
    };
  }

  private async compensateQueuedUpload(
    receipt: QueuedAttachmentUploadReceipt,
  ): Promise<'completed' | 'failed' | 'unknown'> {
    if (!await this.removeQueuedUploadAction(receipt)) return 'failed';

    try {
      await this.injector.get(AttachmentUploadOutboxService).removePendingUpload({
        ownerUserId: receipt.ownerUserId,
        blobKey: receipt.blobKey,
        operationId: receipt.operationId,
      });
      return 'completed';
    } catch (error) {
      this.logger.warn('附件导入目标失效后 Blob 补偿失败', { receipt, error });
      return 'unknown';
    }
  }

  private async removeQueuedUploadAction(receipt: QueuedAttachmentUploadReceipt): Promise<boolean> {
    try {
      const actionQueue = this.injector.get(ActionQueueService);
      const result = await actionQueue.storage.persistExactQueueMutationForOwner(
        receipt.ownerUserId,
        queue => queue.filter(action => !this.matchesQueuedUpload(action, receipt)),
      );
      if (result.status === 'REJECTED_NO_COMMIT') {
        this.logger.warn('附件导入目标失效后 action 补偿持久化失败', { receipt });
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn('附件导入目标失效后 action 补偿异常', { receipt, error });
      return false;
    }
  }

  private matchesQueuedUpload(
    action: QueuedAction,
    receipt: QueuedAttachmentUploadReceipt,
  ): boolean {
    if (action.id !== receipt.actionId
      || action.operationId !== receipt.operationId
      || action.type !== 'create'
      || action.entityType !== 'attachment'
      || action.entityId !== receipt.blobKey) {
      return false;
    }
    const payload = action.payload as Partial<AttachmentUploadPayload>;
    return payload.blobKey === receipt.blobKey
      && (payload.sourceUserId ?? payload.userId) === receipt.ownerUserId;
  }

  private restoreImportedAttachmentId(uploadedAttachment: Attachment, item: AttachmentImportItem): Attachment {
    return {
      ...uploadedAttachment,
      name: item.metadata.name,
      mimeType: item.metadata.mimeType,
      size: item.metadata.size,
    };
  }
  
  /**
   * 更新进度
   */
  private updateProgress(
    stage: AttachmentImportProgress['stage'],
    percentage: number,
    currentItem?: string,
    totalItems?: number
  ): void {
    this._progress.update(p => ({
      ...p,
      stage,
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem,
      totalItems: totalItems ?? p.totalItems,
    }));
  }
  
  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 估算远端用户附件占用（递归遍历 userId 目录）
   */
  private async estimateRemoteStorageUsage(userId: string): Promise<number> {
    const queue: string[] = [userId];
    let totalBytes = 0;

    while (queue.length > 0) {
      const currentPath = queue.shift();
      if (!currentPath) continue;

      let offset = 0;
      const pageSize = 100;

      while (true) {
        const { data, error } = await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .list(currentPath, { limit: pageSize, offset });

        if (error) {
          throw error;
        }
        if (!data || data.length === 0) {
          break;
        }

        for (const item of data as unknown as Array<Record<string, unknown>>) {
          const rawName = item['name'];
          if (typeof rawName !== 'string' || rawName.length === 0) continue;

          const nextPath = `${currentPath}/${rawName}`;
          const size = Number((item['metadata'] as Record<string, unknown> | null | undefined)?.['size']);
          const isFolder = !Number.isFinite(size);

          if (isFolder) {
            queue.push(nextPath);
            continue;
          }

          totalBytes += size;
        }

        if (data.length < pageSize) break;
        offset += data.length;
      }
    }

    return totalBytes;
  }

  /**
   * 回退：估算浏览器端存储占用
   */
  private async estimateBrowserStorageUsage(): Promise<number> {
    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        return estimate.usage ?? 0;
      }
    } catch {
      // 忽略，返回 0
    }
    return 0;
  }

}

// ============================================
// 辅助类：信号量（用于并发控制）
// ============================================

class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];
  
  constructor(permits: number) {
    this.permits = permits;
  }
  
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }
  
  release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next?.();
    } else {
      this.permits++;
    }
  }
}
