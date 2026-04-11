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

  private pickNewestDeletedConnection(connections: Connection[], sourceId: string, targetId: string): Connection | undefined {
    const deletedConnections = connections.filter(
      connection => connection.source === sourceId && connection.target === targetId && !!connection.deletedAt
    );

    if (deletedConnections.length === 0) {
      return undefined;
    }

    const toTimestamp = (value?: string | null): number => {
      if (!value) return 0;
      const timestamp = new Date(value).getTime();
      return Number.isNaN(timestamp) ? 0 : timestamp;
    };

    return deletedConnections.reduce((latest, current) => {
      const latestTimestamp = Math.max(toTimestamp(latest.updatedAt), toTimestamp(latest.deletedAt));
      const currentTimestamp = Math.max(toTimestamp(current.updatedAt), toTimestamp(current.deletedAt));
      return currentTimestamp >= latestTimestamp ? current : latest;
    });
  }

  private hasValidConnectionEndpoints(project: Project, sourceId: string, targetId: string): boolean {
    if (sourceId === targetId) {
      return false;
    }

    const sourceTask = this.projectState.getTask(sourceId);
    const targetTask = this.projectState.getTask(targetId);

    return !!sourceTask && !sourceTask.deletedAt && !!targetTask && !targetTask.deletedAt;
  }

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
   * 如果存在已删除历史，则保留历史并创建新的活跃连接，避免复用已 tombstone 的旧 id
   */
  addCrossTreeConnection(sourceId: string, targetId: string): void {
    const activeP = this.getActiveProject();
    if (!activeP) return;
    if (!this.hasValidConnectionEndpoints(activeP, sourceId, targetId)) return;
    const now = new Date().toISOString();
    
    const activeConnection = activeP.connections.find(
      c => c.source === sourceId && c.target === targetId && !c.deletedAt
    );
    
    // 如果存在且未删除，跳过
    if (activeConnection) return;

    this.recordAndUpdate(p => ({
      ...p,
      connections: [...p.connections, { 
        id: crypto.randomUUID(),
        source: sourceId, 
        target: targetId,
        updatedAt: now,
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
    if (oldSourceId === newSourceId && oldTargetId === newTargetId) {
      return;
    }

    const now = new Date().toISOString();
    this.recordAndUpdate(p => {
      if (!this.hasValidConnectionEndpoints(p, newSourceId, newTargetId)) {
        return p;
      }

      const oldActiveConnection = p.connections.find(
        c => c.source === oldSourceId && c.target === oldTargetId && !c.deletedAt
      );
      const activeTargetConnection = p.connections.find(
        c => c.source === newSourceId && c.target === newTargetId && !c.deletedAt
      );
      const duplicateExists = !!activeTargetConnection;

      if (!oldActiveConnection) {
        return p;
      }
      
      const updatedConnections = p.connections.map(c => 
        (c.id === oldActiveConnection.id)
          ? { ...c, deletedAt: now, updatedAt: now }
          : c
      );
      
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
    this.recordAndUpdate(p => {
      const activeConnection = p.connections.find(
        c => c.source === sourceId && c.target === targetId && !c.deletedAt
      );

      if (!activeConnection) {
        return p;
      }

      return {
        ...p,
        connections: p.connections.map(c => 
          (c.id === activeConnection.id)
            ? { ...c, deletedAt: now, updatedAt: now }
            : c
        )
      };
    });
  }

  /**
   * 更新连接内容（标题和描述）
   */
  updateConnectionContent(sourceId: string, targetId: string, title: string, description: string): void {
    const now = new Date().toISOString();
    this.recordAndUpdateDebounced(p => {
      const activeConnection = p.connections.find(
        c => c.source === sourceId && c.target === targetId && !c.deletedAt
      );

      if (!activeConnection) {
        return p;
      }

      return {
        ...p,
        connections: p.connections.map(c => 
          (c.id === activeConnection.id) 
            ? { ...c, title, description, updatedAt: now } 
            : c
        )
      };
    });
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
