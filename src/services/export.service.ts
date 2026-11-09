/**
 * ExportService - 数据导出服务
 * 
 * 【Week 8 数据保护 - P1 手动导出/导入】
 * 职责：
 * - 导出项目数据到 JSON 文件
 * - 生成校验和确保数据完整性
 * - 支持单项目和全项目导出
 * - 附件导出（流式 ZIP）
 * 
 * 设计理念：
 * - 全平台可用的数据逃生能力
 * - 离线也可导出
 * - 导出文件人类可读（JSON 格式化）
 */
import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { PreferenceService } from './preference.service';
import type { Project } from '../models';
import { LOCAL_BACKUP_CONFIG } from '../config/local-backup.config';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import {
  buildExportData,
  collectExportStats,
  createExportBlobResult,
  EXPORT_CONFIG,
  type ExportData,
  type ExportMetadata,
  type ExportProgress,
  type ExportProject,
  type ExportResult,
  generateExportFilename,
  sanitizeProjectForExport,
} from './export-build.utils';

interface FileSystemWritableFileStreamLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandleLike {
  name: string;
  createWritable(): Promise<FileSystemWritableFileStreamLike>;
}

interface SaveFilePickerWindow {
  showSaveFilePicker(options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }): Promise<FileSystemFileHandleLike>;
}

export { EXPORT_CONFIG };
export type {
  ExportAttachment,
  ExportConnection,
  ExportData,
  ExportExternalSourceLink,
  ExportMetadata,
  ExportProgress,
  ExportProject,
  ExportResult,
  ExportStats,
  ExportTask,
} from './export-build.utils';

