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
import * as Sentry from '@sentry/angular';

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

@Injectable({
  providedIn: 'root'
})
export class DataIntegrityService {
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
    let orphanedTasks = 0;
    let brokenConnections = 0;
    
    try {
      const db = await this.indexedDB.initDatabase();
      
      // 1. 加载所有数据
      const allProjects = await this.indexedDB.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
      const allTasks = await this.indexedDB.getAllFromStore<Task & { projectId?: string }>(db, DB_CONFIG.stores.tasks);
      const allConnections = await this.indexedDB.getAllFromStore<Connection & { projectId?: string }>(db, DB_CONFIG.stores.connections);
      
      // 2. 构建项目 ID 集合
      const projectIds = new Set(allProjects.map(p => p.id));
      
      // 3. 检查孤立任务
      const tasksByProject = new Map<string, Set<string>>();
      for (const task of allTasks) {
        const taskProjectId = task.projectId || '';
        
        if (!projectIds.has(taskProjectId)) {
          issues.push({
            type: 'orphaned-task',
            entityId: task.id,
            projectId: taskProjectId,
            message: `任务 ${task.id} 属于不存在的项目 ${taskProjectId}`,
            severity: 'warning'
          });
          orphanedTasks++;
        }
        
        // 记录任务
        if (!tasksByProject.has(taskProjectId)) {
          tasksByProject.set(taskProjectId, new Set());
        }
        tasksByProject.get(taskProjectId)!.add(task.id);
      }
      
      // 4. 检查断裂连接
      for (const conn of allConnections) {
        const connProjectId = conn.projectId || '';
        const projectTasks = tasksByProject.get(connProjectId);
        
        if (!projectTasks?.has(conn.source)) {
          issues.push({
            type: 'broken-connection',
            entityId: conn.id,
            projectId: connProjectId,
            message: `连接 ${conn.id} 的源任务 ${conn.source} 不存在`,
            severity: 'warning'
          });
          brokenConnections++;
        }
        
        if (!projectTasks?.has(conn.target)) {
          issues.push({
            type: 'broken-connection',
            entityId: conn.id,
            projectId: connProjectId,
            message: `连接 ${conn.id} 的目标任务 ${conn.target} 不存在`,
            severity: 'warning'
          });
          brokenConnections++;
        }
      }
      
      // 5. 记录结果
      const hasErrors = issues.some(i => i.severity === 'error');
      
      if (issues.length > 0) {
        this.logger.warn('离线数据完整性检查发现问题', {
          issueCount: issues.length,
          errorCount: issues.filter(i => i.severity === 'error').length,
          warningCount: issues.filter(i => i.severity === 'warning').length
        });
        
        if (hasErrors) {
          Sentry.captureMessage('离线数据完整性检查发现严重问题', {
            level: 'error',
            tags: { operation: 'validateOfflineDataIntegrity' },
            extra: { 
              errorCount: issues.filter(i => i.severity === 'error').length,
              sampleIssues: issues.slice(0, 5)
            }
          });
        }
      } else {
        this.logger.debug('离线数据完整性检查通过', {
          projectCount: allProjects.length,
          taskCount: allTasks.length,
          connectionCount: allConnections.length
        });
      }
      
      return {
        valid: !hasErrors,
        issues,
        stats: {
          projectCount: allProjects.length,
          taskCount: allTasks.length,
          connectionCount: allConnections.length,
          orphanedTasks,
          brokenConnections
        }
      };
    } catch (err) {
      this.logger.error('离线数据完整性检查失败', err);
      Sentry.captureException(err, { tags: { operation: 'validateOfflineDataIntegrity' } });
      
      return {
        valid: false,
        issues: [{
          type: 'invalid-data',
          entityId: 'system',
          message: `检查过程出错: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error'
        }],
        stats: {
          projectCount: 0,
          taskCount: 0,
          connectionCount: 0,
          orphanedTasks: 0,
          brokenConnections: 0
        }
      };
    }
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
      
      // 清理孤立任务
      const allTasks = await this.indexedDB.getAllFromStore<Task & { projectId?: string }>(db, DB_CONFIG.stores.tasks);
      for (const task of allTasks) {
        if (task.projectId && !validProjectIds.has(task.projectId)) {
          await this.indexedDB.deleteFromStore(db, DB_CONFIG.stores.tasks, task.id);
          removedTasks++;
        }
      }
      
      // 清理孤立连接
      const allConnections = await this.indexedDB.getAllFromStore<Connection & { projectId?: string }>(db, DB_CONFIG.stores.connections);
      for (const conn of allConnections) {
        if (conn.projectId && !validProjectIds.has(conn.projectId)) {
          await this.indexedDB.deleteFromStore(db, DB_CONFIG.stores.connections, conn.id);
          removedConnections++;
        }
      }
      
      if (removedTasks > 0 || removedConnections > 0) {
        this.logger.info('已清理孤立数据', { removedTasks, removedConnections });
      }
      
      return { removedTasks, removedConnections };
    } catch (err) {
      this.logger.error('清理孤立数据失败', err);
      Sentry.captureException(err, { tags: { operation: 'cleanupOrphanedData' } });
      return { removedTasks, removedConnections };
    }
  }
}
