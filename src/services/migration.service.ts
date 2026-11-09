import { Injectable, inject, signal } from '@angular/core';
import { ProjectSaveFlightCoordinatorService, ProjectDataService, RetryQueueService, SyncStateService } from '../core-bridge';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';
import { CACHE_CONFIG } from '../config';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { MigrationIntegrityService } from './migration-integrity.service';
import {
  MigrationStatusRecord,
  IntegrityCheckResult,
  MigrationStrategy,
  MigrationResult
} from './migration.types';
import { detectMigrationNeed } from './migration-detection.helpers';
import {
  mergeTombstoneRecord,
  parseTombstoneRecord,
  serializeTombstoneRecord,
} from './migration-tombstone-storage.helpers';

// 重新导出类型以保持向后兼容
export type {
  MigrationStatus,
  MigrationStatusRecord,
  IntegrityCheckResult,
  IntegrityIssue,
  MigrationStrategy,
  MigrationResult
} from './migration.types';

interface MigrationUploadState {
  migratedCount: number;
  failedProjects: string[];
}

/**
 * 本地数据迁移服务
 * 
 * 处理用户从"访客模式"转换为"已登录状态"时的数据迁移：
 * - 检测本地是否有未同步的项目数据
 * - 提供多种迁移策略供用户选择
 * - 执行数据迁移或合并
 */
