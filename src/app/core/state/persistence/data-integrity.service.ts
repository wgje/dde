/**
 * DataIntegrityService - 数据完整性验证服务
 * 
 * 职责：
 * - 离线数据完整性验证
 * - 孤立数据清理
 * - 写入完整性校验
 * 
 * 从 StorePersistenceService 提取，作为 Sprint 8 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { IndexedDBService, DB_CONFIG } from './indexeddb.service';
import { Project, Task, Connection } from '../../../../models';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
/**
 * 完整性检查问题
 */
export interface IntegrityIssue {
  type: 'orphaned-task' | 'broken-connection' | 'invalid-data' | 'missing-project';
  entityId: string;
  projectId?: string;
  message: string;
  severity: 'warning' | 'error';
}

/**
 * 完整性检查结果
 */
export interface IntegrityCheckResult {
  valid: boolean;
  issues: IntegrityIssue[];
  stats: {
    projectCount: number;
    taskCount: number;
    connectionCount: number;
    orphanedTasks: number;
    brokenConnections: number;
  };
}

/**
 * 写入校验结果
 */
export interface WriteVerifyResult {
  valid: boolean;
  actual: { tasks: number; connections: number };
  errors: string[];
}

interface OfflineIntegrityData {
  projects: Project[];
  tasks: Array<Task & { projectId?: string }>;
  connections: Array<Connection & { projectId?: string }>;
}

interface OfflineIntegrityStats {
  orphanedTasks: number;
  brokenConnections: number;
}

