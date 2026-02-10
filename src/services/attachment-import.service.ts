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
import { Injectable, inject, signal } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { SupabaseClientService } from './supabase-client.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { Attachment } from '../models';
import { ATTACHMENT_CONFIG } from '../config/attachment.config';

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
  status: 'success' | 'failed' | 'skipped';
  taskId: string;
  attachmentName: string;
  attachment?: Attachment;
  error?: string;
}

interface ZipEntryData {
  data: Uint8Array;
  uncompressedSize: number;
  compressionMethod: number;
}

interface AttachmentBundleManifestItem {
  id: string;
  taskIds: string[];
  projectIds: string[];
  name: string;
  mimeType: string;
  size: number;
  bundlePath: string;
  downloadStatus?: 'pending' | 'success' | 'failed' | 'skipped';
}

interface AttachmentBundleManifest {
  attachments: AttachmentBundleManifestItem[];
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class AttachmentImportService {
  private readonly logger = inject(LoggerService).category('AttachmentImport');
  private readonly toast = inject(ToastService);
  private readonly attachmentService = inject(AttachmentService);
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  
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
        failed: 0,
        skipped: items.length,
        errors: [{ taskId: '', attachmentName: '', error: '未登录' }]
      };
    }
    
    this._isImporting.set(true);
    this.abortController = new AbortController();
    
    const result: AttachmentImportResult = {
      success: false,
      imported: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };
    
    try {
      // 阶段 1：过滤有效项
      const validItems = items.filter(item => item.data);
      const skippedCount = items.length - validItems.length;
      result.skipped = skippedCount;
      
      if (validItems.length === 0) {
        this.logger.info('无有效附件需要导入');
        this._progress.set({
          stage: 'completed',
          percentage: 100,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
          skippedItems: skippedCount,
        });
        result.success = true;
        return result;
      }
      
      this.updateProgress('checking-quota', 5, undefined, validItems.length);
      
      // 阶段 2：配额检查
      const totalSize = validItems.reduce((sum, item) => sum + item.metadata.size, 0);
      const quotaCheck = await this.checkQuota(totalSize);
      
      if (!quotaCheck.hasQuota) {
        this.toast.error(
          '存储配额不足',
          quotaCheck.message ?? '请清理一些附件后重试',
          { duration: 5000 }
        );
        result.errors.push({
          taskId: '',
          attachmentName: '',
          error: quotaCheck.message ?? '存储配额不足',
        });
        return result;
      }
      if (quotaCheck.message) {
        this.toast.warning('存储空间提醒', quotaCheck.message);
      }
      
      // 阶段 3：分批上传
      this.updateProgress('uploading', 10, undefined, validItems.length);
      
      const batches = this.createBatches(validItems, ATTACHMENT_IMPORT_CONFIG.BATCH_SIZE);
      let processedCount = 0;
      
      for (const batch of batches) {
        if (this.abortController?.signal.aborted) {
          this.logger.info('导入已被用户取消');
          break;
        }
        
        // 并发处理批次内的项目
        const batchResults = await this.processBatch(
          userId,
          projectId,
          batch
        );
        
        for (const batchResult of batchResults) {
          processedCount++;
          
          if (batchResult.status === 'success') {
            result.imported++;
          } else if (batchResult.status === 'skipped') {
            result.skipped++;
          } else {
            result.failed++;
            result.errors.push({
              taskId: batchResult.taskId,
              attachmentName: batchResult.attachmentName,
              error: batchResult.error ?? '上传失败',
            });
          }

          const percentage = 10 + (processedCount / validItems.length) * 85;
          this._progress.update(p => ({
            ...p,
            stage: 'uploading',
            percentage: Math.min(100, Math.max(0, percentage)),
            currentItem: batchResult.attachmentName,
            totalItems: validItems.length,
            completedItems: result.imported,
            failedItems: result.failed,
            skippedItems: result.skipped,
          }));
        }
      }
      
      // 完成
      this._progress.update(p => ({
        ...p,
        stage: 'completed',
        percentage: 100,
        totalItems: validItems.length,
        completedItems: result.imported,
        failedItems: result.failed,
        skippedItems: result.skipped,
      }));
      result.success = result.failed === 0;
      
      this.logger.info('附件导入完成', {
        imported: result.imported,
        failed: result.failed,
        skipped: result.skipped,
      });
      
      return result;
      
    } catch (error) {
      this.logger.error('附件导入失败', error);
      this._progress.update(p => ({
        ...p,
        stage: 'error',
        percentage: 0,
        completedItems: result.imported,
        failedItems: result.failed,
        skippedItems: result.skipped,
      }));
      result.errors.push({
        taskId: '',
        attachmentName: '',
        error: error instanceof Error ? error.message : '未知错误',
      });
      return result;
      
    } finally {
      this._isImporting.set(false);
      this.abortController = null;
    }
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

    const entries = await this.parseZipEntries(zipData);
    if (entries.size === 0) {
      return [];
    }

    const manifestItems = this.buildItemsFromManifest(entries);
    if (manifestItems.length > 0) {
      this.updateProgress('extracting', 100, undefined, manifestItems.length);
      return manifestItems;
    }

    const fallbackItems = this.buildItemsFromTaskMap(entries, taskAttachmentMap);
    this.updateProgress('extracting', 100, undefined, fallbackItems.length);
    return fallbackItems;
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
    const results: BatchUploadResult[] = [];
    
    // 并发上传，但限制并发数
    const semaphore = new Semaphore(ATTACHMENT_IMPORT_CONFIG.CONCURRENT_UPLOADS);
    
    const promises = batch.map(async (item) => {
      await semaphore.acquire();
      
      try {
        if (!item.data) {
          return {
            status: 'skipped' as const,
            taskId: item.taskId,
            attachmentName: item.metadata.name,
            error: '附件数据缺失',
          };
        }
        
        // 将 Blob 转换为 File
        const file = new File([item.data], item.metadata.name, {
          type: item.metadata.mimeType,
        });
        
        // 使用 AttachmentService 上传
        const uploadResult = await this.attachmentService.uploadFile(
          userId,
          projectId,
          item.taskId,
          file
        );
        
        if (uploadResult.success && uploadResult.attachment) {
          // 上传后立即挂载到任务，保证“导入后可见且可同步”
          this.taskOpsAdapter.addTaskAttachment(item.taskId, uploadResult.attachment);
          return {
            status: 'success' as const,
            taskId: item.taskId,
            attachmentName: item.metadata.name,
            attachment: uploadResult.attachment,
          };
        } else {
          return {
            status: 'failed' as const,
            taskId: item.taskId,
            attachmentName: item.metadata.name,
            error: uploadResult.error ?? '上传失败',
          };
        }
        
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
    
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    
    return results;
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

  /**
   * 解析 ZIP 条目（支持 store/deflate）
   */
  private async parseZipEntries(zipData: ArrayBuffer): Promise<Map<string, ZipEntryData>> {
    const bytes = new Uint8Array(zipData);
    const view = new DataView(zipData);
    const entries = new Map<string, ZipEntryData>();

    const eocdOffset = this.findEndOfCentralDirectory(bytes, view);
    if (eocdOffset < 0) {
      this.logger.warn('ZIP 解析失败：未找到 EOCD');
      return entries;
    }

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    let centralOffset = view.getUint32(eocdOffset + 16, true);

    for (let i = 0; i < totalEntries; i++) {
      if (centralOffset + 46 > bytes.length) break;

      const signature = view.getUint32(centralOffset, true);
      if (signature !== 0x02014b50) break;

      const compressionMethod = view.getUint16(centralOffset + 10, true);
      const compressedSize = view.getUint32(centralOffset + 20, true);
      const uncompressedSize = view.getUint32(centralOffset + 24, true);
      const fileNameLength = view.getUint16(centralOffset + 28, true);
      const extraLength = view.getUint16(centralOffset + 30, true);
      const commentLength = view.getUint16(centralOffset + 32, true);
      const localHeaderOffset = view.getUint32(centralOffset + 42, true);

      const nameStart = centralOffset + 46;
      const nameEnd = nameStart + fileNameLength;
      if (nameEnd > bytes.length) break;

      const filename = new TextDecoder().decode(bytes.slice(nameStart, nameEnd));

      if (localHeaderOffset + 30 > bytes.length) break;
      const localSignature = view.getUint32(localHeaderOffset, true);
      if (localSignature !== 0x04034b50) break;

      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) break;

      const compressedData = bytes.slice(dataStart, dataEnd);
      const data = await this.decompressZipEntry(compressionMethod, compressedData, uncompressedSize);

      entries.set(filename, {
        data,
        uncompressedSize,
        compressionMethod,
      });

      centralOffset += 46 + fileNameLength + extraLength + commentLength;
    }

    return entries;
  }

  /**
   * 从 manifest 构建附件导入项
   */
  private buildItemsFromManifest(entries: Map<string, ZipEntryData>): AttachmentImportItem[] {
    const manifestEntry = entries.get(ATTACHMENT_IMPORT_CONFIG.MANIFEST_FILENAME);
    if (!manifestEntry) return [];

    try {
      const manifestText = new TextDecoder().decode(manifestEntry.data);
      const manifest = JSON.parse(manifestText) as AttachmentBundleManifest;
      if (!manifest || !Array.isArray(manifest.attachments)) return [];

      const items: AttachmentImportItem[] = [];

      for (const attachment of manifest.attachments) {
        const taskIds = Array.isArray(attachment.taskIds) ? attachment.taskIds : [];
        if (taskIds.length === 0) continue;
        if (attachment.downloadStatus && attachment.downloadStatus !== 'success') continue;

        const fileEntry = entries.get(attachment.bundlePath);
        if (!fileEntry) continue;

        const mimeType = attachment.mimeType || 'application/octet-stream';
        const blob = new Blob([fileEntry.data], { type: mimeType });
        const projectId = Array.isArray(attachment.projectIds) && attachment.projectIds.length > 0
          ? attachment.projectIds[0]
          : undefined;

        for (const taskId of taskIds) {
          items.push({
            projectId,
            taskId,
            metadata: {
              id: attachment.id,
              name: attachment.name,
              size: attachment.size || fileEntry.uncompressedSize,
              mimeType,
            },
            data: blob,
            zipPath: attachment.bundlePath,
          });
        }
      }

      return items;
    } catch (error) {
      this.logger.warn('解析附件 manifest 失败，回退到 taskAttachmentMap', { error });
      return [];
    }
  }

  /**
   * 无 manifest 时，根据任务-附件映射回退提取
   */
  private buildItemsFromTaskMap(
    entries: Map<string, ZipEntryData>,
    taskAttachmentMap: Map<string, Array<{ id: string; name: string; size: number; mimeType: string }>>
  ): AttachmentImportItem[] {
    const items: AttachmentImportItem[] = [];

    for (const [taskId, attachments] of taskAttachmentMap) {
      for (const att of attachments) {
        const ext = this.getFileExtension(att.name);
        const candidatePaths = [
          `attachments/${att.id}${ext}`,
          `attachments/${att.id}`,
          `attachments/${taskId}/${att.id}${ext}`,
          `attachments/${taskId}/${att.id}`,
        ];

        const matchedPath = candidatePaths.find(path => entries.has(path));
        if (!matchedPath) continue;

        const entry = entries.get(matchedPath);
        if (!entry) continue;

        const mimeType = att.mimeType || 'application/octet-stream';
        items.push({
          taskId,
          metadata: {
            id: att.id,
            name: att.name,
            size: att.size || entry.uncompressedSize,
            mimeType,
          },
          data: new Blob([entry.data], { type: mimeType }),
          zipPath: matchedPath,
        });
      }
    }

    return items;
  }

  /**
   * 定位 ZIP End of Central Directory
   */
  private findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
    const minEocdSize = 22;
    const maxCommentLength = 0xffff;
    const searchStart = Math.max(0, bytes.length - minEocdSize - maxCommentLength);

    for (let i = bytes.length - minEocdSize; i >= searchStart; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        return i;
      }
    }

    return -1;
  }

  /**
   * 解压 ZIP 条目（支持 store 和 deflate）
   */
  private async decompressZipEntry(
    compressionMethod: number,
    compressedData: Uint8Array,
    expectedSize: number
  ): Promise<Uint8Array> {
    // Store（无压缩）
    if (compressionMethod === 0) {
      return compressedData;
    }

    // Deflate（尽量兼容第三方 ZIP）
    if (compressionMethod === 8 && typeof DecompressionStream !== 'undefined') {
      const stream = new Blob([compressedData]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      const buffer = await new Response(stream).arrayBuffer();
      const inflated = new Uint8Array(buffer);
      if (expectedSize > 0 && inflated.byteLength !== expectedSize) {
        this.logger.warn('ZIP 解压后大小与预期不一致', {
          expectedSize,
          actualSize: inflated.byteLength,
        });
      }
      return inflated;
    }

    throw new Error(`不支持的 ZIP 压缩方式: ${compressionMethod}`);
  }

  private getFileExtension(filename: string): string {
    const index = filename.lastIndexOf('.');
    if (index <= 0) return '';
    return filename.slice(index);
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
