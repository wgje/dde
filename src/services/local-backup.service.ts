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
} from '../utils/browser-network-suspension';
import { del, get, set } from 'idb-keyval';
import {
  buildLocalBackupFilename,
  createLocalBackupTimestamp,
} from './local-backup-file.helpers';
import {
  buildDeferredRetryResult,
  classifyLocalBackupFailure,
  getAutoBackupDeferredRetryWindowState,
} from './local-backup-deferred-retry-state.helpers';
import { LocalBackupDeferredRetryScheduler } from './local-backup-deferred-retry.scheduler';
import {
  LocalBackupPersistenceController,
  type LocalBackupOwnerContext,
} from './local-backup-persistence.controller';
import { LocalBackupDirectoryFilesController } from './local-backup-directory-files.controller';
import { isStaleDirectoryHandleError } from './local-backup-directory-handle.helpers';
import { resolveLocalBackupCompatibility } from './local-backup-compatibility.helpers';
import { AuthService } from './auth.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import {
  buildStaleLocalBackupSessionResult,
  LocalBackupSessionRuntimeController,
  type LocalBackupRunContext,
} from './local-backup-session-runtime.controller';
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
  private readonly auth = inject(AuthService);
  private readonly sessionRuntimeReset = inject(SessionRuntimeResetRegistry);
  private readonly persistence = new LocalBackupPersistenceController({
    logger: this.logger,
    idbGet: get,
    idbSet: set,
    idbDel: del,
  });
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private restoreHandlePromise: Promise<boolean> | null = null;
  private autoBackupTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private unregisterSessionRuntimeReset: (() => void) | null = null;
  /** 用于自动备份的项目获取函数（持久化后恢复使用） */
  private getProjectsFn: (() => LocalBackupProjectSnapshot[]) | null = null;
  private readonly deferredRetryScheduler = new LocalBackupDeferredRetryScheduler({
    isEnabled: () => this._autoBackupEnabled(),
    hasProjectsProvider: () => !!this.getProjectsFn,
    runRetry: () => void this.runAutoBackupCycle(),
    getRemainingResumeDelayMs: () => getRemainingBrowserNetworkResumeDelayMs(),
  });
  private readonly sessionRuntime = new LocalBackupSessionRuntimeController({
    currentUserId: () => this.auth.currentUserId(),
    restartAutoBackup: () => this.restartAutoBackupForCurrentSession(),
    setBackingUp: value => this._isBackingUp.set(value),
    stopAutoBackup: () => this.stopAutoBackup(false),
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
    this.unregisterSessionRuntimeReset = this.sessionRuntimeReset.register(
      'LocalBackupService',
      () => this.resetForOwnerChange(),
    );
    this.bindCurrentOwner();
  }
  
  ngOnDestroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.persistence.detachOwnerScope();
    this.sessionRuntime.destroy();
    this.unregisterSessionRuntimeReset?.();
    this.unregisterSessionRuntimeReset = null;
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
    const ownerContext = this.persistence.captureOwnerContext();
    if (!ownerContext) return { success: false, error: '会话已切换' };
    try {
      this.logger.info('请求目录访问授权...');
      const handle = await window.showDirectoryPicker!(LOCAL_BACKUP_CONFIG.DIRECTORY_PICKER_OPTIONS);
      if (!this.persistence.isOwnerContextCurrent(ownerContext)) {
        return { success: false, error: '会话已切换' };
      }
      this.directoryHandle = handle;
      const directoryName = handle.name;
      this._isAuthorized.set(true);
      this._directoryName.set(directoryName);
      this._hasSavedHandle.set(true);
      this._permissionState.set('granted');
      // 保存当前 owner DirectoryHandle 到 IndexedDB
      await this.persistence.saveDirectoryHandle(ownerContext, handle);
      if (!this.persistence.isOwnerContextCurrent(ownerContext)) {
        return { success: false, error: '会话已切换' };
      }
      this.savePersistedState(ownerContext);
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
    const ownerContext = this.persistence.captureOwnerContext();
    return ownerContext ? this.checkPermissionForOwner(ownerContext, options) : false;
  }

  private async checkPermissionForOwner(
    ownerContext: LocalBackupOwnerContext,
    options: PermissionCheckOptions,
  ): Promise<boolean> {
    await this.ensureDirectoryHandleLoaded(ownerContext);
    const handle = this.currentHandle(ownerContext);
    if (!handle) return false;
    // 查询当前权限状态；仅用户手势路径继续请求权限
    const mode = options.request === false ? 'query' : 'query-and-request';
    const result = await this.persistence.resolveDirectoryPermission(ownerContext, handle, mode);
    if (result.kind === 'stale') return false;
    if (result.kind === 'error') {
      if (isStaleDirectoryHandleError(result.error)) {
        await this.invalidateDirectoryHandleAfterStateError(ownerContext, options.request !== false);
      } else {
        this.logger.warn('权限检查失败', result.error);
        this._permissionState.set('denied');
      }
      return false;
    }
    this._permissionState.set(result.permission);
    this._isAuthorized.set(result.permission === 'granted');
    return result.permission === 'granted';
  }
  
  /**
   * 恢复权限（由用户手势触发）
   * 用于浏览器重启后重新获取权限
   */
  async resumePermission(): Promise<boolean> {
    const ownerContext = this.persistence.captureOwnerContext();
    if (!ownerContext) return false;
    if (!this.currentHandle(ownerContext)) {
      // 尝试从 IndexedDB 恢复 handle
      const restored = await this.ensureDirectoryHandleLoaded(ownerContext);
      if (!restored || !this.currentHandle(ownerContext)) {
        this.toast.error('未找到保存的备份目录，请重新选择');
        return false;
      }
    }

    const handle = this.currentHandle(ownerContext);
    if (!handle) return false;
    const result = await this.persistence.resolveDirectoryPermission(ownerContext, handle, 'request');
    if (result.kind === 'stale') return false;
    if (result.kind === 'error') {
      if (isStaleDirectoryHandleError(result.error)) {
        await this.invalidateDirectoryHandleAfterStateError(ownerContext, true);
      } else {
        this.logger.error('恢复权限失败', result.error);
        this.toast.error('恢复权限失败');
      }
      return false;
    }
    this._permissionState.set(result.permission);
    if (result.permission !== 'granted') {
      this.toast.info('权限请求被拒绝');
      return false;
    }
    this._isAuthorized.set(true);
    this._directoryName.set(handle.name);
    this.toast.success(`已恢复备份目录：${handle.name}`);
    // 如果之前启用了自动备份，自动恢复
    if (this._autoBackupEnabled() && this.getProjectsFn) {
      this.startAutoBackup(this.getProjectsFn);
      this.logger.info('自动备份已自动恢复');
    }
    return true;
  }
  
  /**
   * 撤销目录授权
   */
  async revokeDirectoryAccess(): Promise<void> {
    const ownerContext = this.persistence.captureOwnerContext();
    this.directoryHandle = null;
    this.restoreHandlePromise = null;
    this._isAuthorized.set(false);
    this._directoryName.set(null);
    this._hasSavedHandle.set(false);
    this._permissionState.set(null);
    this.stopAutoBackup();

    if (ownerContext) {
      this.persistence.clearState(ownerContext);
      await this.persistence.clearDirectoryHandle(ownerContext);
    }
    
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

    const ownerContext = this.persistence.captureOwnerContext();
    if (!ownerContext) return buildStaleLocalBackupSessionResult();
    const runContext = this.sessionRuntime.beginRun();
    this._isBackingUp.set(true);
    try {
      const preparationError = await this.prepareBackupRun(ownerContext, options);
      if (!this.isRunCurrent(runContext, ownerContext)) {
        return buildStaleLocalBackupSessionResult();
      }
      if (preparationError) {
        return preparationError;
      }

      return await this.writeBackupSnapshot(projects, runContext, ownerContext);
    } catch (error) {
      if (!this.isRunCurrent(runContext, ownerContext)) {
        return buildStaleLocalBackupSessionResult();
      }
      return await this.handleBackupFailure(error, ownerContext, options);
    } finally {
      this.sessionRuntime.finishRun(runContext);
    }
  }
  private async prepareBackupRun(
    ownerContext: LocalBackupOwnerContext,
    options: BackupRunOptions,
  ): Promise<LocalBackupResult | null> {
    await this.ensureDirectoryHandleLoaded(ownerContext);
    if (!this.currentHandle(ownerContext)) {
      return { success: false, error: '未授权目录访问，请先选择备份目录' };
    }
    // 检查权限
    if (!this.persistence.isOwnerContextCurrent(ownerContext)) return buildStaleLocalBackupSessionResult();
    const hasPermission = await this.checkAndRestorePermission({
      request: options.requestPermission !== false,
    });
    if (!hasPermission) {
      this._isAuthorized.set(false);
      return { success: false, error: '目录访问权限已过期，请重新授权' };
    }

    return null;
  }

  private async writeBackupSnapshot(
    projects: LocalBackupProjectSnapshot[],
    runContext: LocalBackupRunContext,
    ownerContext: LocalBackupOwnerContext,
  ): Promise<LocalBackupResult> {
    this.logger.info('开始本地备份...', { projectCount: projects.length });

    const { blob, deferredCloudUserState } = await this.disasterBackupService.buildLocalBlob(projects as Project[], {
      autoBackupEnabled: this._autoBackupEnabled(),
      autoBackupIntervalMs: this._autoBackupIntervalMs(),
    });

    if (!this.isRunCurrent(runContext, ownerContext)) {
      return buildStaleLocalBackupSessionResult();
    }

    if (deferredCloudUserState) {
      return buildDeferredRetryResult();
    }

    const filename = buildLocalBackupFilename(createLocalBackupTimestamp());
    await this.writeBackupFile(ownerContext, filename, blob);

    if (!this.isRunCurrent(runContext, ownerContext)) {
      return buildStaleLocalBackupSessionResult();
    }

    return this.recordBackupSuccess(ownerContext, filename, blob.size);
  }

  private async writeBackupFile(
    ownerContext: LocalBackupOwnerContext,
    filename: string,
    blob: Blob,
  ): Promise<void> {
    const handle = this.currentHandle(ownerContext);
    if (!handle) {
      throw new Error('未授权目录访问，请先选择备份目录');
    }

    await this.directoryFilesFor(ownerContext).writeBackupFile(handle, filename, blob);
  }

  private recordBackupSuccess(
    ownerContext: LocalBackupOwnerContext,
    filename: string,
    size: number,
  ): LocalBackupResult {
    const backupTime = new Date().toISOString();
    this._lastBackupTime.set(backupTime);
    this.savePersistedState(ownerContext);
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

  private async handleBackupFailure(
    error: unknown,
    ownerContext: LocalBackupOwnerContext,
    options: BackupRunOptions,
  ): Promise<LocalBackupResult> {
    const failure = classifyLocalBackupFailure(error, STALE_DIRECTORY_HANDLE_MESSAGE);
    if (failure.kind === 'stale-directory-handle') {
      await this.invalidateDirectoryHandleAfterStateError(ownerContext, options.requestPermission !== false);
      return failure.result;
    }

    if (failure.kind === 'deferred-retry') {
      return failure.result;
    }

    this.logger.error('本地备份失败', error);
    this.sentryLazyLoader.captureException(error, { tags: { operation: 'localBackup.perform' } });

    return failure.result;
  }
  /**
   * 列出备份目录中的所有备份文件
   * @returns 按时间倒序排列的备份文件列表
   */
  async listBackupFiles(): Promise<{ name: string; timestamp: number; size: number }[]> {
    const ownerContext = this.persistence.captureOwnerContext();
    if (!ownerContext || !await this.checkPermissionForOwner(ownerContext, {})) return [];
    const handle = this.currentHandle(ownerContext);
    if (!handle) return [];
    const files = await this.directoryFilesFor(ownerContext).listBackupFiles(handle, async () => (
      this.persistence.isOwnerContextCurrent(ownerContext)
    ));
    return this.persistence.isOwnerContextCurrent(ownerContext) ? files : [];
  }
  /**
   * 从备份目录读取指定备份文件为 File 对象
   * 返回的 File 可以直接传入 ImportService.validateFile() 进行导入
   */
  async readBackupFile(filename: string): Promise<File | null> {
    const ownerContext = this.persistence.captureOwnerContext();
    if (!ownerContext || !await this.checkPermissionForOwner(ownerContext, {})) return null;
    const handle = this.currentHandle(ownerContext);
    if (!handle) return null;
    const file = await this.directoryFilesFor(ownerContext).readBackupFile(handle, filename, async () => (
      this.persistence.isOwnerContextCurrent(ownerContext)
    ));
    return this.persistence.isOwnerContextCurrent(ownerContext) ? file : null;
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
    
    try {
      this.autoBackupTimer = setInterval(() => {
        void this.runAutoBackupCycle();
      }, interval);
    } catch (error) {
      this.autoBackupTimer = null;
      this._autoBackupEnabled.set(false);
      this._autoBackupIntervalMs.set(interval);
      this.savePersistedState();
      this.warnSafely('自动备份定时器启动失败，已保持关闭状态', error);
      return;
    }
    
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
    const autoBackupTimer = this.autoBackupTimer;
    this.autoBackupTimer = null;
    if (autoBackupTimer !== null) {
      this.clearAutoBackupTimerSafely(autoBackupTimer);
    }
    this.deferredRetryScheduler.clear();
    
    if (updateState) {
      this._autoBackupEnabled.set(false);
      this.savePersistedState();
      this.logger.info('自动备份已停止');
    }
  }

  private clearAutoBackupTimerSafely(timer: ReturnType<typeof setInterval>): void {
    try {
      clearInterval(timer);
    } catch (error) {
      this.warnSafely('自动备份定时器清理失败，继续停止自动备份', error);
    }
  }

  private warnSafely(message: string, error: unknown): void {
    try {
      this.logger.warn(message, error);
    } catch {
      // Timer state is already synchronized; diagnostics must not reopen the failure path.
    }
  }

  private restartAutoBackupForCurrentSession(): void {
    if (this.destroyed) return;
    if (!this.auth.currentUserId() || !this._autoBackupEnabled() || !this._isAuthorized() || !this.getProjectsFn) {
      return;
    }
    this.startAutoBackup(this.getProjectsFn, undefined, { silent: true });
  }
  
  setAutoBackupInterval(intervalMs: number): void {
    this._autoBackupIntervalMs.set(intervalMs);
    this.savePersistedState();
    if (this._autoBackupEnabled() && this._isAuthorized() && this.getProjectsFn) {
      this.startAutoBackup(this.getProjectsFn, intervalMs, { silent: true });
    }
  }
  
  private bindCurrentOwner(): void {
    const userId = this.auth.currentUserId();
    const ownerContext = this.persistence.activateOwnerScope(
      userId ? { kind: 'authenticated', userId } : { kind: 'local' },
    );
    // 先从 localStorage 加载当前 owner 的基础状态
    this.applyPersistedState(this.persistence.loadState(ownerContext));
    // 然后从 IndexedDB 恢复当前 owner 的 DirectoryHandle（异步）
    this.restoreHandlePromise = this.restoreFromIndexedDB(ownerContext);
  }

  private resetForOwnerChange(): void {
    this.persistence.detachOwnerScope();
    this.directoryHandle = null;
    this.restoreHandlePromise = null;
    this.applyPersistedState(null);
    this._isAuthorized.set(false);
    this._permissionState.set(null);
    queueMicrotask(() => {
      if (!this.destroyed) this.bindCurrentOwner();
    });
    this.sessionRuntime.reset();
  }

  private applyPersistedState(state: ReturnType<LocalBackupPersistenceController['loadState']> | null): void {
    this._lastBackupTime.set(state?.lastBackupTime ?? null);
    this._autoBackupEnabled.set(state?.autoBackupEnabled ?? false);
    this._autoBackupIntervalMs.set(state?.autoBackupIntervalMs ?? LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS);
    this._directoryName.set(state?.directoryName ?? null);
    this._hasSavedHandle.set(state?.hasSavedHandle ?? false);
  }
  
  private savePersistedState(
    ownerContext: LocalBackupOwnerContext | null = this.persistence.captureOwnerContext(),
  ): void {
    if (!ownerContext || !this.persistence.isOwnerContextCurrent(ownerContext)) return;
    try {
      this.persistence.saveState(ownerContext, {
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

  private async runAutoBackupCycle(): Promise<void> {
    try {
      if (this.destroyed) {
        return;
      }

      if (!this.getProjectsFn || !this._autoBackupEnabled()) {
        return;
      }

      const deferredRetryWindowState = getAutoBackupDeferredRetryWindowState();
      if (deferredRetryWindowState) {
        this.logger.debug('浏览器网络恢复窗口内跳过本轮自动备份', deferredRetryWindowState);
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

  private async invalidateDirectoryHandleAfterStateError(
    ownerContext: LocalBackupOwnerContext,
    notifyUser: boolean,
  ): Promise<void> {
    if (!this.persistence.isOwnerContextCurrent(ownerContext)) return;
    const directoryName = this._directoryName();
    this.stopAutoBackup(false);
    this.directoryHandle = null;
    this.restoreHandlePromise = null;
    this._isAuthorized.set(false);
    this._hasSavedHandle.set(false);
    this._permissionState.set(null);
    this._directoryName.set(null);
    this.persistence.clearDirectoryHandleName(ownerContext);
    // 清除 IndexedDB 中的当前 owner DirectoryHandle
    await this.persistence.clearDirectoryHandle(ownerContext);
    if (!this.persistence.isOwnerContextCurrent(ownerContext)) return;
    this.savePersistedState(ownerContext);

    this.logger.warn('备份目录句柄失效，已暂停自动备份', { directoryName });
    if (notifyUser) {
      this.toast.error(STALE_DIRECTORY_HANDLE_MESSAGE);
    }
  }

  /**
   * 从 IndexedDB 恢复 DirectoryHandle
   * @returns 是否成功恢复
   */
  private async restoreFromIndexedDB(ownerContext: LocalBackupOwnerContext): Promise<boolean> {
    if (!this.isAvailable() || !this.persistence.isOwnerContextCurrent(ownerContext)) return false;
    const handle = await this.persistence.restoreDirectoryHandle(ownerContext);
    if (!handle || !this.persistence.isOwnerContextCurrent(ownerContext)) return false;
    this.directoryHandle = handle;
    this._directoryName.set(handle.name);
    this._hasSavedHandle.set(true);
    // 检查权限状态（不请求权限，只查询）
    const result = await this.persistence.resolveDirectoryPermission(ownerContext, handle, 'query');
    if (result.kind === 'stale') return false;
    if (result.kind === 'error') {
      this.logger.warn('查询权限失败', result.error);
      this._permissionState.set('prompt');
      return true; // handle 存在，但需要用户确认
    }
    this._permissionState.set(result.permission);
    if (result.permission === 'granted') {
      // 权限仍然有效，自动恢复
      this._isAuthorized.set(true);
      this.logger.info('DirectoryHandle 权限仍然有效，已自动恢复', { name: handle.name });
      if (this._autoBackupEnabled() && this.getProjectsFn) {
        this.startAutoBackup(this.getProjectsFn, undefined, { silent: true });
        this.logger.info('自动备份已随目录权限恢复');
      } else if (this._autoBackupEnabled()) {
        this.logger.info('等待设置项目获取函数后恢复自动备份');
      }
      return true;
    }
    if (result.permission === 'prompt') {
      // 需要用户点击恢复权限
      this.logger.info('DirectoryHandle 已恢复，等待用户授权', { name: handle.name });
      return true;
    }
    // 权限被拒绝
    this.logger.warn('DirectoryHandle 权限已被拒绝');
    return false;
  }

  private async ensureDirectoryHandleLoaded(ownerContext: LocalBackupOwnerContext): Promise<boolean> {
    if (this.currentHandle(ownerContext)) return true;
    if (!this.restoreHandlePromise) {
      this.restoreHandlePromise = this.restoreFromIndexedDB(ownerContext);
    }
    await this.restoreHandlePromise;
    return !!this.currentHandle(ownerContext);
  }

  private currentHandle(ownerContext: LocalBackupOwnerContext): FileSystemDirectoryHandle | null {
    return this.persistence.isOwnerContextCurrent(ownerContext) ? this.directoryHandle : null;
  }

  private isRunCurrent(
    runContext: LocalBackupRunContext,
    ownerContext: LocalBackupOwnerContext,
  ): boolean {
    return this.sessionRuntime.isRunCurrent(runContext)
      && this.persistence.isOwnerContextCurrent(ownerContext);
  }

  private directoryFilesFor(ownerContext: LocalBackupOwnerContext): LocalBackupDirectoryFilesController {
    return new LocalBackupDirectoryFilesController({
      logger: this.logger,
      isStaleDirectoryHandleError,
      invalidateDirectoryHandle: notifyUser => (
        this.invalidateDirectoryHandleAfterStateError(ownerContext, notifyUser)
      ),
    });
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
