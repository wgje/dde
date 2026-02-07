import { Injectable, inject } from '@angular/core';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project } from '../models';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import {
  MIGRATION_SNAPSHOT_CONFIG,
  MigrationStatus,
  MigrationStatusRecord,
  IntegrityCheckResult,
  IntegrityIssue,
} from './migration.types';

/**
 * 迁移数据完整性与快照服务
 *
 * 从 MigrationService 拆分，负责：
 * - 迁移前/后的数据完整性检查
 * - 迁移快照的保存与恢复
 * - 迁移状态跟踪（sessionStorage 持久化）
 * - 迁移成功后的验证
 */
@Injectable({
  providedIn: 'root'
})
export class MigrationIntegrityService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly syncService = inject(SimpleSyncService);
  private readonly toast = inject(ToastService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('MigrationIntegrity');

  private readonly DATA_VERSION = 2;

  // ============================================================
  // 迁移快照管理
  // ============================================================

  /**
   * 【Week 2】保存迁移快照
   *
   * 策略：
   * 1. 先尝试 sessionStorage（会话自动清理）
   * 2. 如果超过 5MB 限制，降级到 localStorage
   * 3. 如果 localStorage 也失败，提示用户手动导出
   *
   * @returns true 如果成功保存，false 如果失败
   */
  saveMigrationSnapshot(projects: Project[]): boolean {
    if (typeof sessionStorage === 'undefined') return false;

    const snapshotData = JSON.stringify({
      projects,
      savedAt: new Date().toISOString(),
      version: this.DATA_VERSION
    });

    const dataSize = new Blob([snapshotData]).size;

    try {
      // 先尝试 sessionStorage
      if (dataSize <= MIGRATION_SNAPSHOT_CONFIG.MAX_SESSION_STORAGE_SIZE) {
        sessionStorage.setItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY, snapshotData);
        this.logger.debug(`快照已保存到 sessionStorage (${(dataSize / 1024).toFixed(2)} KB)`);
        return true;
      }

      // 超过限制，尝试 localStorage（并提示用户）
      this.toast.info(
        '数据量较大',
        `数据大小 ${(dataSize / 1024 / 1024).toFixed(2)} MB，已使用持久化存储保存快照`
      );

      localStorage.setItem(MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY, snapshotData);
      this.logger.debug(`快照已保存到 localStorage (${(dataSize / 1024 / 1024).toFixed(2)} MB)`);
      return true;
    } catch (e) {
      // 存储失败（可能是配额用尽）
      this.logger.error('保存快照失败', { error: e });

      // 尝试提供文件下载作为最后手段
      this.offerSnapshotDownload(projects);
      return false;
    }
  }

  /**
   * 【Week 2】提供快照文件下载
   * 当 sessionStorage 和 localStorage 都失败时的降级方案
   */
  private offerSnapshotDownload(projects: Project[]): void {
    try {
      const snapshotData = JSON.stringify({
        projects,
        savedAt: new Date().toISOString(),
        version: this.DATA_VERSION,
        type: 'migration-snapshot'
      }, null, 2);

      const blob = new Blob([snapshotData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      const link = document.createElement('a');
      link.href = url;
      link.download = `nanoflow-migration-snapshot-${timestamp}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      this.toast.warning(
        '请保存备份文件',
        '由于存储空间不足，已下载迁移快照文件。如迁移失败，可使用此文件恢复数据。'
      );
    } catch (e) {
      this.logger.error('下载快照失败', { error: e });
    }
  }

  /**
   * 【Week 2】清理迁移快照
   */
  clearMigrationSnapshot(): void {
    try {
      sessionStorage.removeItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY);
      localStorage.removeItem(MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY);
    } catch (e) {
      this.logger.warn('清理快照失败', { error: e });
    }
  }

  /**
   * 【Week 2】从快照恢复数据（公开方法，供错误恢复使用）
   */
  recoverFromSnapshot(): Project[] | null {
    try {
      // 先检查 sessionStorage
      const sessionData = sessionStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY);
      if (sessionData) {
        const parsed = JSON.parse(sessionData);
        this.logger.debug('从 sessionStorage 恢复快照');
        return parsed.projects || null;
      }

      // 再检查 localStorage
      const localData = localStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY);
      if (localData) {
        const parsed = JSON.parse(localData);
        this.logger.debug('从 localStorage 恢复快照');
        return parsed.projects || null;
      }

      return null;
    } catch (e) {
      this.logger.error('恢复快照失败', { error: e });
      return null;
    }
  }

  // ============================================================
  // 迁移状态跟踪
  // ============================================================

  /**
   * 更新迁移状态（持久化到 sessionStorage）
   */
  updateMigrationStatus(
    status: MigrationStatus,
    partial: Partial<Omit<MigrationStatusRecord, 'status' | 'startedAt' | 'lastUpdatedAt'>> = {}
  ): void {
    try {
      const existing = this.getMigrationStatus();
      const now = new Date().toISOString();

      const record: MigrationStatusRecord = {
        status,
        startedAt: existing?.startedAt || now,
        lastUpdatedAt: now,
        phase: this.statusToPhase(status),
        totalPhases: 5,
        projectsTotal: partial.projectsTotal ?? existing?.projectsTotal ?? 0,
        projectsCompleted: partial.projectsCompleted ?? existing?.projectsCompleted ?? 0,
        projectsFailed: partial.projectsFailed ?? existing?.projectsFailed ?? [],
        error: partial.error ?? existing?.error
      };

      sessionStorage.setItem(
        MIGRATION_SNAPSHOT_CONFIG.STATUS_KEY,
        JSON.stringify(record)
      );

      this.logger.debug('迁移状态更新', { status, phase: record.phase });
    } catch (e) {
      this.logger.warn('无法保存迁移状态', { error: e });
    }
  }

  /**
   * 获取当前迁移状态
   */
  getMigrationStatus(): MigrationStatusRecord | null {
    try {
      const data = sessionStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.STATUS_KEY);
      if (!data) return null;
      return JSON.parse(data) as MigrationStatusRecord;
    } catch (e) {
      // 日志记录但返回 null（语义正确：无法获取状态）
      this.logger.debug('获取迁移状态失败', { error: e });
      return null;
    }
  }

  /**
   * 清除迁移状态
   */
  clearMigrationStatus(): void {
    try {
      sessionStorage.removeItem(MIGRATION_SNAPSHOT_CONFIG.STATUS_KEY);
    } catch (e) {
      // 非关键操作，仅记录日志
      this.logger.debug('清除迁移状态失败', { error: e });
    }
  }

  /**
   * 检查是否有未完成的迁移
   */
  hasUnfinishedMigration(): boolean {
    const status = this.getMigrationStatus();
    if (!status) return false;
    return !['idle', 'completed'].includes(status.status);
  }

  /**
   * 状态转换为阶段号
   */
  private statusToPhase(status: MigrationStatus): number {
    const phaseMap: Record<MigrationStatus, number> = {
      'idle': 0,
      'preparing': 1,
      'validating': 2,
      'uploading': 3,
      'verifying': 4,
      'cleaning': 5,
      'completed': 5,
      'failed': -1,
      'rollback': -1
    };
    return phaseMap[status] ?? 0;
  }

  // ============================================================
  // 数据完整性检查
  // ============================================================

  /**
   * 【v5.9】数据完整性检查
   * 在迁移前验证数据一致性，防止部分数据丢失
   */
  validateDataIntegrity(projects: Project[]): IntegrityCheckResult {
    const issues: IntegrityIssue[] = [];
    let taskCount = 0;
    let connectionCount = 0;
    const allTaskIds = new Set<string>();
    const allProjectIds = new Set<string>();

    for (const project of projects) {
      // 检查项目 ID
      if (!project.id) {
        issues.push({
          type: 'missing-id',
          entityType: 'project',
          message: `项目缺少 ID: ${project.name || '未命名'}`,
          severity: 'error'
        });
        continue;
      }

      // 检查项目 ID 重复
      if (allProjectIds.has(project.id)) {
        issues.push({
          type: 'duplicate-id',
          entityType: 'project',
          entityId: project.id,
          message: `项目 ID 重复: ${project.id}`,
          severity: 'error'
        });
      }
      allProjectIds.add(project.id);

      // 收集任务 ID
      const projectTaskIds = new Set<string>();
      for (const task of project.tasks || []) {
        taskCount++;

        if (!task.id) {
          issues.push({
            type: 'missing-id',
            entityType: 'task',
            message: `任务缺少 ID: ${task.title || '未命名'} (项目: ${project.name})`,
            severity: 'error'
          });
          continue;
        }

        // 检查任务 ID 在项目内重复
        if (projectTaskIds.has(task.id)) {
          issues.push({
            type: 'duplicate-id',
            entityType: 'task',
            entityId: task.id,
            message: `任务 ID 在项目内重复: ${task.id}`,
            severity: 'error'
          });
        }
        projectTaskIds.add(task.id);
        allTaskIds.add(task.id);

        // 检查必要字段
        if (typeof task.stage !== 'number' && task.stage !== null) {
          issues.push({
            type: 'invalid-field',
            entityType: 'task',
            entityId: task.id,
            message: `任务 stage 字段类型无效: ${typeof task.stage}`,
            severity: 'warning'
          });
        }
      }

      // 二次遍历检查孤儿任务
      for (const task of project.tasks || []) {
        if (task.parentId && !projectTaskIds.has(task.parentId)) {
          issues.push({
            type: 'orphan-task',
            entityType: 'task',
            entityId: task.id,
            message: `任务 "${task.title || task.id}" 的父任务不存在: ${task.parentId}`,
            severity: 'warning'
          });
        }
      }

      // 检查连接
      for (const conn of project.connections || []) {
        connectionCount++;

        if (!conn.id) {
          issues.push({
            type: 'missing-id',
            entityType: 'connection',
            message: `连接缺少 ID: ${conn.source} -> ${conn.target}`,
            severity: 'warning'
          });
        }

        // 检查断开的连接
        if (!projectTaskIds.has(conn.source)) {
          issues.push({
            type: 'broken-connection',
            entityType: 'connection',
            entityId: conn.id,
            message: `连接源任务不存在: ${conn.source}`,
            severity: 'warning'
          });
        }
        if (!projectTaskIds.has(conn.target)) {
          issues.push({
            type: 'broken-connection',
            entityType: 'connection',
            entityId: conn.id,
            message: `连接目标任务不存在: ${conn.target}`,
            severity: 'warning'
          });
        }
      }
    }

    // 记录检查结果
    const hasErrors = issues.some(i => i.severity === 'error');
    if (issues.length > 0) {
      this.logger.warn('数据完整性检查发现问题', {
        issueCount: issues.length,
        errorCount: issues.filter(i => i.severity === 'error').length,
        warningCount: issues.filter(i => i.severity === 'warning').length
      });

      if (hasErrors) {
        this.sentryLazyLoader.captureMessage('数据完整性检查发现严重问题', {
          level: 'error',
          tags: { operation: 'validateDataIntegrity' },
          extra: { issues: issues.filter(i => i.severity === 'error') }
        });
      }
    }

    return {
      valid: !hasErrors,
      issues,
      projectCount: projects.length,
      taskCount,
      connectionCount
    };
  }

  // ============================================================
  // 迁移验证
  // ============================================================

  /**
   * 【v5.9】验证迁移后数据一致性
   * 比较本地数据和远程数据，确保没有数据丢失
   */
  async verifyMigrationSuccess(
    localProjects: Project[],
    userId: string
  ): Promise<{ success: boolean; missingItems: string[] }> {
    const missingItems: string[] = [];

    try {
      this.updateMigrationStatus('verifying');

      // 重新从远程获取数据
      const remoteProjects = await this.syncService.loadProjectsFromCloud(userId);
      if (!remoteProjects) {
        return { success: false, missingItems: ['无法验证：远程数据获取失败'] };
      }

      const remoteProjectIds = new Set(remoteProjects.map((p: { id: string }) => p.id));
      const remoteTaskIds = new Map<string, Set<string>>();

      for (const project of remoteProjects) {
        remoteTaskIds.set(project.id, new Set(project.tasks.map((t: { id: string }) => t.id)));
      }

      // 检查每个本地项目是否在远程存在
      for (const localProject of localProjects) {
        if (!remoteProjectIds.has(localProject.id)) {
          missingItems.push(`项目: ${localProject.name || localProject.id}`);
          continue;
        }

        // 检查任务
        const remoteTasks = remoteTaskIds.get(localProject.id);
        if (!remoteTasks) continue;

        for (const task of localProject.tasks || []) {
          if (!remoteTasks.has(task.id)) {
            missingItems.push(`任务: ${task.title || task.id} (项目: ${localProject.name})`);
          }
        }
      }

      if (missingItems.length > 0) {
        this.logger.error('迁移验证失败：存在未同步的数据', { missingItems });
        this.sentryLazyLoader.captureMessage('迁移验证失败', {
          level: 'error',
          tags: { operation: 'verifyMigrationSuccess' },
          extra: { missingItems }
        });
        return { success: false, missingItems };
      }

      this.logger.info('迁移验证成功：所有数据已同步');
      return { success: true, missingItems: [] };
    } catch (e) {
      this.logger.error('迁移验证过程出错', { error: e });
      return { success: false, missingItems: ['验证过程出错'] };
    }
  }
}
