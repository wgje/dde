/**
 * ConnectionAdapterService - 连接操作适配器
 * 
 * 从 TaskOperationAdapterService 拆分出来，专注于连接相关操作：
 * - 添加跨树连接
 * - 删除连接
 * - 重连连接
 * - 更新连接内容
 * 
 * 职责：
 * - 桥接 TaskOperationService 的连接方法
 * - 提供 Toast 反馈
 * - 触发撤销操作
 */
import { Injectable, inject } from '@angular/core';
import { TaskOperationService } from './task-operation.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project } from '../models';
import { LayoutService } from './layout.service';

@Injectable({
  providedIn: 'root'
})
export class ConnectionAdapterService {
  private readonly taskOps = inject(TaskOperationService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly undoService = inject(UndoService);
  private readonly uiState = inject(UiStateService);
  private readonly projectState = inject(ProjectStateService);
  private readonly layoutService = inject(LayoutService);
  private readonly toastService = inject(ToastService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectionAdapter');

  // ========== 连接操作 ==========
  
  /**
   * 添加跨树连接
   */
  addCrossTreeConnection(sourceId: string, targetId: string): void {
    this.taskOps.addCrossTreeConnection(sourceId, targetId);
    
    const isMobile = this.uiState.isMobile();
    
    this.toastService.success(
      '已添加关联',
      undefined,
      isMobile ? {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回添加连接操作', { sourceId, targetId });
            this.performUndo();
          }
        }
      } : { duration: 3000 }
    );
  }
  
  /**
   * 删除连接
   */
  removeConnection(sourceId: string, targetId: string): void {
    this.taskOps.removeConnection(sourceId, targetId);
    
    const isMobile = this.uiState.isMobile();
    
    this.toastService.success(
      '已删除关联',
      undefined,
      isMobile ? {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回删除连接操作', { sourceId, targetId });
            this.performUndo();
          }
        }
      } : { duration: 3000 }
    );
  }
  
  /**
   * 重连跨树连接（原子操作）
   * 在一个撤销单元内删除旧连接并创建新连接
   */
  relinkCrossTreeConnection(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): void {
    this.taskOps.relinkCrossTreeConnection(oldSourceId, oldTargetId, newSourceId, newTargetId);
    
    const isMobile = this.uiState.isMobile();
    
    this.toastService.success(
      '已重连关联',
      undefined,
      isMobile ? {
        duration: 5000,
        action: {
          label: '撤销',
          onClick: () => {
            this.logger.info('用户撤回重连操作', { oldSourceId, oldTargetId, newSourceId, newTargetId });
            this.performUndo();
          }
        }
      } : { duration: 3000 }
    );
  }
  
  /**
   * 更新连接内容（标题和描述）
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string): void {
    this.uiState.markEditing();
    this.taskOps.updateConnectionContent(sourceId, targetId, title, description);
  }

  // ========== 私有方法 ==========
  
  /**
   * 执行撤销操作（内部方法，用于 Toast 回调）
   */
  private performUndo(): void {
    const activeProject = this.projectState.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.undo(currentVersion);
    
    if (!result) {
      this.logger.warn('没有可撤销的操作');
      return;
    }
    
    if (result === 'version-mismatch') {
      this.toastService.warning('撤销失败', '远程数据已更新过多，无法撤销。');
      if (activeProject) {
        this.undoService.clearOutdatedHistory(activeProject.id, currentVersion ?? 0);
      }
      return;
    }
    
    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning(
        '撤销注意', 
        `当前内容已被新修改改变 (${result.versionDiff} 个版本)，撤销可能会覆盖最新内容。`
      );
      const action = this.undoService.forceUndo();
      if (action) {
        this.applyProjectSnapshot(action.projectId, action.data.before);
      }
      return;
    }
    
    const action = result;
    this.applyProjectSnapshot(action.projectId, action.data.before);
    this.logger.info('撤销操作成功', { projectId: action.projectId, type: action.type });
  }
  
  /**
   * 应用项目快照（内部方法）
   */
  private applyProjectSnapshot(projectId: string, snapshot: Partial<Project>): void {
    this.projectState.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return this.layoutService.rebalance({
          ...p,
          tasks: snapshot.tasks ?? p.tasks,
          connections: snapshot.connections ?? p.connections
        });
      }
      return p;
    }));
    this.syncCoordinator.markLocalChanges('structure');
    this.syncCoordinator.schedulePersist();
  }
}
