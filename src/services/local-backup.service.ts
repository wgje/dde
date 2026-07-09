/**
 * 本地目录备份服务：File System Access API + 自动备份 + DirectoryHandle 持久化。
 * 这是 C 层增强能力，不是主同步链路；仅桌面 Chrome 可用，需要用户授权。
 */
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { DisasterBackupService } from './disaster-backup.service';
import { ExportService } from './export.service';
import type { Project } from '../models';
import {
  LOCAL_BACKUP_CONFIG,
  LocalBackupResult,
  DirectoryAuthResult,
  LocalBackupStatus,
  LocalBackupCompatibility,
} from '../config/local-backup.config';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import { del, get, set } from 'idb-keyval';
import {
  buildLocalBackupFilename,
  createLocalBackupTimestamp,
} from './local-backup-file.helpers';
import { LocalBackupDeferredRetryScheduler } from './local-backup-deferred-retry.scheduler';
import { LocalBackupPersistenceController } from './local-backup-persistence.controller';
import { LocalBackupDirectoryFilesController } from './local-backup-directory-files.controller';
import { isStaleDirectoryHandleError } from './local-backup-directory-handle.helpers';
import { resolveLocalBackupCompatibility } from './local-backup-compatibility.helpers';
export { buildLocalBackupFilename } from './local-backup-file.helpers';

const STALE_DIRECTORY_HANDLE_MESSAGE = '备份目录状态已变化，请重新选择本地备份目录';

type LocalBackupProjectSnapshot = { id: string; name: string; tasks: unknown[]; connections: unknown[] };

interface PermissionCheckOptions {
  request?: boolean;
}

interface BackupRunOptions {
  requestPermission?: boolean;
}

interface AutoBackupStartOptions {
  silent?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class LocalBackupService implements OnDestroy {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly logger = inject(LoggerService).category('LocalBackup');
  private readonly toast = inject(ToastService);
  private readonly disasterBackupService = inject(DisasterBackupService);
  private readonly exportService = inject(ExportService);
  private readonly uiState = inject(UiStateService);
  private readonly preferenceService = inject(PreferenceService);
  private readonly persistence = new LocalBackupPersistenceController({
    logger: this.logger,
    idbGet: get,
    idbSet: set,
    idbDel: del,
  });
  private readonly directoryFiles = new LocalBackupDirectoryFilesController({
    logger: this.logger,
    isStaleDirectoryHandleError,
    invalidateDirectoryHandle: notifyUser => this.invalidateDirectoryHandleAfterStateError(notifyUser),
  });
  
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private restoreHandlePromise: Promise<boolean> | null = null;
  private autoBackupTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  /** 用于自动备份的项目获取函数（持久化后恢复使用） */
  private getProjectsFn: (() => LocalBackupProjectSnapshot[]) | null = null;
  private readonly deferredRetryScheduler = new LocalBackupDeferredRetryScheduler({
    isEnabled: () => this._autoBackupEnabled(),
    hasProjectsProvider: () => !!this.getProjectsFn,
    runRetry: () => void this.runAutoBackupCycle(),
    getRemainingResumeDelayMs: () => getRemainingBrowserNetworkResumeDelayMs(),
  });
  
  private readonly _isAuthorized = signal(false);
  private readonly _directoryName = signal<string | null>(null);
  private readonly _lastBackupTime = signal<string | null>(null);
  private readonly _autoBackupEnabled = signal(false);
  private readonly _autoBackupIntervalMs = signal(LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS);
  private readonly _isBackingUp = signal(false);
  /** 是否有保存的 handle（需要用户点击恢复权限） */
  private readonly _hasSavedHandle = signal(false);
  /** 权限状态：granted=已授权, prompt=需要用户确认, denied=已拒绝 */
  private readonly _permissionState = signal<PermissionState | null>(null);
  
  readonly isAuthorized = computed(() => this._isAuthorized());
  readonly directoryName = computed(() => this._directoryName());
  readonly lastBackupTime = computed(() => this._lastBackupTime());
  readonly autoBackupEnabled = computed(() => this._autoBackupEnabled());
  readonly autoBackupIntervalMs = computed(() => this._autoBackupIntervalMs());
  readonly isBackingUp = computed(() => this._isBackingUp());
  /** 是否有保存的 handle 但需要用户恢复权限 */
  readonly hasSavedHandle = computed(() => this._hasSavedHandle());
  /** 当前权限状态 */
  readonly permissionState = computed(() => this._permissionState());
  /** 是否需要用户点击恢复权限（有保存的 handle 但未授权） */
  readonly needsPermissionResume = computed(() => 
    this._hasSavedHandle() && !this._isAuthorized() && this._permissionState() === 'prompt'
  );
  
  readonly compatibility = computed<LocalBackupCompatibility>(() =>
    resolveLocalBackupCompatibility({
      isDesktop: !this.uiState.isMobile(),
      hasDirectoryPicker: 'showDirectoryPicker' in window,
    })
  );
  
  readonly isAvailable = computed(() => this.compatibility().isSupported);
  
  readonly status = computed<LocalBackupStatus>(() => ({
    isAuthorized: this._isAuthorized(),
    directoryName: this._directoryName() ?? undefined,
    lastBackupTime: this._lastBackupTime() ?? undefined,
    autoBackupEnabled: this._autoBackupEnabled(),
    autoBackupIntervalMs: this._autoBackupIntervalMs(),
  }));
  
  constructor() {
    // 先从 localStorage 加载基础状态
    this.loadPersistedState();
    // 然后从 IndexedDB 恢复 DirectoryHandle（异步）
    this.restoreHandlePromise = this.restoreFromIndexedDB();
  }
  
  ngOnDestroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.stopAutoBackup();
  }
  
