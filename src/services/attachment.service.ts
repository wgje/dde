import { Injectable, inject, signal } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { Attachment, AttachmentType } from '../models';

/**
 * 附件上传配置
 */
const ATTACHMENT_CONFIG = {
  /** 最大文件大小 (10MB) */
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  /** 每个任务最大附件数 */
  MAX_ATTACHMENTS_PER_TASK: 20,
  /** 存储桶名称 */
  BUCKET_NAME: 'attachments',
  /** 图片类型 */
  IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  /** 文档类型 */
  DOCUMENT_TYPES: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown'],
  /** 缩略图最大尺寸 */
  THUMBNAIL_MAX_SIZE: 200
} as const;

/**
 * 上传进度
 */
export interface UploadProgress {
  fileName: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
}

/**
 * 附件上传服务
 * 负责与 Supabase Storage 的文件上传、下载、删除操作
 */
@Injectable({
  providedIn: 'root'
})
export class AttachmentService {
  private supabase = inject(SupabaseClientService);

  /** 当前上传进度 */
  readonly uploadProgress = signal<UploadProgress[]>([]);

  /** 是否正在上传 */
  readonly isUploading = signal(false);

  /**
   * 上传文件
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
  ): Promise<{ success: boolean; attachment?: Attachment; error?: string }> {
    if (!this.supabase.isConfigured) {
      return { success: false, error: 'Supabase 未配置' };
    }

    // 验证文件大小
    if (file.size > ATTACHMENT_CONFIG.MAX_FILE_SIZE) {
      return { success: false, error: `文件大小不能超过 ${ATTACHMENT_CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB` };
    }

    const attachmentId = crypto.randomUUID();
    const fileExt = file.name.split('.').pop() || '';
    const filePath = `${userId}/${projectId}/${taskId}/${attachmentId}.${fileExt}`;
    
    // 更新上传进度
    this.updateProgress(file.name, 0, 'uploading');
    this.isUploading.set(true);

    try {
      // 上传文件到 Supabase Storage
      const { data, error } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: false
        });

      if (error) {
        throw error;
      }

      // 获取公开 URL 或签名 URL
      const { data: urlData } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .createSignedUrl(filePath, 60 * 60 * 24 * 7); // 7 天有效期

      const url = urlData?.signedUrl || '';

      // 构建附件对象
      const attachment: Attachment = {
        id: attachmentId,
        type: this.getAttachmentType(file.type),
        name: file.name,
        url,
        mimeType: file.type,
        size: file.size,
        createdAt: new Date().toISOString()
      };

      // 如果是图片，尝试生成缩略图 URL
      if (this.isImage(file.type)) {
        const { data: thumbData } = await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .createSignedUrl(filePath, 60 * 60 * 24 * 7, {
            transform: {
              width: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
              height: ATTACHMENT_CONFIG.THUMBNAIL_MAX_SIZE,
              resize: 'contain'
            }
          });
        attachment.thumbnailUrl = thumbData?.signedUrl;
      }

      this.updateProgress(file.name, 100, 'completed');
      
      return { success: true, attachment };
    } catch (e: any) {
      console.error('File upload failed:', e);
      this.updateProgress(file.name, 0, 'error', e?.message);
      return { success: false, error: e?.message ?? '上传失败' };
    } finally {
      this.isUploading.set(false);
    }
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
      if (result.success && result.attachment) {
        attachments.push(result.attachment);
      } else if (result.error) {
        errors.push(`${file.name}: ${result.error}`);
      }
    }

    return { attachments, errors };
  }

  /**
   * 删除文件
   */
  async deleteFile(
    userId: string,
    projectId: string,
    taskId: string,
    attachmentId: string,
    fileExt: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) {
      return { success: false, error: 'Supabase 未配置' };
    }

    const filePath = `${userId}/${projectId}/${taskId}/${attachmentId}.${fileExt}`;

    try {
      const { error } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .remove([filePath]);

      if (error) {
        throw error;
      }

      return { success: true };
    } catch (e: any) {
      console.error('File deletion failed:', e);
      return { success: false, error: e?.message ?? '删除失败' };
    }
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
      return null;
    }

    const fileExt = attachment.name.split('.').pop() || '';
    const filePath = `${userId}/${projectId}/${taskId}/${attachment.id}.${fileExt}`;

    try {
      const { data: urlData } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .createSignedUrl(filePath, 60 * 60 * 24 * 7);

      if (!urlData?.signedUrl) {
        return null;
      }

      const result: { url: string; thumbnailUrl?: string } = {
        url: urlData.signedUrl
      };

      // 如果是图片，也刷新缩略图 URL
      if (attachment.type === 'image' && attachment.mimeType) {
        const { data: thumbData } = await this.supabase.client().storage
          .from(ATTACHMENT_CONFIG.BUCKET_NAME)
          .createSignedUrl(filePath, 60 * 60 * 24 * 7, {
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
      console.error('Failed to refresh URL:', e);
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
      return null;
    }

    const fileExt = attachment.name.split('.').pop() || '';
    const filePath = `${userId}/${projectId}/${taskId}/${attachment.id}.${fileExt}`;

    try {
      const { data, error } = await this.supabase.client().storage
        .from(ATTACHMENT_CONFIG.BUCKET_NAME)
        .download(filePath);

      if (error) {
        throw error;
      }

      return data;
    } catch (e) {
      console.error('File download failed:', e);
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
   * 获取文件类型
   */
  private getAttachmentType(mimeType: string): AttachmentType {
    if ((ATTACHMENT_CONFIG.IMAGE_TYPES as readonly string[]).includes(mimeType)) {
      return 'image';
    }
    if ((ATTACHMENT_CONFIG.DOCUMENT_TYPES as readonly string[]).includes(mimeType)) {
      return 'document';
    }
    return 'file';
  }

  /**
   * 是否为图片
   */
  private isImage(mimeType: string): boolean {
    return (ATTACHMENT_CONFIG.IMAGE_TYPES as readonly string[]).includes(mimeType);
  }

  /**
   * 更新上传进度
   */
  private updateProgress(fileName: string, progress: number, status: UploadProgress['status'], error?: string) {
    this.uploadProgress.update(list => {
      const existing = list.find(p => p.fileName === fileName);
      if (existing) {
        return list.map(p => p.fileName === fileName ? { ...p, progress, status, error } : p);
      }
      return [...list, { fileName, progress, status, error }];
    });

    // 清除已完成或错误的进度（延迟 3 秒）
    if (status === 'completed' || status === 'error') {
      setTimeout(() => {
        this.uploadProgress.update(list => list.filter(p => p.fileName !== fileName));
      }, 3000);
    }
  }

  /**
   * 清除所有进度
   */
  clearProgress() {
    this.uploadProgress.set([]);
  }
}
