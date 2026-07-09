import { Injectable, inject, DestroyRef } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { Attachment } from '../models';
import { ATTACHMENT_CONFIG } from '../config';
import { SCAN_STATUS } from '../config/virus-scan.config';
import { supabaseErrorToError } from '../utils/supabase-error';
import { FileTypeValidatorService } from './file-type-validator.service';
import { LoggerService } from './logger.service';
import { VirusScanService } from './virus-scan.service';
import { ActionQueueService } from './action-queue.service';
import type { AttachmentUploadPayload } from './action-queue.types';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { AttachmentCleanupOutboxService } from './attachment-cleanup-outbox.service';
import { ensureAttachmentSafeForDownload } from './attachment-download-safety.helpers';
import {
  filterActiveAttachments,
  isDeletedAttachment,
  markAttachmentAsDeleted,
  restoreDeletedAttachment,
} from './attachment-soft-delete.helpers';
import {
  buildAttachmentStoragePath,
  sanitizeAttachmentPathSegment,
} from './attachment-storage-path.helpers';
import {
  createAttachmentUploadContext,
  createAttachmentUploadContextForPayload,
  prepareAttachmentFileUpload,
  queuePendingLocalAttachmentUpload,
  type AttachmentUploadContext,
  type AttachmentUploadFailure,
  type AttachmentUploadResult,
} from './attachment-upload-queue.helpers';
import { AttachmentUploadStateController } from './attachment-upload-state.controller';
import { isAttachmentImageMimeType, resolveAttachmentType } from './attachment-mime.helpers';

export type { UploadProgress } from './attachment-upload-state.controller';

/**
 * 附件上传服务
 * 负责与 Supabase Storage 的文件上传、下载、删除操作
 * 包含自动 URL 刷新机制和上传取消支持
 */
