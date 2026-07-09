/** AttachmentExportService - 附件导出（流式 ZIP、去重、进度追踪） */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { VirusScanService } from './virus-scan.service';
import { Project, Task, Attachment } from '../models';
import {
  ATTACHMENT_EXPORT_CONFIG,
  AttachmentDownloadSummary,
  AttachmentManifest,
  DownloadResult,
  ExportManifest,
  appendAttachmentManifestReference,
  buildSkippedAttachmentDownloadResult,
  calculateAttachmentTotalSize,
  createAttachmentExportManifest,
  createSimpleZip,
  generateAttachmentBundlePath,
  summarizeAttachmentDownloadResults,
  ZipFileEntry,
} from './attachment-export.helpers';

export {
  ATTACHMENT_EXPORT_CONFIG,
  appendAttachmentManifestReference,
  buildSkippedAttachmentDownloadResult,
  calculateAttachmentTotalSize,
  summarizeAttachmentDownloadResults,
} from './attachment-export.helpers';
export type {
  AttachmentManifest,
  DownloadResult,
  ExportManifest,
} from './attachment-export.helpers';

// ============================================
// 类型定义
// ============================================

/**
 * 导出进度
 */
export interface AttachmentExportProgress {
  stage: 'collecting' | 'downloading' | 'packaging' | 'complete' | 'failed';
  percentage: number;
  currentItem?: string;
  processedCount: number;
  totalCount: number;
  processedSize: number;
  totalSize: number;
  errors: string[];
}

/**
 * 导出结果
 */
