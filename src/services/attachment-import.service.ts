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
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ActionQueueService } from './action-queue.service';
import type { AttachmentUploadPayload, QueuedAction } from './action-queue.types';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import type { QueuedAttachmentUploadReceipt } from './attachment-upload-queue.helpers';
import { ProjectStateService } from './project-state.service';
import { Attachment } from '../models';
import { ATTACHMENT_CONFIG } from '../config/attachment.config';
import { extractAttachmentItemsFromZip, type AttachmentImportZipLimits } from './attachment-import-zip.helpers';

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
  taskId: string;
  attachmentName: string;
  attachment?: Attachment;
  error?: string;
}

interface AttachmentImportRun {
  result: AttachmentImportResult;
  validItems: AttachmentImportItem[];
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
    const run = this.createImportRun(items);
    
    try {
      if (this.finishEmptyImport(run)) return run.result;
      
      const hasQuota = await this.ensureImportQuota(run);
      if (!hasQuota) return run.result;
      
      await this.uploadImportBatches(userId, projectId, run);
      this.finishImportRun(run);
      this.logger.info('附件导入完成', {
        imported: run.result.imported,
        queued: run.result.queued,
        failed: run.result.failed,
        skipped: run.result.skipped,
      });
      
      return run.result;
      
    } catch (error) {
      return this.failImportRun(run, error);
      
    } finally {
      this._isImporting.set(false);
      this.abortController = null;
    }
  }

  private createImportRun(items: AttachmentImportItem[]): AttachmentImportRun {
    const validItems = items.filter(item => item.data);
    return {
      validItems,
      result: {
        success: false,
        imported: 0,
        queued: 0,
        failed: 0,
        skipped: items.length - validItems.length,
        errors: [],
      },
    };
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

    const totalSize = run.validItems.reduce((sum, item) => sum + item.metadata.size, 0);
    const quotaCheck = await this.checkQuota(totalSize);
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
    this.updateProgress('uploading', 10, undefined, run.validItems.length);

    const batches = this.createBatches(run.validItems, ATTACHMENT_IMPORT_CONFIG.BATCH_SIZE);
    let processedCount = 0;

    for (const batch of batches) {
      if (this.abortController?.signal.aborted) {
        this.logger.info('导入已被用户取消');
        break;
      }

      const batchResults = await this.processBatch(userId, projectId, batch);
      for (const batchResult of batchResults) {
        processedCount++;
        this.applyBatchResult(run, batchResult, processedCount);
      }
    }
  }

  private applyBatchResult(
    run: AttachmentImportRun,
    batchResult: BatchUploadResult,
    processedCount: number,
  ): void {
    if (batchResult.status === 'queued') {
      run.result.imported++;
      run.result.queued++;
    } else if (batchResult.status === 'skipped') {
      run.result.skipped++;
    } else {
      run.result.failed++;
      run.result.errors.push({
        taskId: batchResult.taskId,
        attachmentName: batchResult.attachmentName,
        error: batchResult.error ?? '上传失败',
      });
    }

    const percentage = 10 + (processedCount / run.validItems.length) * 85;
    this._progress.update(p => ({
      ...p,
      stage: 'uploading',
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem: batchResult.attachmentName,
      totalItems: run.validItems.length,
      completedItems: run.result.imported,
      failedItems: run.result.failed,
      skippedItems: run.result.skipped,
    }));
  }

  private finishImportRun(run: AttachmentImportRun): void {
    this._progress.update(p => ({
      ...p,
      stage: 'completed',
      percentage: 100,
      totalItems: run.validItems.length,
      completedItems: run.result.imported,
      failedItems: run.result.failed,
      skippedItems: run.result.skipped,
    }));
    run.result.success = run.result.failed === 0;
  }

  private failImportRun(run: AttachmentImportRun, error: unknown): AttachmentImportResult {
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
    batch: AttachmentImportItem[]
  ): Promise<BatchUploadResult[]> {
    // 并发上传，但限制并发数
    const semaphore = new Semaphore(ATTACHMENT_IMPORT_CONFIG.CONCURRENT_UPLOADS);
    
    const promises = batch.map(async (item) => {
      await semaphore.acquire();
      
      try {
        return await this.processBatchItem(userId, projectId, item);
      } catch (error) {
        return {
          status: 'failed' as const,
          taskId: item.taskId,
          attachmentName: item.metadata.name,
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
    item: AttachmentImportItem,
  ): Promise<BatchUploadResult> {
    if (!item.data) {
      return {
        status: 'skipped',
        taskId: item.taskId,
        attachmentName: item.metadata.name,
        error: '附件数据缺失',
      };
    }

    const targetProjectId = item.projectId ?? projectId;
    if (!this.hasImportTarget(targetProjectId, item.taskId)) {
      return this.createMissingTargetResult(item);
    }

    const file = new File([item.data], item.metadata.name, {
      type: item.metadata.mimeType,
    });
    const uploadResult = await this.attachmentService.uploadFile(userId, targetProjectId, item.taskId, file);

    if (!uploadResult.success) {
      return {
        status: 'failed',
        taskId: item.taskId,
        attachmentName: item.metadata.name,
        error: uploadResult.error,
      };
    }

    const restoredAttachment = this.restoreImportedAttachmentId(uploadResult.attachment, item);
    const written = await this.taskOpsAdapter.addTaskAttachmentToProject(targetProjectId, item.taskId, restoredAttachment);
    if (!written) {
      await this.compensateQueuedUpload(uploadResult.queuedUpload);
      return this.createMissingTargetResult(item);
    }

    return {
      status: 'queued',
      taskId: item.taskId,
      attachmentName: item.metadata.name,
      attachment: restoredAttachment,
    };
  }

  private hasImportTarget(projectId: string, taskId: string): boolean {
    if (!this.projectState) return true;
    return this.projectState.projects().some(project =>
      project.id === projectId && project.tasks.some(task => task.id === taskId));
  }

  private createMissingTargetResult(item: AttachmentImportItem): BatchUploadResult {
    return {
      status: 'failed',
      taskId: item.taskId,
      attachmentName: item.metadata.name,
      error: '目标任务不存在，附件未写入项目',
    };
  }

  private async compensateQueuedUpload(receipt: QueuedAttachmentUploadReceipt): Promise<void> {
    if (!await this.removeQueuedUploadAction(receipt)) return;

    try {
      await this.injector.get(AttachmentUploadOutboxService).removePendingUpload({
        ownerUserId: receipt.ownerUserId,
        blobKey: receipt.blobKey,
        operationId: receipt.operationId,
      });
    } catch (error) {
      this.logger.warn('附件导入目标失效后 Blob 补偿失败', { receipt, error });
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