@Injectable({
  providedIn: 'root'
})
export class DataIntegrityService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('DataIntegrity');
  private readonly indexedDB = inject(IndexedDBService);
  
  /**
   * 验证写入完整性
   */
  async verifyWriteIntegrity(
    db: IDBDatabase,
    projectId: string,
    expectedTaskCount: number,
    expectedConnectionCount: number
  ): Promise<WriteVerifyResult> {
    const errors: string[] = [];
    let actualTaskCount = 0;
    let actualConnectionCount = 0;
    
    try {
      // 读取刚写入的数据
      const savedTasks = await this.indexedDB.getByIndex<Task & { projectId: string }>(
        db, DB_CONFIG.stores.tasks, 'projectId', projectId
      );
      const savedConnections = await this.indexedDB.getByIndex<Connection & { projectId: string }>(
        db, DB_CONFIG.stores.connections, 'projectId', projectId
      );
      
      actualTaskCount = savedTasks.length;
      actualConnectionCount = savedConnections.length;
      
      // 校验任务数量
      if (actualTaskCount !== expectedTaskCount) {
        errors.push(`任务数量不匹配: 预期 ${expectedTaskCount}, 实际 ${actualTaskCount}`);
      }
      
      // 校验连接数量
      if (actualConnectionCount !== expectedConnectionCount) {
        errors.push(`连接数量不匹配: 预期 ${expectedConnectionCount}, 实际 ${actualConnectionCount}`);
      }
      
      return {
        valid: errors.length === 0,
        actual: { tasks: actualTaskCount, connections: actualConnectionCount },
        errors
      };
    } catch (err) {
      this.logger.error('写入完整性校验失败', { projectId, error: err });
      return {
        valid: false,
        actual: { tasks: actualTaskCount, connections: actualConnectionCount },
        errors: [`校验过程出错: ${err instanceof Error ? err.message : String(err)}`]
      };
    }
  }
  
  /**
   * 验证离线数据完整性
   */
  async validateOfflineDataIntegrity(): Promise<IntegrityCheckResult> {
    const issues: IntegrityIssue[] = [];
    const stats: OfflineIntegrityStats = { orphanedTasks: 0, brokenConnections: 0 };
    
    try {
      const data = await this.loadOfflineIntegrityData();
      const projectIds = new Set(data.projects.map(p => p.id));
      const tasksByProject = this.validateOfflineTasks(data.tasks, projectIds, issues, stats);
      this.validateOfflineConnections(data.connections, tasksByProject, issues, stats);
      const hasErrors = issues.some(i => i.severity === 'error');

      this.logOfflineIntegrityResult(data, issues, hasErrors);
      return this.createOfflineIntegrityResult(data, issues, stats, !hasErrors);
    } catch (err) {
      this.logger.error('离线数据完整性检查失败', err);
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'validateOfflineDataIntegrity' } });
      return this.createOfflineIntegrityFailure(err);
    }
  }

  private async loadOfflineIntegrityData(): Promise<OfflineIntegrityData> {
    const db = await this.indexedDB.initDatabase();
    const projects = await this.indexedDB.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
    const tasks = await this.indexedDB.getAllFromStore<Task & { projectId?: string }>(db, DB_CONFIG.stores.tasks);
    const connections = await this.indexedDB.getAllFromStore<Connection & { projectId?: string }>(
      db,
      DB_CONFIG.stores.connections,
    );
    return { projects, tasks, connections };
  }

  private validateOfflineTasks(
    tasks: Array<Task & { projectId?: string }>,
    projectIds: ReadonlySet<string>,
    issues: IntegrityIssue[],
    stats: OfflineIntegrityStats,
  ): Map<string, Set<string>> {
    const tasksByProject = new Map<string, Set<string>>();

    for (const task of tasks) {
      const taskProjectId = task.projectId || '';
      if (!projectIds.has(taskProjectId)) {
        issues.push({
          type: 'orphaned-task',
          entityId: task.id,
          projectId: taskProjectId,
          message: `任务 ${task.id} 属于不存在的项目 ${taskProjectId}`,
          severity: 'warning',
        });
        stats.orphanedTasks++;
      }

      if (!tasksByProject.has(taskProjectId)) {
        tasksByProject.set(taskProjectId, new Set());
      }
      tasksByProject.get(taskProjectId)!.add(task.id);
    }

    return tasksByProject;
  }

  private validateOfflineConnections(
    connections: Array<Connection & { projectId?: string }>,
    tasksByProject: ReadonlyMap<string, ReadonlySet<string>>,
    issues: IntegrityIssue[],
    stats: OfflineIntegrityStats,
  ): void {
    for (const conn of connections) {
      const connProjectId = conn.projectId || '';
      const projectTasks = tasksByProject.get(connProjectId);
      this.validateOfflineConnectionEndpoint(conn, connProjectId, projectTasks, 'source', issues, stats);
      this.validateOfflineConnectionEndpoint(conn, connProjectId, projectTasks, 'target', issues, stats);
    }
  }

  private validateOfflineConnectionEndpoint(
    conn: Connection,
    projectId: string,
    projectTasks: ReadonlySet<string> | undefined,
    endpoint: 'source' | 'target',
    issues: IntegrityIssue[],
    stats: OfflineIntegrityStats,
  ): void {
    const taskId = conn[endpoint];
    if (projectTasks?.has(taskId)) return;

    issues.push({
      type: 'broken-connection',
      entityId: conn.id,
      projectId,
      message: `连接 ${conn.id} 的${endpoint === 'source' ? '源' : '目标'}任务 ${taskId} 不存在`,
      severity: 'warning',
    });
    stats.brokenConnections++;
  }

  private logOfflineIntegrityResult(
    data: OfflineIntegrityData,
    issues: IntegrityIssue[],
    hasErrors: boolean,
  ): void {
    if (issues.length === 0) {
      this.logger.debug('离线数据完整性检查通过', {
        projectCount: data.projects.length,
        taskCount: data.tasks.length,
        connectionCount: data.connections.length,
      });
      return;
    }

    const errorCount = issues.filter(i => i.severity === 'error').length;
    this.logger.warn('离线数据完整性检查发现问题', {
      issueCount: issues.length,
      errorCount,
      warningCount: issues.filter(i => i.severity === 'warning').length,
    });

    if (hasErrors) {
      this.sentryLazyLoader.captureMessage('离线数据完整性检查发现严重问题', {
        level: 'error',
        tags: { operation: 'validateOfflineDataIntegrity' },
        extra: {
          errorCount,
          sampleIssues: issues.slice(0, 5),
        },
      });
    }
  }

  private createOfflineIntegrityResult(
    data: OfflineIntegrityData,
    issues: IntegrityIssue[],
    stats: OfflineIntegrityStats,
    valid: boolean,
  ): IntegrityCheckResult {
    return {
      valid,
      issues,
      stats: {
        projectCount: data.projects.length,
        taskCount: data.tasks.length,
        connectionCount: data.connections.length,
        orphanedTasks: stats.orphanedTasks,
        brokenConnections: stats.brokenConnections,
      },
    };
  }

  private createOfflineIntegrityFailure(err: unknown): IntegrityCheckResult {
    return {
      valid: false,
      issues: [{
        type: 'invalid-data',
        entityId: 'system',
        message: `检查过程出错: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'error',
      }],
      stats: {
        projectCount: 0,
        taskCount: 0,
        connectionCount: 0,
        orphanedTasks: 0,
        brokenConnections: 0,
      },
    };
  }
  
  /**
   * 清理孤立数据
   */
  async cleanupOrphanedData(): Promise<{ removedTasks: number; removedConnections: number }> {
    let removedTasks = 0;
    let removedConnections = 0;
    
    try {
      const db = await this.indexedDB.initDatabase();
      
      // 获取有效项目 ID
      const allProjects = await this.indexedDB.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
      const validProjectIds = new Set(allProjects.map(p => p.id));
      
      // 【P3-08 优化】收集所有待删除 ID，使用批量事务替代逐条删除
      const orphanedTaskIds: string[] = [];
      const orphanedConnIds: string[] = [];

      // 清理孤立任务
      const allTasks = await this.indexedDB.getAllFromStore<Task & { projectId?: string }>(db, DB_CONFIG.stores.tasks);
      for (const task of allTasks) {
        if (task.projectId && !validProjectIds.has(task.projectId)) {
          orphanedTaskIds.push(task.id);
        }
      }
      
      // 清理孤立连接（属于不存在的项目）
      const allConnections = await this.indexedDB.getAllFromStore<Connection & { projectId?: string }>(db, DB_CONFIG.stores.connections);
      for (const conn of allConnections) {
        if (conn.projectId && !validProjectIds.has(conn.projectId)) {
          orphanedConnIds.push(conn.id);
        }
      }
      
      // 【P3-07 修复】清理断裂连接（source 或 target 对应的任务不存在）
      const allTaskIds = new Set(allTasks.map(t => t.id));
      for (const conn of allConnections) {
        // 跳过已被上面标记的孤立连接
        if (conn.projectId && !validProjectIds.has(conn.projectId)) continue;
        if (!allTaskIds.has(conn.source) || !allTaskIds.has(conn.target)) {
          orphanedConnIds.push(conn.id);
        }
      }

      // 批量删除（单事务）
      if (orphanedTaskIds.length > 0) {
        await this.indexedDB.batchDeleteFromStore(db, DB_CONFIG.stores.tasks, orphanedTaskIds);
      }
      if (orphanedConnIds.length > 0) {
        await this.indexedDB.batchDeleteFromStore(db, DB_CONFIG.stores.connections, orphanedConnIds);
      }
      removedTasks = orphanedTaskIds.length;
      removedConnections = orphanedConnIds.length;
      
      if (removedTasks > 0 || removedConnections > 0) {
        this.logger.info('已清理孤立数据', { removedTasks, removedConnections });
      }
      
      return { removedTasks, removedConnections };
    } catch (err) {
      this.logger.error('清理孤立数据失败', err);
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'cleanupOrphanedData' } });
      return { removedTasks, removedConnections };
    }
  }
}