export interface AttachmentExportResult {
  success: boolean;
  error?: string;
  /** 生成的 ZIP Blob */
  blob?: Blob;
  /** 文件名 */
  filename?: string;
  /** Manifest */
  manifest?: ExportManifest;
  /** 耗时（毫秒） */
  durationMs: number;
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class AttachmentExportService {
  private readonly logger = inject(LoggerService).category('AttachmentExport');
  private readonly toast = inject(ToastService);
  private readonly virusScan = inject(VirusScanService);
  
  // 状态信号
  private readonly _isExporting = signal(false);
  private readonly _progress = signal<AttachmentExportProgress>({
    stage: 'collecting',
    percentage: 0,
    processedCount: 0,
    totalCount: 0,
    processedSize: 0,
    totalSize: 0,
    errors: [],
  });
  
  // 公开的计算属性
  readonly isExporting = computed(() => this._isExporting());
  readonly progress = computed(() => this._progress());
  
  /**
   * 导出项目的附件为 ZIP
   */
  async exportAttachments(projects: Project[]): Promise<AttachmentExportResult> {
    if (this._isExporting()) {
      return {
        success: false,
        error: '导出正在进行中',
        durationMs: 0,
      };
    }
    
    const startTime = Date.now();
    this._isExporting.set(true);
    this.resetProgress();
    
    try {
      const manifest = this.prepareAttachmentManifest(projects);
      if (manifest.length === 0) {
        return this.buildEmptyExportResult(manifest, startTime);
      }

      this.ensureTotalSizeWithinLimit(manifest);
      this.initializeDownloadProgress(manifest);
      return await this.exportPreparedAttachments(manifest, startTime);
    } catch (error) {
      this.updateProgress('failed', 0);
      this.logger.error('附件导出失败', error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : '导出失败',
        durationMs: Date.now() - startTime,
      };
    } finally {
      this._isExporting.set(false);
    }
  }

  private prepareAttachmentManifest(projects: Project[]): AttachmentManifest[] {
    this.updateProgress('collecting', 0);
    return this.collectAttachments(projects);
  }

  private buildEmptyExportResult(
    manifest: AttachmentManifest[],
    startTime: number,
  ): AttachmentExportResult {
    this.updateProgress('complete', 100);
    return {
      success: true,
      error: undefined,
      manifest: createAttachmentExportManifest(manifest, 0, 0, 0),
      durationMs: Date.now() - startTime,
    };
  }

  private ensureTotalSizeWithinLimit(manifest: AttachmentManifest[]): void {
    const totalSize = calculateAttachmentTotalSize(manifest);
    if (totalSize <= ATTACHMENT_EXPORT_CONFIG.MAX_TOTAL_SIZE) {
      return;
    }

    throw new Error(`附件总大小 ${this.formatBytes(totalSize)} 超出限制 ${this.formatBytes(ATTACHMENT_EXPORT_CONFIG.MAX_TOTAL_SIZE)}`);
  }

  private initializeDownloadProgress(manifest: AttachmentManifest[]): void {
    this._progress.update(p => ({
      ...p,
      totalCount: manifest.length,
      totalSize: calculateAttachmentTotalSize(manifest),
    }));
  }

  private async exportPreparedAttachments(
    manifest: AttachmentManifest[],
    startTime: number,
  ): Promise<AttachmentExportResult> {
    this.updateProgress('downloading', 10);
    const downloadResults = await this.downloadAllAttachments(manifest);

    this.updateProgress('packaging', 80);
    const zipResult = await this.createZipBundle(downloadResults, manifest);
    const summary = summarizeAttachmentDownloadResults(downloadResults);

    this.updateProgress('complete', 100);
    this.logExportComplete(manifest.length, summary);

    return {
      success: true,
      blob: zipResult.blob,
      filename: zipResult.filename,
      manifest: createAttachmentExportManifest(manifest, summary.successCount, summary.failedCount, 0),
      durationMs: Date.now() - startTime,
    };
  }

  private logExportComplete(
    total: number,
    summary: AttachmentDownloadSummary,
  ): void {
    this.logger.info('附件导出完成', {
      total,
      success: summary.successCount,
      failed: summary.failedCount,
    });
  }
  
  /**
   * 下载并保存 ZIP
   */
  async exportAndDownload(projects: Project[]): Promise<AttachmentExportResult> {
    const result = await this.exportAttachments(projects);
    
    if (result.success && result.blob && result.filename) {
      this.triggerDownload(result.blob, result.filename);
    }
    
    return result;
  }
  
  // ==================== 收集附件 ====================
  
  /**
   * 从项目中收集所有附件（去重）
   */
  private collectAttachments(projects: Project[]): AttachmentManifest[] {
    const attachmentMap = new Map<string, AttachmentManifest>();
    
    for (const project of projects) {
      for (const task of project.tasks) {
        if (!task.attachments || task.deletedAt) continue;
        
        for (const att of task.attachments) {
          if (att.deletedAt) continue;
          this.upsertAttachmentManifest(attachmentMap, project.id, task, att);
        }
      }
    }
    
    return Array.from(attachmentMap.values());
  }

  private upsertAttachmentManifest(
    attachmentMap: Map<string, AttachmentManifest>,
    projectId: string,
    task: Task,
    attachment: Attachment,
  ): void {
    const existing = attachmentMap.get(attachment.id);
    if (existing) {
      appendAttachmentManifestReference(existing, task.id, projectId);
      return;
    }

    attachmentMap.set(attachment.id, this.createAttachmentManifest(projectId, task.id, attachment));
  }

  private createAttachmentManifest(
    projectId: string,
    taskId: string,
    attachment: Attachment,
  ): AttachmentManifest {
    return {
      id: attachment.id,
      taskIds: [taskId],
      projectIds: [projectId],
      name: attachment.name,
      mimeType: attachment.mimeType || 'application/octet-stream',
      size: attachment.size || 0,
      scanFileId: attachment.scanMetadata?.fileId,
      fileHash: attachment.scanMetadata?.fileHash,
      bundlePath: generateAttachmentBundlePath(attachment),
      originalUrl: attachment.url,
      downloadStatus: 'pending',
    };
  }
  
  // ==================== 下载附件 ====================
  
  /**
   * 下载所有附件（分批处理）
   */
  private async downloadAllAttachments(
    manifest: AttachmentManifest[]
  ): Promise<DownloadResult[]> {
    const results: DownloadResult[] = [];
    const { BATCH_SIZE } = ATTACHMENT_EXPORT_CONFIG;
    
    for (let i = 0; i < manifest.length; i += BATCH_SIZE) {
      const batch = manifest.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(att => this.downloadSingleAttachment(att))
      );
      
      results.push(...batchResults);
      
      // 更新进度
      const percentage = 10 + (results.length / manifest.length) * 70;
      this._progress.update(p => ({
        ...p,
        percentage,
        processedCount: results.length,
        currentItem: batch[0]?.name,
      }));
    }
    
    return results;
  }
  
  /**
   * 下载单个附件（带重试）
   */
  private async downloadSingleAttachment(
    attachment: AttachmentManifest
  ): Promise<DownloadResult> {
    const skippedResult = this.getSkippedDownloadResult(attachment);
    if (skippedResult) {
      return skippedResult;
    }

    const securityFailure = await this.getSecurityFailureDownloadResult(attachment);
    if (securityFailure) {
      return securityFailure;
    }
    
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < ATTACHMENT_EXPORT_CONFIG.RETRY_COUNT; attempt++) {
      try {
        const blob = await this.fetchAttachmentBlob(attachment.originalUrl as string);
        return await this.buildSuccessfulDownloadResult(attachment, blob);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('下载失败');
        await this.delayBeforeNextDownloadAttempt(attempt);
      }
    }