const LAST_EXPORT_AT_STORAGE_KEY = 'nanoflow.lastExportAt';

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class ExportService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly logger = inject(LoggerService).category('Export');
  private readonly toast = inject(ToastService);
  private readonly preference = inject(PreferenceService);
  private readonly externalSourceLinks = inject(ExternalSourceLinkService);
  
  // 状态信号
  private readonly _isExporting = signal(false);
  private readonly _progress = signal<ExportProgress>({
    stage: 'preparing',
    percentage: 0,
  });
  private readonly _lastExportTime = signal<string | null>(null);
  private readonly _lastLocalBackupTime = signal<string | null>(null);
  
  // 公开的计算属性
  readonly isExporting = computed(() => this._isExporting());
  readonly progress = computed(() => this._progress());
  readonly lastExportTime = computed(() => this._lastExportTime());
  readonly lastLocalBackupTime = computed(() => this._lastLocalBackupTime());
  readonly lastSuccessfulBackupTime = computed(() =>
    this.selectLatestTimestamp(
      this._lastExportTime(),
      this._lastLocalBackupTime(),
      this.preference.lastBackupProofAt(),
    )
  );
  
  /** 是否需要导出提醒 */
  readonly needsExportReminder = computed(() => {
    const lastBackup = this.lastSuccessfulBackupTime();
    if (!lastBackup) return true;
    
    const elapsed = Date.now() - new Date(lastBackup).getTime();
    return elapsed > EXPORT_CONFIG.REMINDER_INTERVAL;
  });
  
  constructor() {
    // 加载上次导出时间
    this.loadLastExportTime();
    this.loadLastLocalBackupTime();
    this.setupStorageSync();
  }

  /**
   * 记录本地备份成功时间，用于同步更新全局备份提醒状态。
   */
  recordLocalBackupSuccess(timestamp: string): void {
    const normalized = this.normalizeTimestamp(timestamp, 'local-backup:runtime');
    this._lastLocalBackupTime.set(normalized);

    if (normalized) {
      void this.preference.recordBackupProof(normalized);
    }
  }

  /**
   * 导出当前项目
   */
  async exportProject(project: Project): Promise<ExportResult> {
    return this.exportProjects([project], 'single-project');
  }

  /**
   * 导出所有项目
   */
  async exportAllProjects(projects: Project[]): Promise<ExportResult> {
    return this.exportProjects(projects, 'full');
  }
  
  /**
   * 导出选中的项目
   */
  async exportSelectedProjects(projects: Project[]): Promise<ExportResult> {
    return this.exportProjects(projects, 'selected');
  }
  
  /**
   * 核心导出逻辑
   */
  private async exportProjects(
    projects: Project[],
    exportType: ExportMetadata['exportType']
  ): Promise<ExportResult> {
    if (this._isExporting()) {
      return { success: false, error: '导出正在进行中' };
    }
    
    const startTime = Date.now();
    this._isExporting.set(true);
    this.updateProgress('preparing', 0);
    
    try {
      this.logger.info('开始导出', { projectCount: projects.length, exportType });
      
      // 阶段 1：准备数据
      this.updateProgress('preparing', 10);
      
      await this.externalSourceLinks.ensureLoaded();
      const stats = collectExportStats(projects);
      
      this.updateProgress('processing', 30);
      const exportProjects = this.prepareExportProjects(projects);
      
      this.updateProgress('generating', 75);
      const exportData = buildExportData(projects.length, exportProjects, stats, exportType);
      
      // 阶段 4：计算校验和
      this.updateProgress('generating', 85);
      exportData.metadata.checksum = await this.calculateChecksum(exportData);
      
      // 阶段 5：生成文件
      this.updateProgress('generating', 95);
      const filename = generateExportFilename(exportType);
      const result = createExportBlobResult(exportData, filename, startTime);
      
      // 完成
      this.updateProgress('complete', 100);
      
      // 记录导出时间
      await this.saveLastExportTime();
      
      this.logger.info('导出完成', {
        projectCount: projects.length,
        taskCount: stats.taskCount,
        attachmentCount: stats.attachmentCount,
        durationMs: result.durationMs,
        fileSize: result.blob?.size,
      });
      
      return result;
    } catch (error) {
      this.logger.error('导出失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '导出失败',
      };
    } finally {
      this._isExporting.set(false);
    }
  }

  private prepareExportProjects(projects: Project[]): ExportProject[] {
    return projects.map((project, index) => {
      const progress = 30 + (index / projects.length) * 40;
      this.updateProgress('processing', progress, project.name);
      return sanitizeProjectForExport(
        project,
        taskId => this.externalSourceLinks.activeLinksForTask(taskId),
      );
    });
  }
  
  /**
   * 触发浏览器下载（传统方式）
   */
  downloadExport(result: ExportResult): boolean {
    if (!result.success || !result.blob) {
      this.toast.error('导出失败：无数据可下载');
      return false;
    }
    
    try {
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename ?? 'nanoflow-backup.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.toast.success('数据已导出');
      return true;
    } catch (error) {
      this.logger.error('下载失败', error);
      this.toast.error('下载失败');
      return false;
    }
  }
  
  /**
   * 使用 File System Access API 导出（现代方式）
   * 允许用户选择保存位置和文件名
   */
  async downloadExportWithFilePicker(result: ExportResult): Promise<boolean> {
    if (!result.success || !result.blob) {
      this.toast.error('导出失败：无数据可下载');
      return false;
    }
    
    // 检查是否支持 showSaveFilePicker
    if (!('showSaveFilePicker' in window)) {
      // 降级到传统下载方式
      return this.downloadExport(result);
    }
    
    try {
      const suggestedName = result.filename ?? generateExportFilename('full');
      
      const showSaveFilePicker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
      const handle = await showSaveFilePicker({
        suggestedName,
        types: [{
          description: 'JSON 备份文件',
          accept: { 'application/json': ['.json'] }
        }]
      });
      
      const writable = await handle.createWritable();
      await writable.write(result.blob);
      await writable.close();
      
      this.toast.success(`数据已导出到：${handle.name}`);
      return true;
      
    } catch (error) {
      const e = error as Error;
      
      // 用户取消不算错误
      if (e.name === 'AbortError') {
        this.logger.info('用户取消导出');
        return false;
      }
      
      this.logger.error('导出失败', error);
      // 降级到传统下载方式
      this.logger.info('降级到传统下载方式');
      return this.downloadExport(result);
    }
  }
  
  /**
   * 一键导出并下载（使用现代 API，支持选择保存位置）
   */
  async exportAndDownload(projects: Project[]): Promise<boolean> {
    const result = await this.exportAllProjects(projects);
    if (result.success) {
      // 优先使用 File System Access API
      return this.downloadExportWithFilePicker(result);
    } else {
      this.toast.error(result.error ?? '导出失败');
      return false;
    }
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 计算校验和（简化版 SHA-256）
   */
  private async calculateChecksum(data: ExportData): Promise<string> {
    // 移除 checksum 字段后计算
    const dataForChecksum = {
      ...data,
      metadata: { ...data.metadata, checksum: '' },
    };
    
    const jsonString = JSON.stringify(dataForChecksum);
    
    // 使用 Web Crypto API 计算 SHA-256
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      try {
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(jsonString);
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        // 降级到简单 hash
        this.logger.debug('SHA-256 计算失败，降级到简单 hash', { error: e });
        return this.simpleHash(jsonString);
      }
    }
    
    return this.simpleHash(jsonString);
  }
  
  /**
   * 简单哈希（降级方案）
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `simple-${Math.abs(hash).toString(16)}`;
  }
  
  /**
   * 生成文件名
   */
  private generateFilename(exportType: ExportMetadata['exportType']): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '');
    
    const typeSuffix = exportType === 'single-project' ? '-project' : 
                       exportType === 'selected' ? '-selected' : '';
    
    return `${EXPORT_CONFIG.FILENAME_PREFIX}${typeSuffix}-${dateStr}-${timeStr}.json`;
  }
  
  /**
   * 更新进度
   */
  private updateProgress(
    stage: ExportProgress['stage'],
    percentage: number,
    currentItem?: string
  ): void {
    this._progress.set({
      stage,
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem,
    });
  }
  
  /**
   * 加载上次导出时间
   */
  private loadLastExportTime(): void {
    try {
      this._lastExportTime.set(
        this.normalizeTimestamp(localStorage.getItem(LAST_EXPORT_AT_STORAGE_KEY), LAST_EXPORT_AT_STORAGE_KEY)
      );
    } catch (e) {
      this.logger.debug('读取上次导出时间失败', { error: e });
    }
  }

  /**
   * 加载上次本地备份时间
   */
  private loadLastLocalBackupTime(): void {
    try {
      this._lastLocalBackupTime.set(
        this.normalizeTimestamp(
          localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME),
          LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME,
        )
      );
    } catch (e) {
      this.logger.debug('读取上次本地备份时间失败', { error: e });
    }
  }

  /**
   * 跨标签页同步备份时间，避免提醒状态滞后。
   */
  private setupStorageSync(): void {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return;
      }

      if (event.key === LAST_EXPORT_AT_STORAGE_KEY) {
        this._lastExportTime.set(this.normalizeTimestamp(event.newValue, LAST_EXPORT_AT_STORAGE_KEY));
        return;
      }

      if (event.key === LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME) {
        this._lastLocalBackupTime.set(
          this.normalizeTimestamp(event.newValue, LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME)
        );
      }
    };

    window.addEventListener('storage', handleStorage);
    this.destroyRef.onDestroy(() => window.removeEventListener('storage', handleStorage));
  }

  /**
   * 选择最近一次有效的备份时间，统一导出与本地备份提醒语义。
   */
  private selectLatestTimestamp(...timestamps: Array<string | null>): string | null {
    let latest: string | null = null;
    let latestTime = -Infinity;

    for (const timestamp of timestamps) {
      if (!timestamp) {
        continue;
      }

      const time = new Date(timestamp).getTime();
      if (time > latestTime) {
        latest = timestamp;
        latestTime = time;
      }
    }

    return latest;
  }

  /**
   * 规范化持久化时间戳，损坏数据不参与提醒判断。
   */
  private normalizeTimestamp(value: string | null, source: string): string | null {
    if (!value) {
      return null;
    }

    const time = new Date(value).getTime();
    if (Number.isNaN(time)) {
      this.logger.warn('忽略无效备份时间戳', { source, value });
      return null;
    }

    return new Date(time).toISOString();
  }
  
  /**
   * 保存上次导出时间
   */
  private async saveLastExportTime(): Promise<void> {
    const now = new Date().toISOString();
    this._lastExportTime.set(now);
    
    try {
      localStorage.setItem(LAST_EXPORT_AT_STORAGE_KEY, now);
    } catch (e) {
      this.logger.debug('保存上次导出时间失败', { error: e });
    }

    await this.preference.recordBackupProof(now);
  }
}
