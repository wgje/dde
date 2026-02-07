/**
 * ActionQueueProcessorsService - Action Queue 处理器服务
 * 
 * 职责：
 * - 注册和管理所有 Action Queue 处理器
 * - 处理项目、任务、用户偏好的同步操作
 * 
 * Sprint 9 技术债务修复：从 SyncCoordinatorService 提取
 */
import { Injectable, inject } from '@angular/core';
import { SimpleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { Project, Task, UserPreferences } from '../models';

@Injectable({
  providedIn: 'root'
})
export class ActionQueueProcessorsService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueueProcessors');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly syncService = inject(SimpleSyncService);
  private readonly projectState = inject(ProjectStateService);
  private readonly authService = inject(AuthService);

  /** 初始化所有处理器 */
  setupProcessors(): void {
    this.setupQueueSyncCoordination();
    this.setupProjectProcessors();
    this.setupTaskProcessors();
    this.setupPreferenceProcessors();
  }

  private setupQueueSyncCoordination(): void {
    this.actionQueue.setQueueProcessCallbacks(
      () => this.syncService.pauseRealtimeUpdates(),
      () => this.syncService.resumeRealtimeUpdates()
    );
  }

  private setupProjectProcessors(): void {
    // 项目更新
    this.actionQueue.registerProcessor('project:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('project:update 失败：用户未登录'); return false; }
      
      const payload = action.payload as { project: Project };
      try {
        const result = await this.syncService.saveProjectSmart(payload.project, userId);
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === payload.project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        if (result.conflict) {
          this.logger.warn('project:update 冲突', { projectId: payload.project.id });
          return true; // 冲突由冲突解决流程处理
        }
        return result.success;
      } catch (error) {
        this.logger.error('project:update 异常', { error, projectId: payload.project.id });
        return false;
      }
    });

    // 项目删除
    this.actionQueue.registerProcessor('project:delete', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('project:delete 失败：用户未登录'); return false; }
      try {
        return await this.syncService.deleteProjectFromCloud(action.entityId, userId);
      } catch (error) {
        this.logger.error('project:delete 异常', { error, projectId: action.entityId });
        return false;
      }
    });

    // 项目创建
    this.actionQueue.registerProcessor('project:create', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('project:create 失败：用户未登录'); return false; }
      
      const payload = action.payload as { project: Project };
      try {
        const result = await this.syncService.saveProjectSmart(payload.project, userId);
        if (result.success && result.newVersion !== undefined) {
          this.projectState.updateProjects(ps => ps.map(p =>
            p.id === payload.project.id ? { ...p, version: result.newVersion } : p
          ));
        }
        return result.success;
      } catch (error) {
        this.logger.error('project:create 异常', { error, projectId: payload.project.id });
        return false;
      }
    });
  }

  private setupTaskProcessors(): void {
    // 任务创建
    this.actionQueue.registerProcessor('task:create', async (action) => {
      const payload = action.payload as { task: Task; projectId: string };
      try {
        return await this.syncService.pushTask(payload.task, payload.projectId, false);
      } catch (error) {
        this.logger.error('task:create 异常', { error, taskId: payload.task.id });
        return false;
      }
    });

    // 任务更新
    this.actionQueue.registerProcessor('task:update', async (action) => {
      const payload = action.payload as { task: Task; projectId: string };
      try {
        return await this.syncService.pushTask(payload.task, payload.projectId, false);
      } catch (error) {
        this.logger.error('task:update 异常', { error, taskId: payload.task.id });
        return false;
      }
    });

    // 任务删除
    this.actionQueue.registerProcessor('task:delete', async (action) => {
      const payload = action.payload as { taskId: string; projectId: string };
      try {
        return await this.syncService.deleteTask(payload.taskId, payload.projectId);
      } catch (error) {
        this.logger.error('task:delete 异常', { error, taskId: payload.taskId });
        return false;
      }
    });
  }

  private setupPreferenceProcessors(): void {
    this.actionQueue.registerProcessor('preference:update', async (action) => {
      const userId = this.authService.currentUserId();
      if (!userId) { this.logger.warn('preference:update 失败：用户未登录'); return false; }
      
      const payload = action.payload as { preferences: Partial<UserPreferences> };
      try {
        return await this.syncService.saveUserPreferences(userId, payload.preferences);
      } catch (error) {
        this.logger.error('preference:update 异常', { error });
        return false;
      }
    });
  }
}
