import { Injectable, inject } from '@angular/core';
import { Project, Connection } from '../models';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';

/**
 * 任务连接服务 - 负责跨树连接的管理
 * 
 * 从 TaskOperationService 提取，专门处理：
 * - 添加连接
 * - 重连连接
 * - 删除连接（软删除）
 * - 更新连接内容
 */
@Injectable({ providedIn: 'root' })
export class TaskConnectionService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskConnection');
  private readonly projectState = inject(ProjectStateService);
  private readonly recorder = inject(TaskRecordTrackingService);

  // ========== 公共 API ==========

  /**
   * 获取任务的连接（包括入度和出度）
   */
  getTaskConnections(project: Project | null, taskId: string): { 
    incoming: Connection[]; 
    outgoing: Connection[];
  } {
    if (!project) return { incoming: [], outgoing: [] };
    
    const activeConnections = project.connections.filter(c => !c.deletedAt);
    return {
      incoming: activeConnections.filter(c => c.target === taskId),
      outgoing: activeConnections.filter(c => c.source === taskId)
    };
  }

  /**
   * 添加跨树连接
   * 如果连接已存在（被软删除），则恢复它
   */
  addCrossTreeConnection(sourceId: string, targetId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    
    // 检查是否存在相同的连接（包括软删除的）
    const existingConn = activeP.connections.find(
      c => c.source === sourceId && c.target === targetId
    );
    
    // 如果存在且未删除，跳过
    if (existingConn && !existingConn.deletedAt) return;
    
    // 如果存在但被软删除，恢复它
    if (existingConn && existingConn.deletedAt) {
      this.recordAndUpdate(p => ({
        ...p,
        connections: p.connections.map(c => 
          (c.source === sourceId && c.target === targetId)
            ? { ...c, deletedAt: undefined }
            : c
        )
      }));
      return;
    }
    
    const sourceTask = this.projectState.getTask(sourceId);
    const targetTask = this.projectState.getTask(targetId);
    if (!sourceTask || !targetTask) return;
    
    if (sourceId === targetId) return;
    
    this.recordAndUpdate(p => ({
      ...p,
      connections: [...p.connections, { 
        id: crypto.randomUUID(),
        source: sourceId, 
        target: targetId 
      }]
    }));
  }

  /**
   * 重连跨树连接（原子操作）
   * 在一个撤销单元内删除旧连接并创建新连接
   * 
   * @param oldSourceId 原始起点节点 ID
   * @param oldTargetId 原始终点节点 ID
   * @param newSourceId 新的起点节点 ID
   * @param newTargetId 新的终点节点 ID
   */
  relinkCrossTreeConnection(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => {
      // 【P2-43 修复】检查是否已存在相同 source→target 的活跃连接
      const duplicateExists = p.connections.some(
        c => c.source === newSourceId && c.target === newTargetId && !c.deletedAt
      );
      
      const updatedConnections = p.connections.map(c => 
        (c.source === oldSourceId && c.target === oldTargetId)
          ? { ...c, deletedAt: now }
          : c
      );
      
      // 仅在无重复时添加新连接
      if (!duplicateExists) {
        updatedConnections.push({
          id: crypto.randomUUID(),
          source: newSourceId,
          target: newTargetId,
          updatedAt: now,
        });
      }
      
      return { ...p, connections: updatedConnections };
    });
  }

  /**
   * 移除连接（使用软删除策略）
   * 设置 deletedAt 时间戳，让同步服务可以正确同步删除状态到其他设备
   */
  removeConnection(sourceId: string, targetId: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdate(p => ({
      ...p,
      connections: p.connections.map(c => 
        (c.source === sourceId && c.target === targetId)
          ? { ...c, deletedAt: now }
          : c
      )
    }));
  }

  /**
   * 更新连接内容（标题和描述）
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string): void {
    this.recordAndUpdateDebounced(p => ({
      ...p,
      connections: p.connections.map(c => 
        (c.source === sourceId && c.target === targetId) 
          ? { ...c, title, description } 
          : c
      )
    }));
  }

  // ========== 私有辅助方法 ==========

  private getActiveProject(): Project | null {
    return this.projectState.activeProject();
  }

  private recordAndUpdate(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdate(mutator);
  }

  private recordAndUpdateDebounced(mutator: (project: Project) => Project): void {
    this.recorder.recordAndUpdateDebounced(mutator);
  }
}