    return this.buildFailedDownloadResult(attachment, lastError);
  }

  private getSkippedDownloadResult(attachment: AttachmentManifest): DownloadResult | null {
    if (!attachment.originalUrl) {
      return buildSkippedAttachmentDownloadResult(attachment, 'URL 不存在');
    }

    if (attachment.size > ATTACHMENT_EXPORT_CONFIG.MAX_SINGLE_FILE_SIZE) {
      return buildSkippedAttachmentDownloadResult(
        attachment,
        '文件过大',
        `文件过大：${this.formatBytes(attachment.size)}`,
      );
    }

    return null;
  }

  private async getSecurityFailureDownloadResult(attachment: AttachmentManifest): Promise<DownloadResult | null> {
    if (!attachment.scanFileId) {
      return buildSkippedAttachmentDownloadResult(attachment, '安全检查失败：缺少扫描记录');
    }

    const result = await this.virusScan.checkBeforeDownload(attachment.scanFileId, attachment.fileHash);
    if (result.success) {
      return null;
    }

    return buildSkippedAttachmentDownloadResult(
      attachment,
      '安全检查失败',
      result.error || '附件安全检查失败',
    );
  }

  private async fetchAttachmentBlob(url: string): Promise<Blob> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ATTACHMENT_EXPORT_CONFIG.DOWNLOAD_TIMEOUT);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.blob();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async buildSuccessfulDownloadResult(
    attachment: AttachmentManifest,
    blob: Blob,
  ): Promise<DownloadResult> {
    attachment.checksum = await this.calculateBlobChecksum(blob);
    attachment.downloadStatus = 'success';

    this._progress.update(p => ({
      ...p,
      processedSize: p.processedSize + blob.size,
    }));

    return {
      attachment,
      data: blob,
      success: true,
    };
  }

  private async delayBeforeNextDownloadAttempt(attempt: number): Promise<void> {
    if (attempt >= ATTACHMENT_EXPORT_CONFIG.RETRY_COUNT - 1) {
      return;
    }

    await this.delay(ATTACHMENT_EXPORT_CONFIG.RETRY_DELAY * (attempt + 1));
  }

  private buildFailedDownloadResult(
    attachment: AttachmentManifest,
    lastError: Error | undefined,
  ): DownloadResult {
    attachment.downloadStatus = 'failed';
    attachment.failureReason = lastError?.message || '下载失败';
    
    this._progress.update(p => ({
      ...p,
      errors: [...p.errors, `${attachment.name}: ${lastError?.message}`],
    }));
    
    return {
      attachment,
      success: false,
      error: lastError?.message,
    };
  }
  
  // ==================== ZIP 打包 ====================
  
  /**
   * 创建 ZIP 包
   * 使用简化的 ZIP 格式实现（无压缩，适合已压缩的文件如图片）
   */
  private async createZipBundle(
    downloadResults: DownloadResult[],
    manifest: AttachmentManifest[]
  ): Promise<{ blob: Blob; filename: string }> {
    // 准备文件列表
    const files: ZipFileEntry[] = [];
    
    // 添加成功下载的附件
    for (const result of downloadResults) {
      if (result.success && result.data) {
        files.push({
          path: result.attachment.bundlePath,
          data: result.data,
        });
      }
    }
    
    // 添加 manifest.json
    const manifestData = createAttachmentExportManifest(
      manifest,
      downloadResults.filter(r => r.success).length,
      downloadResults.filter(r => !r.success).length,
      0
    );
    
    files.push({
      path: ATTACHMENT_EXPORT_CONFIG.MANIFEST_FILENAME,
      data: JSON.stringify(manifestData, null, 2),
    });
    
    // 创建 ZIP
    const zipBlob = await createSimpleZip(files);
    
    const filename = this.generateFilename();
    
    return { blob: zipBlob, filename };
  }
  
  // ==================== 辅助方法 ====================
  
  /**
   * 生成文件名
   */
  private generateFilename(): string {
    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')
      .substring(0, 19);
    return `${ATTACHMENT_EXPORT_CONFIG.FILENAME_PREFIX}-${timestamp}.zip`;
  }
  
  /**
   * 计算 Blob 校验和
   */
  private async calculateBlobChecksum(blob: Blob): Promise<string> {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const buffer = await blob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) {
      // 降级处理：使用简单校验和
      this.logger.debug('SHA-256 计算失败，使用简单校验和', { error: e });
    }
    
    // Fallback: 简单校验和
    return `size-${blob.size}`;
  }
  
  /**
   * 触发下载
   */
  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  /**
   * 格式化字节大小
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }
  
  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 重置进度
   */
  private resetProgress(): void {
    this._progress.set({
      stage: 'collecting',
      percentage: 0,
      processedCount: 0,
      totalCount: 0,
      processedSize: 0,
      totalSize: 0,
      errors: [],
    });
  }
  
  /**
   * 更新进度
   */
  private updateProgress(
    stage: AttachmentExportProgress['stage'],
    percentage: number,
    currentItem?: string
  ): void {
    this._progress.update(p => ({
      ...p,
      stage,
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem,
    }));
  }
}