@Injectable({
  providedIn: 'root'
})
export class MigrationService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly integrity = inject(MigrationIntegrityService);
  private projectSaveCoordinator = inject(ProjectSaveFlightCoordinatorService);
  private projectData = inject(ProjectDataService);
  private retryQueue = inject(RetryQueueService);
  private syncState = inject(SyncStateService);
  private toast = inject(ToastService);
  private loggerService = inject(LoggerService);
  private logger = this.loggerService.category('Migration');
  
  /** 是否需要迁移（有本地数据且用户刚登录） */
  readonly needsMigration = signal(false);
  
  /** 本地项目数据（待迁移） */
  readonly localProjects = signal<Project[]>([]);
  
  /** 远程项目数据（用于比较） */
  readonly remoteProjects = signal<Project[]>([]);
  
  /** 迁移对话框是否显示 */
  readonly showMigrationDialog = signal(false);
  
  private readonly GUEST_DATA_KEY = 'nanoflow.guest-data';
  private readonly DATA_VERSION = 2; // 数据结构版本号
  private readonly GUEST_DATA_EXPIRY_DAYS = 30; // 访客数据过期天数
  private readonly GUEST_DATA_WARNING_DAYS = 7; // 到期前提醒天数
  private readonly GUEST_DATA_WARNING_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 小时内最多提醒一次
  private readonly GUEST_DATA_WARNING_KEY = 'nanoflow.guest-data-expiry-warning-at';
  private readonly TOMBSTONE_KEY = 'nanoflow.local-tombstones';
  private readonly LEGACY_TOMBSTONE_KEYS = [
    'nanoflow.local-tombstones.task-sync',
    'nanoflow.local-tombstones.project-data',
    'nanoflow.local-tombstones.legacy'
  ] as const;

  constructor() {
    this.migrateLegacyTombstoneStorage();
    this.notifyGuestDataExpiryIfNeeded();
  }
  
  /**
   * 检查是否需要数据迁移
   * 在用户登录时调用
   */
  checkMigrationNeeded(remoteProjects: Project[]): boolean {
    const localData = this.getLocalGuestData();
    
    if (!localData || localData.length === 0) {
      this.needsMigration.set(false);
      return false;
    }

    if (detectMigrationNeed(localData, remoteProjects)) {
      this.needsMigration.set(true);
      this.localProjects.set(localData);
      this.remoteProjects.set(remoteProjects);
      return true;
    }
    
    this.needsMigration.set(false);
    return false;
  }
  
  /**
   * 显示迁移选择对话框
   */
  showMigrationOptions() {
    if (this.needsMigration()) {
      this.showMigrationDialog.set(true);
    }
  }
  
  /**
   * 执行数据迁移
   * 
   * 【Week 2 安全增强】迁移前创建快照
   * - 优先使用 sessionStorage（会话结束自动清理）
   * - 超过 5MB 限制时降级到 localStorage
   * - 提供恢复能力
   * - 【v5.9】加入数据完整性检查和状态跟踪
   */
  async executeMigration(
    strategy: MigrationStrategy, 
    userId: string
  ): Promise<MigrationResult> {
    const localData = this.localProjects();
    const remoteData = this.remoteProjects();
    
    if (!localData || localData.length === 0) {
      return { success: true, migratedProjects: 0, strategy };
    }
    
    const preparationFailure = this.prepareMigration(localData, strategy);
    if (preparationFailure) return preparationFailure;

    try {
      const result = await this.runMigrationStrategy(strategy, localData, remoteData, userId);
      await this.verifyMigrationResult(result, strategy, localData, userId);
      this.clearSuccessfulMigrationState(result);
      return result;
    } catch (e: unknown) {
      return this.handleMigrationExecutionError(e, strategy, localData.length);
    } finally {
      this.resetMigrationDialogState();
    }
  }

  private prepareMigration(localData: Project[], strategy: MigrationStrategy): MigrationResult | null {
    // 【v5.9】初始化迁移状态
    this.integrity.updateMigrationStatus('preparing', {
      projectsTotal: localData.length,
      projectsCompleted: 0,
      projectsFailed: []
    });
    
    // 【v5.9】迁移前数据完整性检查
    this.integrity.updateMigrationStatus('validating');
    const integrityCheck = this.integrity.validateDataIntegrity(localData);
    if (!integrityCheck.valid) {
      const errorIssues = integrityCheck.issues.filter(i => i.severity === 'error');
      this.integrity.updateMigrationStatus('failed', {
        error: `数据完整性检查失败: ${errorIssues.length} 个严重问题`
      });
      this.toast.error('数据完整性检查失败', `发现 ${errorIssues.length} 个严重问题，请检查数据后重试`);
      return {
        success: false,
        migratedProjects: 0,
        strategy,
        error: `数据完整性检查失败: ${errorIssues.map(i => i.message).join('; ')}`
      };
    }
    
    // 警告级别问题：记录但继续
    const warningIssues = integrityCheck.issues.filter(i => i.severity === 'warning');
    if (warningIssues.length > 0) {
      this.logger.warn('数据完整性检查发现警告', { warnings: warningIssues.length });
    }
    
    // 【Week 2】迁移前保存快照
    const snapshotSaved = this.integrity.saveMigrationSnapshot(localData);
    if (!snapshotSaved) {
      // 快照保存失败，提示用户但允许继续（非阻塞性警告）
      this.toast.warning('无法保存迁移快照', '建议先手动导出数据再继续');
    }

    return null;
  }

  private async runMigrationStrategy(
    strategy: MigrationStrategy,
    localData: Project[],
    remoteData: Project[],
    userId: string,
  ): Promise<MigrationResult> {
    switch (strategy) {
      case 'keep-local':
        this.integrity.updateMigrationStatus('uploading');
        return await this.migrateLocalToCloud(localData, userId);
      case 'keep-remote':
        return this.keepRemoteMigrationResult(strategy);
      case 'merge':
        return await this.mergeLocalAndRemote(localData, remoteData, userId);
      case 'discard-local':
        return this.discardLocalMigrationResult(strategy);
      default:
        this.integrity.updateMigrationStatus('failed', { error: '未知的迁移策略' });
        return { success: false, migratedProjects: 0, strategy, error: '未知的迁移策略' };
    }
  }

  private keepRemoteMigrationResult(strategy: MigrationStrategy): MigrationResult {
    this.integrity.updateMigrationStatus('cleaning');
    this.clearLocalGuestData();
    this.integrity.updateMigrationStatus('completed');
    return { success: true, migratedProjects: 0, strategy };
  }

  private discardLocalMigrationResult(strategy: MigrationStrategy): MigrationResult {
    this.integrity.updateMigrationStatus('cleaning');
    this.clearLocalGuestData();
    // 清除离线缓存（原 SimpleSyncService.clearOfflineCache 的本地化组合：清快照+清重试队列+归零 pendingCount，避免依赖门面）
    this.projectData.clearOfflineSnapshot();
    this.retryQueue.clear();
    this.syncState.update({ pendingCount: 0 });
    this.logger.info('离线缓存已清除');
    this.integrity.updateMigrationStatus('completed');
    return { success: true, migratedProjects: 0, strategy };
  }

  private async verifyMigrationResult(
    result: MigrationResult,
    strategy: MigrationStrategy,
    localData: Project[],
    userId: string,
  ): Promise<void> {
    if (!result.success || (strategy !== 'keep-local' && strategy !== 'merge')) return;

    const verification = await this.integrity.verifyMigrationSuccess(localData, userId);
    if (!verification.success) {
      this.logger.error('迁移验证失败，但数据已上传', { missingItems: verification.missingItems });
      this.toast.warning('部分数据可能未完全同步', '请检查您的项目列表');
    }
  }

  private clearSuccessfulMigrationState(result: MigrationResult): void {
    if (!result.success) return;

    this.integrity.clearMigrationSnapshot();
    this.integrity.clearMigrationStatus();
  }

  private handleMigrationExecutionError(
    error: unknown,
    strategy: MigrationStrategy,
    projectCount: number,
  ): MigrationResult {
    const err = error as { message?: string };
    this.integrity.updateMigrationStatus('failed', { error: err?.message ?? String(error) });
    this.sentryLazyLoader.captureException(error, {
      tags: { operation: 'executeMigration', strategy },
      extra: { projectCount }
    });
    return {
      success: false,
      migratedProjects: 0,
      strategy,
      error: err?.message ?? String(error)
    };
  }

  private resetMigrationDialogState(): void {
    this.needsMigration.set(false);
    this.showMigrationDialog.set(false);
    this.localProjects.set([]);
    this.remoteProjects.set([]);
  }
  
  /**
   * 将本地数据迁移到云端
   * 【v5.9】加入状态跟踪
   */
  private async migrateLocalToCloud(
    localProjects: Project[], 
    userId: string
  ): Promise<MigrationResult> {
    const state = this.createMigrationUploadState();
    
    this.integrity.updateMigrationStatus('uploading', {
      projectsTotal: localProjects.length,
      projectsCompleted: 0,
      projectsFailed: []
    });
    
    for (const project of localProjects) {
      await this.uploadProjectForMigration(project, userId, state, '迁移项目失败:');
      this.updateUploadProgress(state);
    }
    
    this.finalizeLocalUploadMigration(state);
    return {
      success: state.failedProjects.length === 0,
      migratedProjects: state.migratedCount,
      strategy: 'keep-local',
      error: state.failedProjects.length > 0 ? `${state.failedProjects.length} 个项目迁移失败，本地数据已保留` : undefined
    };
  }

  private createMigrationUploadState(): MigrationUploadState {
    return { migratedCount: 0, failedProjects: [] };
  }

  private async uploadProjectForMigration(
    project: Project,
    userId: string,
    state: MigrationUploadState,
    failureLogMessage: string,
  ): Promise<void> {
    try {
      const result = await this.projectSaveCoordinator.save(project, userId);
      if (result.success) {
        state.migratedCount++;
      } else {
        state.failedProjects.push(project.name || project.id);
      }
    } catch (e) {
      this.logger.warn(failureLogMessage, { projectId: project.id, error: e });
      state.failedProjects.push(project.name || project.id);
    }
  }

  private updateUploadProgress(state: MigrationUploadState): void {
    this.integrity.updateMigrationStatus('uploading', {
      projectsCompleted: state.migratedCount + state.failedProjects.length,
      projectsFailed: state.failedProjects
    });
  }

  private finalizeLocalUploadMigration(state: MigrationUploadState): void {
    if (state.failedProjects.length === 0) {
      this.integrity.updateMigrationStatus('cleaning');
      this.clearLocalGuestData();
      this.integrity.updateMigrationStatus('completed');
    } else {
      this.recordPartialMigrationFailure(state, 'migrateLocalToCloud', '迁移');
    }

    if (state.failedProjects.length > 0) {
      this.toast.warning('部分项目迁移失败', `以下项目未能上传: ${state.failedProjects.join(', ')}。本地数据已保留，您可以稍后重试。`);
    }
    if (state.migratedCount > 0) {
      this.toast.success('数据迁移完成', `已将 ${state.migratedCount} 个项目上传到云端`);
    }
  }

  /**
   * 智能合并本地和远程数据
   * 【v5.9 原子性修复】仅在全部成功时才清除本地数据
   */
  private async mergeLocalAndRemote(
    localProjects: Project[],
    remoteProjects: Project[],
    userId: string
  ): Promise<MigrationResult> {
    const remoteProjectMap = new Map(remoteProjects.map(project => [project.id, project]));
    const state = this.createMigrationUploadState();
    
    this.integrity.updateMigrationStatus('uploading', {
      projectsTotal: localProjects.length,
      projectsCompleted: 0,
      projectsFailed: []
    });
    
    for (const localProject of localProjects) {
      const remoteProject = remoteProjectMap.get(localProject.id);
      const projectToUpload = remoteProject ? this.mergeProjects(localProject, remoteProject) : localProject;
      await this.uploadProjectForMigration(projectToUpload, userId, state, '合并项目失败:');
      this.updateUploadProgress(state);
    }
    
    this.finalizeMergedUploadMigration(state);
    return {
      success: state.failedProjects.length === 0,
      migratedProjects: state.migratedCount,
      strategy: 'merge',
      error: state.failedProjects.length > 0 ? `${state.failedProjects.length} 个项目合并失败，本地数据已保留` : undefined
    };
  }

  private finalizeMergedUploadMigration(state: MigrationUploadState): void {
    if (state.failedProjects.length === 0) {
      this.integrity.updateMigrationStatus('cleaning');
      this.clearLocalGuestData();
      this.integrity.updateMigrationStatus('completed');
      this.toast.success('数据合并完成', `已合并 ${state.migratedCount} 个项目`);
      return;
    }

    this.recordPartialMigrationFailure(state, 'mergeLocalAndRemote', '合并');
    this.toast.warning('部分项目合并失败', `以下项目未能上传: ${state.failedProjects.join(', ')}。`);
  }

  private recordPartialMigrationFailure(
    state: MigrationUploadState,
    operation: 'migrateLocalToCloud' | 'mergeLocalAndRemote',
    label: '迁移' | '合并',
  ): void {
    this.integrity.updateMigrationStatus('failed', {
      projectsFailed: state.failedProjects,
      error: `${state.failedProjects.length} 个项目${label}失败`
    });
    this.logger.warn(`${label}部分失败，保留本地数据供重试`, {
      migratedCount: state.migratedCount,
      failedProjects: state.failedProjects
    });
    this.sentryLazyLoader.captureMessage(`数据${label}部分失败`, {
      level: 'warning',
      tags: { operation },
      extra: { migratedCount: state.migratedCount, failedProjects: state.failedProjects }
    });
  }
  
  /**
   * 合并两个项目（保留双方的新增内容）
   */
  private mergeProjects(local: Project, remote: Project): Project {
    // 创建任务 ID 集合
    const localTaskIds = new Set(local.tasks.map(t => t.id));
    const remoteTaskIds = new Set(remote.tasks.map(t => t.id));
    const remoteTaskMap = new Map(remote.tasks.map(t => [t.id, t] as const));

    // 合并任务：保留两边都有的，加入只有一边有的
    const mergedTasks: Task[] = [];

    // 添加本地任务
    for (const task of local.tasks) {
      if (remoteTaskIds.has(task.id)) {
        // 双方都有，比较更新时间，取较新的
        const remoteTask = remoteTaskMap.get(task.id);
        if (remoteTask) {
          const localUpdated = new Date(task.updatedAt || task.createdDate || 0).getTime();
          const remoteUpdated = new Date(remoteTask.updatedAt || remoteTask.createdDate || 0).getTime();
          mergedTasks.push(localUpdated >= remoteUpdated ? task : remoteTask);
        } else {
          mergedTasks.push(task);
        }
      } else {
        // 只有本地有
        mergedTasks.push(task);
      }
    }
    
    // 添加只有远程有的任务
    for (const task of remote.tasks) {
      if (!localTaskIds.has(task.id)) {
        mergedTasks.push(task);
      }
    }
    
    // 合并连接
    const connectionKeys = new Set<string>();
    const mergedConnections = [...local.connections, ...remote.connections].filter(conn => {
      const key = `${conn.source}->${conn.target}`;
      if (connectionKeys.has(key)) return false;
      connectionKeys.add(key);
      return true;
    });
    
    return {
      ...local,
      tasks: mergedTasks,
      connections: mergedConnections,
      updatedAt: new Date().toISOString(),
      version: Math.max(local.version ?? 0, remote.version ?? 0) + 1
    };
  }
  
  /**
   * 保存访客数据标记（在用户登出或未登录时创建数据时调用）
   * 数据将在 GUEST_DATA_EXPIRY_DAYS 天后过期
   */
  saveGuestData(projects: Project[]) {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + this.GUEST_DATA_EXPIRY_DAYS);
      
      localStorage.setItem(this.GUEST_DATA_KEY, JSON.stringify({
        projects,
        version: this.DATA_VERSION,
        savedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString()
      }));
    } catch (e) {
      this.logger.warn('保存访客数据失败', { error: e });
    }
  }
  
  /**
   * 获取本地访客数据
   * 包含版本检查、数据迁移和过期检查
   */
  getLocalGuestData(): Project[] | null {
    if (typeof localStorage === 'undefined') return null;
    
    try {
      // 先尝试从访客数据 key 读取
      const guestData = localStorage.getItem(this.GUEST_DATA_KEY);
      if (guestData) {
        const parsed = JSON.parse(guestData);
        const dataVersion = parsed.version ?? 1;
        let projects = parsed.projects || null;
        
        // 过期检查 - 使用 UTC 时间戳比较，避免时区问题
        if (parsed.expiresAt) {
          const expiresAtTimestamp = new Date(parsed.expiresAt).getTime();
          const nowTimestamp = Date.now();
          if (expiresAtTimestamp < nowTimestamp) {
            this.logger.debug('访客数据已过期，清理中...');
            this.clearLocalGuestData();
            return null;
          }
        }
        
        this.notifyGuestDataExpiryIfNeeded(parsed.expiresAt);
        
        // 版本检查和迁移
        if (projects && dataVersion < this.DATA_VERSION) {
          projects = this.migrateLocalData(projects, dataVersion);
          // 保存迁移后的数据
          this.saveGuestData(projects);
        }
        
        return projects;
      }
      
      // 回退到离线缓存
      const offlineCache = localStorage.getItem(CACHE_CONFIG.OFFLINE_CACHE_KEY);
      if (offlineCache) {
        const parsed = JSON.parse(offlineCache);
        return parsed.projects || null;
      }
      
      return null;
    } catch (e) {
      this.logger.warn('读取访客数据失败', { error: e });
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：旧数据读取失败不阻断迁移
      return null;
    }
  }
  
  /**
   * 迁移本地数据到最新版本
   */
  private migrateLocalData(projects: Project[], fromVersion: number): Project[] {
    let migrated = projects;
    
    // 版本 1 -> 2: 添加 version 字段、status 默认值等
    if (fromVersion < 2) {
      migrated = migrated.map(project => ({
        ...project,
        version: project.version ?? 0,
        tasks: project.tasks.map(task => ({
          ...task,
          status: task.status || 'active',
          rank: task.rank ?? 10000
        }))
      }));
    }
    
    return migrated;
  }
  
  /**
   * 清除访客数据标记
   */
  clearLocalGuestData() {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.GUEST_DATA_KEY);
    localStorage.removeItem(this.GUEST_DATA_WARNING_KEY);
  }

  /**
   * 检查访客数据是否临近过期，必要时给出提醒（24h 节流）
   */
  private notifyGuestDataExpiryIfNeeded(expiresAtRaw?: unknown): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const expiresAt = this.resolveGuestDataExpiresAt(expiresAtRaw);
      if (!expiresAt) return;

      const expiresAtTimestamp = new Date(expiresAt).getTime();
      if (Number.isNaN(expiresAtTimestamp)) return;

      const nowTimestamp = Date.now();
      const remainingMs = expiresAtTimestamp - nowTimestamp;
      if (remainingMs <= 0) return;

      const warningWindowMs = this.GUEST_DATA_WARNING_DAYS * 24 * 60 * 60 * 1000;
      if (remainingMs > warningWindowMs) return;
      if (!this.canShowGuestExpiryWarning(nowTimestamp)) return;

      const daysLeft = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
      this.toast.warning(
        '访客数据即将过期',
        `当前访客数据将在 ${daysLeft} 天后过期，请尽快登录迁移或手动导出`
      );
      localStorage.setItem(this.GUEST_DATA_WARNING_KEY, String(nowTimestamp));
      this.logger.info('已提醒访客数据即将过期', { daysLeft, expiresAt });
    } catch (error) {
      this.logger.debug('访客数据过期提醒检查失败（已忽略）', { error });
    }
  }

  /**
   * 解析访客数据到期时间
   */
  private resolveGuestDataExpiresAt(expiresAtRaw?: unknown): string | null {
    if (typeof expiresAtRaw === 'string' && expiresAtRaw.length > 0) {
      return expiresAtRaw;
    }

    const guestData = localStorage.getItem(this.GUEST_DATA_KEY);
    if (!guestData) return null;

    const parsed = JSON.parse(guestData) as { expiresAt?: unknown };
    return typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null;
  }

  /**
   * 24 小时节流：避免每次启动都重复提示
   */
  private canShowGuestExpiryWarning(nowTimestamp: number): boolean {
    const lastWarningAt = localStorage.getItem(this.GUEST_DATA_WARNING_KEY);
    if (!lastWarningAt) return true;

    const lastTimestamp = Number(lastWarningAt);
    if (Number.isNaN(lastTimestamp)) return true;

    return nowTimestamp - lastTimestamp >= this.GUEST_DATA_WARNING_COOLDOWN_MS;
  }

  /**
   * 迁移历史 tombstone 本地键到统一键
   * 幂等执行：重复运行不会重复写入同一 taskId
   */
  private migrateLegacyTombstoneStorage(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }

    try {
      const merged = parseTombstoneRecord(localStorage.getItem(this.TOMBSTONE_KEY));
      let migratedCount = 0;

      for (const key of this.LEGACY_TOMBSTONE_KEYS) {
        const legacy = parseTombstoneRecord(localStorage.getItem(key));
        if (Object.keys(legacy).length === 0) {
          continue;
        }

        migratedCount += mergeTombstoneRecord(merged, legacy);
      }

      if (migratedCount === 0) {
        return;
      }

      localStorage.setItem(this.TOMBSTONE_KEY, JSON.stringify(serializeTombstoneRecord(merged)));

      for (const key of this.LEGACY_TOMBSTONE_KEYS) {
        localStorage.removeItem(key);
      }

      this.logger.info('完成 tombstone 本地键迁移', {
        migratedCount,
        targetKey: this.TOMBSTONE_KEY
      });
    } catch (error) {
      this.logger.error('tombstone 本地键迁移失败（保留旧数据）', { error });
      this.sentryLazyLoader.captureException(error, {
        tags: { operation: 'migrateLegacyTombstoneStorage' }
      });
    }
  }

  /**
   * 获取迁移摘要信息
   */
  getMigrationSummary(): {
    localCount: number;
    remoteCount: number;
    localOnlyCount: number;
    conflictCount: number;
  } {
    const local = this.localProjects();
    const remote = this.remoteProjects();
    const remoteIds = new Set(remote.map(p => p.id));
    
    const localOnlyCount = local.filter(p => !remoteIds.has(p.id)).length;
    const conflictCount = local.filter(p => remoteIds.has(p.id)).length;
    
    return {
      localCount: local.length,
      remoteCount: remote.length,
      localOnlyCount,
      conflictCount
    };
  }
  
  // ========== 委托到 MigrationIntegrityService ==========

  /** 从快照恢复数据 */
  recoverFromSnapshot(): Project[] | null {
    return this.integrity.recoverFromSnapshot();
  }

  /** 获取当前迁移状态 */
  getMigrationStatus(): MigrationStatusRecord | null {
    return this.integrity.getMigrationStatus();
  }

  /** 清除迁移状态 */
  clearMigrationStatus(): void {
    this.integrity.clearMigrationStatus();
  }

  /** 检查是否有未完成的迁移 */
  hasUnfinishedMigration(): boolean {
    return this.integrity.hasUnfinishedMigration();
  }

  /** 数据完整性检查 */
  validateDataIntegrity(projects: Project[]): IntegrityCheckResult {
    return this.integrity.validateDataIntegrity(projects);
  }

  /** 验证迁移后数据一致性 */
  async verifyMigrationSuccess(
    localProjects: Project[],
    userId: string
  ): Promise<{ success: boolean; missingItems: string[] }> {
    return this.integrity.verifyMigrationSuccess(localProjects, userId);
  }
}
