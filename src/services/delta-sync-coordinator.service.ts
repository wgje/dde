/**
 * DeltaSyncCoordinatorService - Delta Sync 增量同步协调器
 * 
 * 职责：
 * - Delta Sync 增量同步逻辑
 * - 项目内容差异检测
 * - LWW 冲突合并
 * 
 * 从 SyncCoordinatorService 提取，作为 Sprint 9 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { SimpleSyncService } from '../core-bridge';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';
import { SYNC_CONFIG } from '../config';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
@Injectable({
  providedIn: 'root'
})
export class DeltaSyncCoordinatorService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly syncService = inject(SimpleSyncService);
  private readonly conflictService = inject(ConflictResolutionService);
  private readonly projectState = inject(ProjectStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('DeltaSyncCoordinator');

  /**
   * Delta Sync 增量同步
   * 
   * 【核心优化】从 MB 级全量拉取降至 ~1 KB 增量检查
   */
  async performDeltaSync(projectId: string): Promise<{ taskChanges: number; connectionChanges: number }> {
    if (!SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      return { taskChanges: 0, connectionChanges: 0 };
    }

    this.logger.debug('开始 Delta Sync 增量同步', { projectId });

    try {
      const { tasks, connections } = await this.syncService.checkForDrift(projectId);
      
      if (tasks.length === 0 && connections.length === 0) {
        this.logger.debug('Delta Sync 无变更', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      const currentProject = this.projectState.projects().find(p => p.id === projectId);
      if (!currentProject) {
        this.logger.warn('Delta Sync 项目不存在', { projectId });
        return { taskChanges: 0, connectionChanges: 0 };
      }

      // 合并任务增量
      const mergedTasks = this.mergeTasksDelta(currentProject.tasks, tasks, projectId);
      
      // 合并连接增量
      const mergedConnections = this.mergeConnectionsDelta(
        currentProject.connections ?? [], 
        connections,
        projectId
      );

      // 更新 ProjectStateService
      const projectUpdatedAt = this.pickLatestTimestamp(
        currentProject.updatedAt,
        tasks.map(t => t.updatedAt).filter((v): v is string => !!v),
        connections.map(c => c.updatedAt).filter((v): v is string => !!v)
      );
      this.projectState.updateProjects(ps => ps.map(p => {
        if (p.id === projectId) {
          return {
            ...p,
            tasks: mergedTasks,
            connections: mergedConnections,
            updatedAt: projectUpdatedAt
          };
        }
        return p;
      }));

      this.logger.info('Delta Sync 完成', {
        projectId,
        taskChanges: tasks.length,
        connectionChanges: connections.length
      });

      return { taskChanges: tasks.length, connectionChanges: connections.length };
    } catch (error) {
      this.logger.error('Delta Sync 失败', { projectId, error });
      this.sentryLazyLoader.captureException(error, {
        tags: { operation: 'performDeltaSync' },
        extra: { projectId }
      });
      return { taskChanges: 0, connectionChanges: 0 };
    }
  }

  /**
   * 合并任务增量
   */
  private mergeTasksDelta(
    existingTasks: Task[], 
    deltaTasks: Task[], 
    projectId: string
  ): Task[] {
    const taskMap = new Map(existingTasks.map(t => [t.id, t]));
    
    for (const deltaTask of deltaTasks) {
      const existing = taskMap.get(deltaTask.id);
      const deltaTime = deltaTask.updatedAt ? new Date(deltaTask.updatedAt).getTime() : 0;
      const existingTime = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : 0;

      // NaN 保护：malformed ISO 字符串会导致 getTime() 返回 NaN
      if (Number.isNaN(deltaTime) || Number.isNaN(existingTime)) {
        this.logger.warn('Delta Sync: 检测到无效时间戳，跳过合并', {
          taskId: deltaTask.id,
          deltaUpdatedAt: deltaTask.updatedAt,
          existingUpdatedAt: existing?.updatedAt
        });
        continue;
      }

      if (!existing || deltaTime > existingTime) {
        if (deltaTask.deletedAt) {
          taskMap.delete(deltaTask.id);
        } else {
          // 保护 content 字段
          let mergedTask = deltaTask;
          if (existing && existing.content && (deltaTask.content === undefined || deltaTask.content === null || deltaTask.content === '')) {
            this.logger.warn('Delta Sync: 检测到远程 content 为空，保留本地内容', {
              taskId: deltaTask.id,
              localContentLength: existing.content.length
            });
            mergedTask = { ...deltaTask, content: existing.content };

            this.sentryLazyLoader.captureMessage('Delta Sync: Content protection triggered', {
              level: 'warning',
              tags: { operation: 'performDeltaSync', taskId: deltaTask.id },
              extra: { localContentLength: existing.content.length, projectId }
            });
          }
          taskMap.set(deltaTask.id, mergedTask);
        }
      }
    }
    
    return Array.from(taskMap.values());
  }

  /**
   * 合并连接增量
   */
  private mergeConnectionsDelta(
    existingConnections: Connection[],
    deltaConnections: Connection[],
    _projectId: string
  ): Connection[] {
    const connMap = new Map(existingConnections.map(c => [c.id, c]));
    
    for (const deltaConn of deltaConnections) {
      const existing = connMap.get(deltaConn.id);
      const existingTime = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const deltaTime = deltaConn.updatedAt ? new Date(deltaConn.updatedAt).getTime() : 0;

      // NaN 保护
      if (Number.isNaN(deltaTime) || Number.isNaN(existingTime)) {
        this.logger.warn('Delta Sync: 连接时间戳无效，跳过合并', {
          connectionId: deltaConn.id,
          deltaUpdatedAt: deltaConn.updatedAt,
          existingUpdatedAt: existing?.updatedAt
        });
        continue;
      }

      if (existing && deltaTime < existingTime) {
        continue;
      }

      if (deltaConn.deletedAt) {
        connMap.delete(deltaConn.id);
      } else {
        connMap.set(deltaConn.id, deltaConn);
      }
    }
    
    return Array.from(connMap.values());
  }

  /**
   * 检查两个项目是否有内容差异
   */
  hasProjectContentDifference(project1: Project, project2: Project): boolean {
    if (project1.tasks.length !== project2.tasks.length) return true;
    if ((project1.connections?.length ?? 0) !== (project2.connections?.length ?? 0)) return true;
    
    const tasks1Map = new Map(project1.tasks.map(t => [t.id, t]));
    const tasks2Map = new Map(project2.tasks.map(t => [t.id, t]));
    
    for (const id of tasks1Map.keys()) {
      if (!tasks2Map.has(id)) return true;
    }
    
    for (const [id, task1] of tasks1Map) {
      const task2 = tasks2Map.get(id);
      if (!task2) return true;
      if (task1.title !== task2.title || task1.content !== task2.content) return true;
      if (task1.parentId !== task2.parentId || task1.stage !== task2.stage) return true;
    }
    
    return false;
  }

  private pickLatestTimestamp(base: string | undefined, ...timestampGroups: string[][]): string {
    let max = base ? new Date(base).getTime() : 0;
    if (Number.isNaN(max)) max = 0;
    for (const group of timestampGroups) {
      for (const ts of group) {
        const t = new Date(ts).getTime();
        if (!Number.isNaN(t)) {
          max = Math.max(max, t);
        }
      }
    }
    return max > 0 ? new Date(max).toISOString() : new Date().toISOString();
  }
}
