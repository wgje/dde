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
import { UiStateService } from './ui-state.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { UserSessionService } from './user-session.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';

@Injectable({
  providedIn: 'root'
})
export class ConnectionAdapterService {
  private readonly taskOps = inject(TaskOperationService);
  private readonly uiState = inject(UiStateService);
  private readonly toastService = inject(ToastService);
  private readonly userSession = inject(UserSessionService);
  private readonly recorder = inject(TaskRecordTrackingService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConnectionAdapter');

  private blockHintOnlyMutation(actionLabel: string): boolean {
    if (!(this.userSession.isHintOnlyStartupPlaceholderVisible?.() ?? false)) {
      return false;
    }

    this.toastService.info('会话确认中', `${actionLabel}暂不可用，owner 确认完成前保持只读`);
    return true;
  }

  // ========== 连接操作 ==========
  
  /**
   * 添加跨树连接
   */
  async addCrossTreeConnection(sourceId: string, targetId: string): Promise<boolean> {
    if (this.blockHintOnlyMutation('编辑关联')) {
      return false;
    }

    const saved = await this.taskOps.addCrossTreeConnectionDurably(sourceId, targetId);
    if (!saved) {
      this.logger.warn('添加连接本地持久化失败，未显示成功反馈', { sourceId, targetId });
      return false;
    }
    
    const isMobile = this.uiState.isMobile();
    
    this.toastService.success(
      '已添加关联',
      undefined,
      isMobile ? {
        duration: 5000,
        action: {
          label: '撤销',
          pendingLabel: '撤销中...',
          onClick: async () => {
            this.logger.info('用户撤回添加连接操作', { sourceId, targetId });
            await this.performUndo();
          }
        }
      } : { duration: 3000 }
    );
    return true;
  }
  
  /**
   * 删除连接
   */
  async removeConnection(sourceId: string, targetId: string): Promise<boolean> {
    if (this.blockHintOnlyMutation('编辑关联')) {
      return false;
    }

    const saved = await this.taskOps.removeConnectionDurably(sourceId, targetId);
    if (!saved) {
      this.logger.warn('删除连接本地持久化失败，未显示成功反馈', { sourceId, targetId });
      return false;
    }
    
    const isMobile = this.uiState.isMobile();
    
    this.toastService.success(
      '已删除关联',
      undefined,
      isMobile ? {
        duration: 5000,
        action: {
          label: '撤销',
          pendingLabel: '撤销中...',
          onClick: async () => {
            this.logger.info('用户撤回删除连接操作', { sourceId, targetId });
            await this.performUndo();
          }
        }
      } : { duration: 3000 }
    );
    return true;
  }
  
  /**
   * 重连跨树连接（原子操作）
   * 在一个撤销单元内删除旧连接并创建新连接
   */
  async relinkCrossTreeConnection(
    oldSourceId: string,
    oldTargetId: string,
    newSourceId: string,
    newTargetId: string
  ): Promise<boolean> {
    if (this.blockHintOnlyMutation('编辑关联')) {
      return false;
    }

    const saved = await this.taskOps.relinkCrossTreeConnectionDurably(oldSourceId, oldTargetId, newSourceId, newTargetId);
    if (!saved) {
      this.logger.warn('重连连接本地持久化失败，未显示成功反馈', { oldSourceId, oldTargetId, newSourceId, newTargetId });
      return false;
    }
    
    const isMobile = this.uiState.isMobile();
    
    this.toastService.success(
      '已重连关联',
      undefined,
      isMobile ? {
        duration: 5000,
        action: {
          label: '撤销',
          pendingLabel: '撤销中...',
          onClick: async () => {
            this.logger.info('用户撤回重连操作', { oldSourceId, oldTargetId, newSourceId, newTargetId });
            await this.performUndo();
          }
        }
      } : { duration: 3000 }
    );
    return true;
  }
  
  /**
   * 更新连接内容（标题和描述）
   */
  async updateConnectionContent(sourceId: string, targetId: string, title: string, description: string): Promise<boolean> {
    if (this.blockHintOnlyMutation('编辑关联')) {
      return false;
    }

    const saved = await this.taskOps.updateConnectionContentDurably(sourceId, targetId, title, description);
    if (!saved) {
      this.logger.warn('更新连接内容本地持久化失败，未标记编辑态', { sourceId, targetId });
      return false;
    }

    this.uiState.markEditing();
    return true;
  }

  // ========== 私有方法 ==========
  
  /**
   * 执行撤销操作（内部方法，用于 Toast 回调）
   */
  private performUndo(): Promise<boolean> {
    return this.recorder.performUndo();
  }
}