@Injectable({
  providedIn: 'root'
})
export class AttachmentService {
  private supabase = inject(SupabaseClientService);
  private destroyRef = inject(DestroyRef);
  private fileTypeValidator = inject(FileTypeValidatorService);
  private virusScan = inject(VirusScanService);
  private actionQueue = inject(ActionQueueService);
  private uploadOutbox = inject(AttachmentUploadOutboxService);
  private cleanupOutbox = inject(AttachmentCleanupOutboxService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('Attachment');
  private readonly uploadState = new AttachmentUploadStateController();

  private buildStoragePath(userId: string, projectId: string, taskId: string, attachmentId: string, fileName: string): string {
    return buildAttachmentStoragePath({ userId, projectId, taskId, attachmentId, fileName });
  }

  /** 当前上传进度 */
  readonly uploadProgress = this.uploadState.uploadProgress;

  /** 是否正在上传 */
  readonly isUploading = this.uploadState.isUploading;

  /** URL 刷新定时器 */
  private urlRefreshTimer: ReturnType<typeof setInterval> | null = null;
  
  /** URL 刷新回调（由使用者注册） */
  private urlRefreshCallback: ((refreshedUrls: Map<string, { url: string; thumbnailUrl?: string }>) => void) | null = null;
  
  /** 需要监控刷新的附件列表 */
  private monitoredAttachments: Map<string, { userId: string; projectId: string; taskId: string; attachment: Attachment }> = new Map();

  constructor() {
    this.startUrlRefreshMonitor();
    
    // 使用 DestroyRef 替代 ngOnDestroy，确保 root 服务也能正确清理
    this.destroyRef.onDestroy(() => {
      this.stopUrlRefreshMonitor();
      this.cancelAllUploads();
      this.clearUrlRefreshCallback();
      this.clearMonitoredAttachments();
    });
  }

  /**
   * 启动 URL 刷新监控
   */
  private startUrlRefreshMonitor() {
    if (this.urlRefreshTimer !== null) return;
    
    this.urlRefreshTimer = setInterval(async () => {
      await this.checkAndRefreshExpiredUrls();
    }, ATTACHMENT_CONFIG.URL_REFRESH_CHECK_INTERVAL);
  }

  /**
   * 停止 URL 刷新监控
   */
  private stopUrlRefreshMonitor() {
    if (this.urlRefreshTimer !== null) {
      clearInterval(this.urlRefreshTimer);
      this.urlRefreshTimer = null;
    }
  }

  /**
   * 注册 URL 刷新回调
   */
  setUrlRefreshCallback(callback: (refreshedUrls: Map<string, { url: string; thumbnailUrl?: string }>) => void) {
    this.urlRefreshCallback = callback;
  }

  /**
   * 清除 URL 刷新回调
   * 在组件销毁时调用，防止内存泄漏
   */
  clearUrlRefreshCallback() {
    this.urlRefreshCallback = null;
  }

  /**
   * 添加附件到监控列表
   */
  monitorAttachment(userId: string, projectId: string, taskId: string, attachment: Attachment) {
    this.monitoredAttachments.set(attachment.id, { userId, projectId, taskId, attachment });
  }

  /**
   * 从监控列表移除附件
   */
  unmonitorAttachment(attachmentId: string) {
    this.monitoredAttachments.delete(attachmentId);
  }

  /**
   * 清空监控列表
   */
  clearMonitoredAttachments() {
    this.monitoredAttachments.clear();
  }

  /**
   * 用户登出时调用
   * 停止 URL 刷新定时器，防止尝试刷新已失效的 URL
   * 
   * 设计理念：
   * - 用户登出后，所有签名 URL 都已失效
   * - 继续刷新只会产生无效请求
   * - 新用户登录后会重新启动监控
   */
  onUserLogout(): void {
    // 停止 URL 刷新监控
    this.stopUrlRefreshMonitor();
    
    // 清空监控列表
    this.clearMonitoredAttachments();
    
    // 取消所有进行中的上传
    this.cancelAllUploads();
    
    // 清除回调
    this.clearUrlRefreshCallback();
    
    // 清除上传进度
    this.clearProgress();
  }
  
  /**
   * 用户登录后调用
   * 重新启动 URL 刷新监控
   */
  onUserLogin(): void {
    this.startUrlRefreshMonitor();
  }

  /**
   * 检查并刷新过期的 URL
   */
  private async checkAndRefreshExpiredUrls() {
    if (this.monitoredAttachments.size === 0 || !this.supabase.isConfigured) return;

    const refreshedUrls = new Map<string, { url: string; thumbnailUrl?: string; signedAt: string }>();
    const now = Date.now();
    const expiryBuffer = ATTACHMENT_CONFIG.URL_EXPIRY_BUFFER;

    const monitoredEntries = Array.from(this.monitoredAttachments.entries());
    for (let index = 0; index < monitoredEntries.length; index += 1) {
      const [id, { userId, projectId, taskId, attachment }] = monitoredEntries[index]!;
      // 检查 URL 是否即将过期（优先使用 signedAt，fallback 到 createdAt）
      const signedAt = attachment.signedAt ? new Date(attachment.signedAt).getTime() : new Date(attachment.createdAt).getTime();
      const urlAge = now - signedAt;
      
      // 如果 URL 年龄超过缓冲时间，刷新它
      if (urlAge > expiryBuffer) {
        try {
          const newUrls = await this.refreshUrl(userId, projectId, taskId, attachment);
          if (newUrls) {
            const signedAtNow = new Date().toISOString();
            refreshedUrls.set(id, { ...newUrls, signedAt: signedAtNow });
            // 更新监控列表中的附件
            this.monitoredAttachments.set(id, {
              userId, projectId, taskId,
              attachment: { ...attachment, url: newUrls.url, thumbnailUrl: newUrls.thumbnailUrl, signedAt: signedAtNow }
            });
          }
        } catch (e) {
          // URL 刷新失败，静默处理，下次检查会重试
          this.logger.warn(`刷新附件 URL 失败: ${id}`, { error: e });
        }
      }
    }

    // 通知回调
    if (refreshedUrls.size > 0 && this.urlRefreshCallback) {
      this.urlRefreshCallback(refreshedUrls);
    }
  }

  /**
   * 上传文件
   * 支持取消操作：调用 cancelUpload(fileName) 可取消进行中的上传
   * @param userId 用户 ID
   * @param projectId 项目 ID
   * @param taskId 任务 ID
   * @param file 文件对象
   * @returns 附件对象
   */
  async uploadFile(
    userId: string,
    projectId: string,
    taskId: string,
    file: File
  ): Promise<AttachmentUploadResult> {
    const preparation = await this.prepareFileUpload(userId, projectId, taskId, file);
    if (!preparation.success) return preparation;

    const uploadContext = this.createUploadContext(
      userId,
      projectId,
      taskId,
      file,
      preparation.scanMetadata,
      true,
    );
    return this.queuePendingLocalUpload(userId, projectId, taskId, file, uploadContext);
  }

  async uploadQueuedAttachment(
    payload: AttachmentUploadPayload,
    blob: Blob,
  ): Promise<Attachment> {
    const file = new File([blob], payload.fileName, {
      type: payload.mimeType || blob.type || 'application/octet-stream',
    });
    const scanResult = await this.virusScan.scanBeforeUpload(file, file.name);
    if (!scanResult.success || scanResult.result?.status === SCAN_STATUS.THREAT_DETECTED) {
      throw new Error(scanResult.error || '文件安全扫描未通过');
    }

    const context = this.createUploadContextForAttachmentPayload(
      payload,
      scanResult.result ? this.virusScan.createScanMetadata(scanResult.result) : payload.attachment.scanMetadata,
    );
    await this.uploadFileToStorage(file, context);
    const uploaded = await this.createUploadedAttachment(file, context);
    return {
      ...uploaded,
      createdAt: payload.attachment.createdAt,
    };
  }

  private async prepareFileUpload(
    userId: string,
    projectId: string,
    taskId: string,
    file: File,
  ): Promise<AttachmentUploadFailure | { success: true; scanMetadata?: Attachment['scanMetadata']; remoteUploadDeferred?: boolean }> {
    return prepareAttachmentFileUpload({
      createScanMetadata: result => this.virusScan.createScanMetadata(result),
      file,
      projectId,
      scanBeforeUpload: (uploadFile, fileName) =>
        this.virusScan.scanBeforeUpload(uploadFile, fileName),
      supabaseConfigured: this.supabase.isConfigured,
      taskId,
      userId,
      validateFile: uploadFile => this.fileTypeValidator.validateFile(uploadFile),
    });
  }

  private createUploadContext(
    userId: string,
    projectId: string,
    taskId: string,
    file: File,
    scanMetadata?: Attachment['scanMetadata'],
    remoteUploadDeferred = false,
  ): AttachmentUploadContext {
    return createAttachmentUploadContext({
      file,
      projectId,
      remoteUploadDeferred,
      scanMetadata,
      taskId,
      userId,
    });
  }

  private createUploadContextForAttachmentPayload(
    payload: AttachmentUploadPayload,
    scanMetadata?: Attachment['scanMetadata'],
  ): AttachmentUploadContext {
    return createAttachmentUploadContextForPayload(payload, scanMetadata);
  }

  private async queuePendingLocalUpload(
    userId: string,
    projectId: string,
    taskId: string,
    file: File,
    context: AttachmentUploadContext,
  ): Promise<AttachmentUploadResult> {
    return queuePendingLocalAttachmentUpload({
      actionQueue: this.actionQueue,
      context,
      file,
      projectId,
      taskId,
      updateProgress: (fileName, progress, status) =>
        this.uploadState.updateProgress(fileName, progress, status),
      uploadOutbox: this.uploadOutbox,
      userId,
    });
  }

  private async uploadFileToStorage(file: File, context: AttachmentUploadContext): Promise<void> {
    if (context.abortController.signal.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }

    const uploadPromise = this.supabase.client().storage
      .from(ATTACHMENT_CONFIG.BUCKET_NAME)
      .upload(context.filePath, file, {
        cacheControl: String(ATTACHMENT_CONFIG.CACHE_CONTROL_MAX_AGE),
        upsert: false
      });
    const abortPromise = this.createUploadAbortPromise(context.abortController);
    const { error } = await Promise.race([
      uploadPromise,
      abortPromise.then(() => ({ data: null, error: new Error('Upload cancelled') }))
    ]) as { data: unknown; error: Error | null };

    if (error) {
      if (this.isStorageObjectAlreadyUploadedError(error)) {
        this.logger.debug('附件对象已存在，按上传重放幂等成功处理', {
          filePath: context.filePath,
        });
      } else {
        throw supabaseErrorToError(error);
      }
    }
    if (context.abortController.signal.aborted) {
      await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .remove([context.filePath]);
      throw new DOMException('Upload cancelled', 'AbortError');
    }
  }

  private isStorageObjectAlreadyUploadedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const details = error as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    const statusValues = [details.status, details.statusCode].map(value => String(value ?? ''));
    const hasConflictStatus = statusValues.some(value => value === '409');
    const searchableText = [
      details.code,
      details.message,
      details.name,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();

    return hasConflictStatus && (
      searchableText.includes('already exists') ||
      searchableText.includes('alreadyexists') ||
      searchableText.includes('duplicate') ||
      searchableText.includes('conflict')
    );
  }

  private createUploadAbortPromise(abortController: AbortController): Promise<never> {
    return new Promise((_, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(new DOMException('Upload cancelled', 'AbortError'));
      });
    });
  }

  private async createUploadedAttachment(file: File, context: AttachmentUploadContext): Promise<Attachment> {
    const url = await this.createSignedUploadUrl(context.filePath);
    const attachment: Attachment = {
      id: context.attachmentId,
      type: resolveAttachmentType(file.type),
      name: file.name,
      url,
      mimeType: file.type,
      size: file.size,
      createdAt: new Date().toISOString(),
      signedAt: new Date().toISOString(),
      scanMetadata: context.scanMetadata,
    };

    if (isAttachmentImageMimeType(file.type)) {
      attachment.thumbnailUrl = await this.createThumbnailSignedUrl(context.filePath);
    }

    return attachment;
  }

  private async createSignedUploadUrl(filePath: string): Promise<string> {
    const { data: urlData, error: signedUrlError } = await this.supabase.client().storage
      .from(ATTACHMENT_CONFIG.BUCKET_NAME)
      .createSignedUrl(filePath, ATTACHMENT_CONFIG.SIGNED_URL_EXPIRY);

    const url = urlData?.signedUrl;
    if (signedUrlError || !url) {
      await this.removeUploadedFileAfterMetadataFailure(filePath);
      if (signedUrlError) throw supabaseErrorToError(signedUrlError);
      throw new Error('签名 URL 生成失败');
    }

    return url;
  }

  private async createThumbnailSignedUrl(filePath: string): Promise<string | undefined> {
    const { data: thumbData } = await this.supabase.client().storage
      .from(ATTACHMENT_CONFIG.BUCKET_NAME)
      .createSignedUrl(filePath, ATTACHMENT_CONFIG.SIGNED_URL_EXPIRY, {
        transform: {
          width: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
          height: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
          resize: 'contain'
        }
      });
    return thumbData?.signedUrl;
  }

  private handleUploadError(fileName: string, error: unknown): AttachmentUploadFailure {
    const err = error as { name?: string; message?: string };

    if (err?.name === 'AbortError' || err?.message === 'Upload cancelled') {
      this.logger.debug('上传已取消', { fileName });
      this.uploadState.updateProgress(fileName, 0, 'cancelled');
      return { success: false, cancelled: true, error: '上传已取消' };
    }

    this.logger.error('File upload failed', { error });
    this.uploadState.updateProgress(fileName, 0, 'error', err?.message);
    return { success: false, error: err?.message ?? '上传失败' };
  }

  private async removeUploadedFileAfterMetadataFailure(filePath: string): Promise<void> {
    try {
      await this.cleanupOutbox.enqueuePaths([filePath]);
    } catch (error) {
      this.logger.warn('签名 URL 生成失败后清理队列持久化失败，继续尝试即时清理', { filePath, error });
    }

    try {
      const { error } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .remove([filePath]);
      if (error) {
        this.logger.warn('签名 URL 生成失败后清理已上传文件失败', { filePath, error });
        return;
      }
      await this.cleanupOutbox.removePaths([filePath]);
    } catch (cleanupError) {
      this.logger.warn('签名 URL 生成失败后清理已上传文件异常', { filePath, error: cleanupError });
    }
  }

  /**
   * 取消指定文件的上传
   * @param fileName 文件名
   * @returns 是否成功取消
   */
  cancelUpload(fileName: string): boolean {
    return this.uploadState.cancelUpload(fileName);
  }

  /**
   * 取消所有正在进行的上传
   */
  cancelAllUploads(): void {
    this.uploadState.cancelAllUploads();
  }

  /**
   * 检查指定文件是否正在上传
   */
  isFileUploading(fileName: string): boolean {
    return this.uploadState.isFileUploading(fileName);
  }

  /**
   * 获取正在上传的文件数量
   */
  getActiveUploadCount(): number {
    return this.uploadState.getActiveUploadCount();
  }

  /**
   * 批量上传文件
   */
  async uploadFiles(
    userId: string,
    projectId: string,
    taskId: string,
    files: FileList | File[]
  ): Promise<{ attachments: Attachment[]; errors: string[] }> {
    const attachments: Attachment[] = [];
    const errors: string[] = [];

    for (const file of Array.from(files)) {
      const result = await this.uploadFile(userId, projectId, taskId, file);
      if (result.success) {
        attachments.push(result.attachment);
      } else {
        errors.push(`${file.name}: ${result.error}`);
      }
    }

    return { attachments, errors };
  }

  /**
   * 软删除文件（标记为已删除，不立即从存储中移除）
   * 附件会在指定保留期后由后台任务清理
   * @param attachment 要删除的附件对象
   * @returns 带有 deletedAt 标记的附件对象
   */
  markAsDeleted(attachment: Attachment): Attachment {
    return markAttachmentAsDeleted(attachment, new Date().toISOString());
  }

  /**
   * 检查附件是否已被软删除
   */
  isDeleted(attachment: Attachment): boolean {
    return isDeletedAttachment(attachment);
  }

  /**
   * 恢复软删除的附件
   */
  restoreDeleted(attachment: Attachment): Attachment {
    return restoreDeletedAttachment(attachment);
  }

  /**
   * 过滤掉已删除的附件（用于显示）
   */
  filterActive(attachments: Attachment[]): Attachment[] {
    return filterActiveAttachments(attachments);
  }

  /**
   * 删除文件（硬删除 - 仅供清理任务使用）
   * 注意：正常删除应使用 markAsDeleted 进行软删除
   */
  async deleteFile(
    userId: string,
    projectId: string,
    taskId: string,
    attachmentId: string,
    fileExt: string
  ): Promise<{ success: boolean; error?: string }> {
    const filePath = `${userId}/${projectId}/${taskId}/${attachmentId}.${sanitizeAttachmentPathSegment(fileExt)}`;
    const result = await this.deleteFiles([filePath]);
    return result.success
      ? { success: true }
      : { success: false, error: result.errors[0] ?? '删除失败' };
  }

  /**
   * 批量硬删除文件（供清理任务使用）
   */
  async deleteFiles(filePaths: string[]): Promise<{ success: boolean; deletedCount: number; errors: string[] }> {
    if (filePaths.length === 0) {
      return { success: true, deletedCount: 0, errors: [] };
    }

    try {
      await this.cleanupOutbox.enqueuePaths(filePaths);
    } catch (error) {
      this.logger.error('批量删除文件清理队列持久化失败', { filePaths: filePaths.slice(0, 5), error });
      return { success: false, deletedCount: 0, errors: ['附件清理队列持久化失败'] };
    }

    if (!this.supabase.isConfigured) {
      return { success: false, deletedCount: 0, errors: ['Supabase 未配置'] };
    }

    const errors: string[] = [];
    let deletedCount = 0;

    // Supabase Storage 批量删除有限制，分批处理
    const batchSize = 100;
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      try {
        const { error } = await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .remove(batch);

        if (error) {
          errors.push(`批次 ${Math.floor(i / batchSize) + 1}: ${error.message}`);
        } else {
          deletedCount += batch.length;
          await this.cleanupOutbox.removePaths(batch);
        }
      } catch (e: unknown) {
        const err = e as { message?: string };
        this.logger.warn('批量删除文件异常', { batch: Math.floor(i / batchSize) + 1, error: e });
        errors.push(`批次 ${Math.floor(i / batchSize) + 1}: ${err?.message ?? '删除失败'}`);
      }
    }

    return { 
      success: errors.length === 0, 
      deletedCount, 
      errors 
    };
  }

  /**
   * 刷新附件 URL（当签名过期时）
   */
  async refreshUrl(
    userId: string,
    projectId: string,
    taskId: string,
    attachment: Attachment
  ): Promise<{ url: string; thumbnailUrl?: string } | null> {
    if (!this.supabase.isConfigured) {
      this.logger.warn('Supabase 未配置，无法刷新附件 URL', { attachmentId: attachment.id });
      return null;
    }

    const filePath = this.buildStoragePath(userId, projectId, taskId, attachment.id, attachment.name);

    try {
      // 【流量优化】使用配置的签名有效期（30 天）
      const { data: urlData } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .createSignedUrl(filePath, ATTACHMENT_CONFIG.SIGNED_URL_EXPIRY);

      if (!urlData?.signedUrl) {
        this.logger.warn('签名 URL 生成失败，返回空', { attachmentId: attachment.id, filePath });
        return null;
      }

      const result: { url: string; thumbnailUrl?: string } = {
        url: urlData.signedUrl
      };

      // 如果是图片，也刷新缩略图 URL
      // 【流量优化】使用配置的签名有效期（30 天）
      if (attachment.type === 'image' && attachment.mimeType) {
        const { data: thumbData } = await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .createSignedUrl(filePath, ATTACHMENT_CONFIG.SIGNED_URL_EXPIRY, {
            transform: {
              width: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
              height: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
              resize: 'contain'
            }
          });
        result.thumbnailUrl = thumbData?.signedUrl;
      }

      return result;
    } catch (e) {
      this.logger.error('Failed to refresh URL', { error: e });
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：URL 刷新失败使用旧 URL
      return null;
    }
  }

  /**
   * 下载文件
   */
  async downloadFile(
    userId: string,
    projectId: string,
    taskId: string,
    attachment: Attachment
  ): Promise<Blob | null> {
    if (!this.supabase.isConfigured) {
      this.logger.warn('Supabase 未配置，无法下载文件', { attachmentId: attachment.id });
      return null;
    }

    const safeToDownload = await ensureAttachmentSafeForDownload({
      attachment,
      checkBeforeDownload: (scanFileId, fileHash) => this.virusScan.checkBeforeDownload(scanFileId, fileHash),
      warn: (message, details) => this.logger.warn(message, details),
    });
    if (!safeToDownload) {
      return null;
    }

    const filePath = this.buildStoragePath(userId, projectId, taskId, attachment.id, attachment.name);

    try {
      const { data, error } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .download(filePath);

      if (error) {
        throw supabaseErrorToError(error);
      }

      return data;
    } catch (e) {
      this.logger.error('File download failed', { error: e });
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：文件下载失败由调用方处理
      return null;
    }
  }

  /**
   * 验证附件数量限制
   */
  canAddAttachment(currentCount: number): boolean {
    return currentCount < ATTACHMENT_CONFIG.MAX_ATTACHMENTS_PER_TASK;
  }

  /**
   * 清除所有进度
   */
  clearProgress(): void {
    this.uploadState.clearProgress();
  }
}