  /**
   * 请求目录访问授权
   * 用户可以选择坚果云同步目录或任意目录
   */
  async requestDirectoryAccess(): Promise<DirectoryAuthResult> {
    if (!this.isAvailable()) {
      const reason = this.compatibility().unsupportedReason || '功能不可用';
      return { success: false, error: reason };
    }
    
    try {
      this.logger.info('请求目录访问授权...');
      
      this.directoryHandle = await window.showDirectoryPicker!(LOCAL_BACKUP_CONFIG.DIRECTORY_PICKER_OPTIONS);
      
      const directoryName = this.directoryHandle.name;
      
      this._isAuthorized.set(true);
      this._directoryName.set(directoryName);
      this._hasSavedHandle.set(true);
      this._permissionState.set('granted');
      
      await this.saveDirectoryHandleToIDB();
      this.savePersistedState();

      if (this._autoBackupEnabled() && this.getProjectsFn) {
        this.startAutoBackup(this.getProjectsFn, undefined, { silent: true });
      }
      
      this.logger.info('目录授权成功', { directoryName });
      this.toast.success(`已选择备份目录：${directoryName}`);
      
      return { success: true, directoryName };
      
    } catch (error) {
      const e = error as Error;
      
      // 用户取消不算错误
      if (e.name === 'AbortError') {
        this.logger.info('用户取消目录选择');
        return { success: false, error: '已取消' };
      }
      
      this.logger.error('目录授权失败', error);
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'localBackup.requestDirectory' } });
      
      return { success: false, error: e.message };
    }
  }
  
  /**
   * 检查并恢复目录权限
   * 浏览器重启后需要重新获取权限
   */
  async checkAndRestorePermission(options: PermissionCheckOptions = {}): Promise<boolean> {
    await this.ensureDirectoryHandleLoaded();

    if (!this.directoryHandle) {
      return false;
    }
    
    try {
      // 查询当前权限状态
      const permission = await this.directoryHandle.queryPermission({ mode: 'readwrite' });
      this._permissionState.set(permission);
      
      if (permission === 'granted') {
        this._isAuthorized.set(true);
        return true;
      }
      
      if (options.request === false) {
        this._isAuthorized.set(false);
        return false;
      }

      // 尝试请求权限（必须由用户手势触发）
      const request = await this.directoryHandle.requestPermission({ mode: 'readwrite' });
      this._permissionState.set(request);
      
      if (request === 'granted') {
        this._isAuthorized.set(true);
        return true;
      }
      
      return false;
      
    } catch (error) {
      if (isStaleDirectoryHandleError(error)) {
        await this.invalidateDirectoryHandleAfterStateError(options.request !== false);
        return false;
      }

      this.logger.warn('权限检查失败', error);
      this._permissionState.set('denied');
      return false;
    }
  }
  
  /**
   * 恢复权限（由用户手势触发）
   * 用于浏览器重启后重新获取权限
   */
  async resumePermission(): Promise<boolean> {
    if (!this.directoryHandle) {
      // 尝试从 IndexedDB 恢复 handle
      const restored = await this.ensureDirectoryHandleLoaded();
      if (!restored || !this.directoryHandle) {
        this.toast.error('未找到保存的备份目录，请重新选择');
        return false;
      }
    }
    
    try {
      const permission = await this.directoryHandle.requestPermission({ mode: 'readwrite' });
      this._permissionState.set(permission);
      
      if (permission === 'granted') {
        this._isAuthorized.set(true);
        this._directoryName.set(this.directoryHandle.name);
        this.toast.success(`已恢复备份目录：${this.directoryHandle.name}`);
        
        // 如果之前启用了自动备份，自动恢复
        if (this._autoBackupEnabled() && this.getProjectsFn) {
          this.startAutoBackup(this.getProjectsFn);
          this.logger.info('自动备份已自动恢复');
        }
        
        return true;
      }
      
      this.toast.info('权限请求被拒绝');
      return false;
      
    } catch (error) {
      if (isStaleDirectoryHandleError(error)) {
        await this.invalidateDirectoryHandleAfterStateError(true);
        return false;
      }

      this.logger.error('恢复权限失败', error);
      this.toast.error('恢复权限失败');
      return false;
    }
  }
  
  /**
   * 撤销目录授权
   */
  async revokeDirectoryAccess(): Promise<void> {
    this.directoryHandle = null;
    this._isAuthorized.set(false);
    this._directoryName.set(null);
    this._hasSavedHandle.set(false);
    this._permissionState.set(null);
    this.stopAutoBackup();
    
    // 清除 IndexedDB 中的 handle
    await this.clearDirectoryHandleFromIDB();
    this.clearPersistedState();
    
    this.logger.info('目录授权已撤销');
    this.toast.info('已取消本地备份目录');
  }
  
  /**
   * 执行本地备份
   * @param projects 要备份的项目列表
   */
  async performBackup(projects: LocalBackupProjectSnapshot[], options: BackupRunOptions = {}): Promise<LocalBackupResult> {
    if (this._isBackingUp()) {
      return { success: false, error: '备份正在进行中' };
    }

    this._isBackingUp.set(true);

    try {
      const preparationError = await this.prepareBackupRun(options);
      if (preparationError) {
        return preparationError;
      }

      return await this.writeBackupSnapshot(projects);
    } catch (error) {
      return await this.handleBackupFailure(error, options);
    } finally {
      this._isBackingUp.set(false);
    }
  }

  private async prepareBackupRun(options: BackupRunOptions): Promise<LocalBackupResult | null> {
    await this.ensureDirectoryHandleLoaded();

    if (!this.directoryHandle) {
      return { success: false, error: '未授权目录访问，请先选择备份目录' };
    }

    // 检查权限
    const hasPermission = await this.checkAndRestorePermission({ request: options.requestPermission !== false });
    if (!hasPermission) {
      this._isAuthorized.set(false);
      return { success: false, error: '目录访问权限已过期，请重新授权' };
    }

    return null;
  }

  private async writeBackupSnapshot(projects: LocalBackupProjectSnapshot[]): Promise<LocalBackupResult> {
    this.logger.info('开始本地备份...', { projectCount: projects.length });

    const { blob, deferredCloudUserState } = await this.disasterBackupService.buildLocalBlob(projects as Project[], {
      autoBackupEnabled: this._autoBackupEnabled(),
      autoBackupIntervalMs: this._autoBackupIntervalMs(),
    });

    if (deferredCloudUserState) {
      return {
        success: false,
        error: '浏览器恢复连接中，自动备份稍后重试',
        deferred: true,
      };
    }

    const filename = buildLocalBackupFilename(createLocalBackupTimestamp());
    await this.writeBackupFile(filename, blob);

    return this.recordBackupSuccess(filename, blob.size);
  }

  private async writeBackupFile(filename: string, blob: Blob): Promise<void> {
    if (!this.directoryHandle) {
      throw new Error('未授权目录访问，请先选择备份目录');
    }

    await this.directoryFiles.writeBackupFile(this.directoryHandle, filename, blob);
  }

  private recordBackupSuccess(filename: string, size: number): LocalBackupResult {
    const backupTime = new Date().toISOString();
    this._lastBackupTime.set(backupTime);
    this.savePersistedState();
    this.exportService.recordLocalBackupSuccess(backupTime);

    this.logger.info('本地备份完成', { filename, size });

    return {
      success: true,
      filename,
      size,
      timestamp: backupTime,
      pathHint: `${this._directoryName()}/${filename}`,
    };
  }

  private async handleBackupFailure(error: unknown, options: BackupRunOptions): Promise<LocalBackupResult> {
    if (isStaleDirectoryHandleError(error)) {
      await this.invalidateDirectoryHandleAfterStateError(options.requestPermission !== false);
      return { success: false, error: STALE_DIRECTORY_HANDLE_MESSAGE };
    }

    if (isBrowserNetworkSuspendedError(error)) {
      return {
        success: false,
        error: '浏览器恢复连接中，自动备份稍后重试',
        deferred: true,
      };
    }

    const e = error as Error;
    this.logger.error('本地备份失败', error);
    this.sentryLazyLoader.captureException(error, { tags: { operation: 'localBackup.perform' } });

    return { success: false, error: e.message };
  }
  
  /**
   * 列出备份目录中的所有备份文件
   * @returns 按时间倒序排列的备份文件列表
   */
  async listBackupFiles(): Promise<{ name: string; timestamp: number; size: number }[]> {
    if (!this.directoryHandle) {
      return [];
    }

    return this.directoryFiles.listBackupFiles(
      this.directoryHandle,
      () => this.checkAndRestorePermission()
    );
  }
  
  /**
   * 从备份目录读取指定备份文件为 File 对象
   * 返回的 File 可以直接传入 ImportService.validateFile() 进行导入
   */
  async readBackupFile(filename: string): Promise<File | null> {
    if (!this.directoryHandle) {
      return null;
    }

    return this.directoryFiles.readBackupFile(
      this.directoryHandle,
      filename,
      () => this.checkAndRestorePermission()
    );
  }
  
  /**
   * 启动自动备份
   * @param getProjects 获取项目列表的函数
   * @param intervalMs 备份间隔（毫秒）
   */
  startAutoBackup(
    getProjects: () => LocalBackupProjectSnapshot[],
    intervalMs?: number,
    options: AutoBackupStartOptions = {},
  ): void {
    if (this.destroyed) {
      return;
    }

    if (!this._isAuthorized()) {
      this.logger.warn('未授权目录，无法启动自动备份');
      return;
    }
    
    // 停止现有定时器
    this.stopAutoBackup(false); // 不更新状态，避免循环
    
    const interval = intervalMs ?? this._autoBackupIntervalMs();
    
    // 保存获取项目的函数，用于权限恢复后自动恢复备份
    this.getProjectsFn = getProjects;
    this.deferredRetryScheduler.clear();
    
    this.autoBackupTimer = setInterval(() => {
      void this.runAutoBackupCycle();
    }, interval);
    
    this._autoBackupEnabled.set(true);
    this._autoBackupIntervalMs.set(interval);
    this.savePersistedState();
    
    this.logger.info('自动备份已启动', { intervalMs: interval });
    if (!options.silent) {
      this.toast.success('自动备份已开启');
    }
  }
  
  /**
   * 停止自动备份
   * @param updateState 是否更新状态（默认 true）
   */
  stopAutoBackup(updateState = true): void {
    // 显式 null 判断：interval handle 为 0 时也要清理，否则重启路径会残留双备份周期
    if (this.autoBackupTimer !== null) {
      clearInterval(this.autoBackupTimer);
      this.autoBackupTimer = null;
    }
    this.deferredRetryScheduler.clear();
    
    if (updateState) {
      this._autoBackupEnabled.set(false);
      this.savePersistedState();
      this.logger.info('自动备份已停止');
    }
  }
  
  /**
   * 设置自动备份间隔
   */
  setAutoBackupInterval(intervalMs: number): void {
    this._autoBackupIntervalMs.set(intervalMs);
    this.savePersistedState();
    if (this._autoBackupEnabled() && this._isAuthorized() && this.getProjectsFn) {
      this.startAutoBackup(this.getProjectsFn, intervalMs, { silent: true });
    }
  }
  
  /**
   * 加载持久化状态（localStorage）
   */
  private loadPersistedState(): void {
    try {
      const state = this.persistence.loadState();
      if (state.lastBackupTime) {
        this._lastBackupTime.set(state.lastBackupTime);
      }

      if (state.autoBackupEnabled) {
        this._autoBackupEnabled.set(true);
      }

      if (state.autoBackupIntervalMs !== null) {
        this._autoBackupIntervalMs.set(state.autoBackupIntervalMs);
      }

      if (state.directoryName) {
        this._directoryName.set(state.directoryName);
        this._hasSavedHandle.set(state.hasSavedHandle);
      }
      
    } catch (error) {
      this.logger.warn('加载持久化状态失败', error);
    }
  }
  
  /**
   * 保存持久化状态（localStorage + 云端同步）
   */
  private savePersistedState(): void {
    try {
      this.persistence.saveState({
        lastBackupTime: this._lastBackupTime(),
        autoBackupEnabled: this._autoBackupEnabled(),
        autoBackupIntervalMs: this._autoBackupIntervalMs(),
        directoryName: this._directoryName(),
      });
      
      // 同步到云端（仅同步开关和间隔，不同步目录路径）
      void this.preferenceService.syncLocalBackupSettings({
        autoBackupEnabled: this._autoBackupEnabled(),
        autoBackupIntervalMs: this._autoBackupIntervalMs(),
      });
      
    } catch (error) {
      this.logger.warn('保存持久化状态失败', error);
    }
  }
  
  /**
   * 清除持久化状态
   */
  private clearPersistedState(): void {
    try {
      this.persistence.clearState();
    } catch (error) {
      this.logger.warn('清除持久化状态失败', error);
    }
  }

  private shouldDeferAutoBackupForBrowserNetwork(): boolean {
    if (!isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    this.logger.debug('浏览器网络恢复窗口内跳过本轮自动备份', {
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    return true;
  }

  private async runAutoBackupCycle(): Promise<void> {
    try {
      if (this.destroyed) {
        return;
      }

      if (!this.getProjectsFn || !this._autoBackupEnabled()) {
        return;
      }

      if (this.shouldDeferAutoBackupForBrowserNetwork()) {
        this.deferredRetryScheduler.schedule();
        return;
      }

      const projects = this.getProjectsFn();
      if (projects.length === 0) {
        return;
      }

      const result = await this.performBackup(projects, { requestPermission: false });
      if (result.success) {
        this.logger.debug('自动备份成功', { filename: result.filename });
        return;
      }

      if (result.deferred) {
        this.logger.debug('自动备份已延后', { error: result.error });
        this.deferredRetryScheduler.schedule();
        return;
      }

      this.logger.warn('自动备份失败', { error: result.error });
    } catch (error) {
      this.logger.error('自动备份周期异常', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.sentryLazyLoader.captureException(error, { tags: { operation: 'localBackup.autoBackupCycle' } });
    }
  }

  private clearPersistedDirectoryHandleName(): void {
    try {
      this.persistence.clearDirectoryHandleName();
    } catch (error) {
      this.logger.warn('清除本地备份目录名称失败', error);
    }
  }

  private async invalidateDirectoryHandleAfterStateError(notifyUser: boolean): Promise<void> {
    const directoryName = this._directoryName();
    this.stopAutoBackup(false);
    this.directoryHandle = null;
    this.restoreHandlePromise = null;
    this._isAuthorized.set(false);
    this._hasSavedHandle.set(false);
    this._permissionState.set(null);
    this._directoryName.set(null);
    this.clearPersistedDirectoryHandleName();
    await this.clearDirectoryHandleFromIDB();
    this.savePersistedState();

    this.logger.warn('备份目录句柄失效，已暂停自动备份', { directoryName });
    if (notifyUser) {
      this.toast.error(STALE_DIRECTORY_HANDLE_MESSAGE);
    }
  }
  
  /**
   * 保存 DirectoryHandle 到 IndexedDB
   */
  private async saveDirectoryHandleToIDB(): Promise<void> {
    if (!this.directoryHandle) return;

    try {
      await this.persistence.saveDirectoryHandle(this.directoryHandle);
    } catch (error) {
      this.logger.warn('保存 DirectoryHandle 到 IndexedDB 失败', error);
    }
  }
  
  /**
   * 从 IndexedDB 恢复 DirectoryHandle
   * @returns 是否成功恢复
   */
  private async restoreFromIndexedDB(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    
    try {
      const handle = await this.persistence.restoreDirectoryHandle();
      
      if (!handle) {
        return false;
      }
      
      this.directoryHandle = handle;
      this._directoryName.set(handle.name);
      this._hasSavedHandle.set(true);
      
      // 检查权限状态（不请求权限，只查询）
      try {
        const permission = await handle.queryPermission({ mode: 'readwrite' });
        this._permissionState.set(permission);
        
        if (permission === 'granted') {
          // 权限仍然有效，自动恢复
          this._isAuthorized.set(true);
          this.logger.info('DirectoryHandle 权限仍然有效，已自动恢复', { name: handle.name });
          this.restoreAutoBackupAfterDirectoryPermission();
          return true;
        } else if (permission === 'prompt') {
          // 需要用户点击恢复权限
          this.logger.info('DirectoryHandle 已恢复，等待用户授权', { name: handle.name });
          return true;
        } else {
          // 权限被拒绝
          this.logger.warn('DirectoryHandle 权限已被拒绝');
          return false;
        }
      } catch (permError) {
        this.logger.warn('查询权限失败', permError);
        this._permissionState.set('prompt');
        return true; // handle 存在，但需要用户确认
      }
      
    } catch (error) {
      this.logger.warn('从 IndexedDB 恢复 DirectoryHandle 失败', error);
      return false;
    }
  }

  private restoreAutoBackupAfterDirectoryPermission(): void {
    if (!this._autoBackupEnabled()) {
      return;
    }

    if (this.getProjectsFn) {
      this.startAutoBackup(this.getProjectsFn, undefined, { silent: true });
      this.logger.info('自动备份已随目录权限恢复');
      return;
    }

    this.logger.info('等待设置项目获取函数后恢复自动备份');
  }

  private async ensureDirectoryHandleLoaded(): Promise<boolean> {
    if (this.directoryHandle) return true;
    if (!this.restoreHandlePromise) {
      this.restoreHandlePromise = this.restoreFromIndexedDB();
    }
    await this.restoreHandlePromise;
    return !!this.directoryHandle;
  }
  
  /**
   * 清除 IndexedDB 中的 DirectoryHandle
   */
  private async clearDirectoryHandleFromIDB(): Promise<void> {
    try {
      await this.persistence.clearDirectoryHandle();
    } catch (error) {
      this.logger.warn('清除 IndexedDB 中的 DirectoryHandle 失败', error);
    }
  }
  
  /**
   * 设置项目获取函数（用于权限恢复后自动启动备份）
   * 应在应用初始化时调用
   */
  setProjectsProvider(getProjects: () => LocalBackupProjectSnapshot[]): void {
    this.getProjectsFn = getProjects;
    
    // 如果权限已授权且自动备份已启用，立即启动
    if (this._isAuthorized() && this._autoBackupEnabled() && !this.autoBackupTimer) {
      this.logger.info('权限已授权，正在恢复自动备份...');
      this.startAutoBackup(getProjects, undefined, { silent: true });
    }
  }
}
