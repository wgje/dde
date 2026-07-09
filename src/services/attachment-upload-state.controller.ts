import { signal } from '@angular/core';

/**
 * 上传进度
 */
export interface UploadProgress {
  fileName: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'cancelled';
  error?: string;
}

const AUTO_CLEAR_PROGRESS_DELAY_MS = 3000;

export class AttachmentUploadStateController {
  /** 当前上传进度 */
  readonly uploadProgress = signal<UploadProgress[]>([]);

  /** 是否正在上传 */
  readonly isUploading = signal(false);

  /** 上传取消控制器映射 (fileName -> AbortController) */
  private readonly uploadAbortControllers = new Map<string, AbortController>();

  beginUpload(fileName: string, abortController: AbortController): void {
    this.uploadAbortControllers.set(fileName, abortController);
    this.updateProgress(fileName, 0, 'uploading');
    this.isUploading.set(true);
  }

  finishUpload(fileName: string): void {
    this.uploadAbortControllers.delete(fileName);
    this.setIdleWhenNoActiveUploads();
  }

  cancelUpload(fileName: string): boolean {
    const controller = this.uploadAbortControllers.get(fileName);
    if (!controller) return false;

    controller.abort();
    this.uploadAbortControllers.delete(fileName);
    this.updateProgress(fileName, 0, 'cancelled');
    this.setIdleWhenNoActiveUploads();
    return true;
  }

  cancelAllUploads(): void {
    const uploadControllers = Array.from(this.uploadAbortControllers.entries());
    for (let index = 0; index < uploadControllers.length; index += 1) {
      const [fileName, controller] = uploadControllers[index]!;
      controller.abort();
      this.updateProgress(fileName, 0, 'cancelled');
    }
    this.uploadAbortControllers.clear();
    this.isUploading.set(false);
  }

  isFileUploading(fileName: string): boolean {
    return this.uploadAbortControllers.has(fileName);
  }

  getActiveUploadCount(): number {
    return this.uploadAbortControllers.size;
  }

  updateProgress(fileName: string, progress: number, status: UploadProgress['status'], error?: string): void {
    this.uploadProgress.update(list => {
      const existing = list.find(p => p.fileName === fileName);
      if (existing) {
        return list.map(p => p.fileName === fileName ? { ...p, progress, status, error } : p);
      }
      return [...list, { fileName, progress, status, error }];
    });

    if (status === 'completed' || status === 'error') {
      setTimeout(() => {
        this.uploadProgress.update(list => list.filter(p => p.fileName !== fileName));
      }, AUTO_CLEAR_PROGRESS_DELAY_MS);
    }
  }

  clearProgress(): void {
    this.uploadProgress.set([]);
  }

  private setIdleWhenNoActiveUploads(): void {
    if (this.uploadAbortControllers.size === 0) {
      this.isUploading.set(false);
    }
  }
}
