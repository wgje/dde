/**
 * FlowViewCleanupService - 流程图视图清理服务
 * 
 * 从 FlowViewComponent 拆分出来，专注于：
 * - 定时器清理
 * - rAF 清理
 * - 服务销毁协调
 * 
 * 职责单一：统一管理组件的异步资源清理
 */

import { Injectable, inject } from '@angular/core';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowTouchService } from './flow-touch.service';
import { FlowLinkService } from './flow-link.service';
import { FlowDragDropService } from './flow-drag-drop.service';
import { FlowTaskOperationsService } from './flow-task-operations.service';
import { FlowCommandService } from './flow-command.service';
import { flowTemplateEventHandlers } from './flow-template-events';

/**
 * 清理资源接口
 * 组件需要提供这些资源的引用
 */
export interface CleanupResources {
  /** 待清理的定时器列表 */
  pendingTimers: ReturnType<typeof setTimeout>[];
  /** rAF ID */
  pendingRafId: number | null;
  /** 抽屉高度更新 rAF ID */
  pendingDrawerHeightRafId: number | null;
  /** 节点选中重试 rAF ID 列表 */
  pendingRetryRafIds: number[];
  /** Overview 刷新定时器 */
  overviewResizeTimer: ReturnType<typeof setTimeout> | null;
  /** Idle 初始化句柄 */
  idleInitHandle: number | null;
  /** Idle 小地图初始化句柄 */
  idleOverviewInitHandle: number | null;
}

@Injectable({
  providedIn: 'root'
})
export class FlowViewCleanupService {
  private readonly diagram = inject(FlowDiagramService);
  private readonly touch = inject(FlowTouchService);
  private readonly link = inject(FlowLinkService);
  private readonly dragDrop = inject(FlowDragDropService);
  private readonly taskOps = inject(FlowTaskOperationsService);
  private readonly flowCommand = inject(FlowCommandService);

  /**
   * 执行完整清理
   * @param resources 组件持有的异步资源
   * @param uninstallMobileListeners 移除移动端监听器的回调
   */
  performCleanup(
    resources: CleanupResources,
    uninstallMobileListeners: () => void
  ): void {
    // 标记 View 已销毁
    this.flowCommand.markViewDestroyed();

    // 优先卸载 GoJS 监听 + 清理幽灵，避免残留 DOM/引用
    uninstallMobileListeners();
    this.touch.endDiagramNodeDragGhost();

    // 清理所有定时器
    this.clearTimers(resources);

    // 清理所有 rAF
    this.clearAnimationFrames(resources);

    // 清理 idle callbacks
    this.clearIdleCallbacks(resources);

    // 清理服务
    this.disposeServices();

    // 清理 Delete 键事件处理器
    flowTemplateEventHandlers.onDeleteKeyPressed = undefined;
  }

  /**
   * 清理所有待处理的定时器
   */
  private clearTimers(resources: CleanupResources): void {
    resources.pendingTimers.forEach(clearTimeout);
    resources.pendingTimers.length = 0;

    if (resources.overviewResizeTimer !== null) {
      clearTimeout(resources.overviewResizeTimer);
      resources.overviewResizeTimer = null;
    }
  }

  /**
   * 清理所有 rAF
   */
  private clearAnimationFrames(resources: CleanupResources): void {
    if (resources.pendingRafId !== null) {
      cancelAnimationFrame(resources.pendingRafId);
      resources.pendingRafId = null;
    }

    if (resources.pendingDrawerHeightRafId !== null) {
      cancelAnimationFrame(resources.pendingDrawerHeightRafId);
      resources.pendingDrawerHeightRafId = null;
    }

    resources.pendingRetryRafIds.forEach(id => cancelAnimationFrame(id));
    resources.pendingRetryRafIds.length = 0;
  }

  /**
   * 清理 idle callbacks
   */
  private clearIdleCallbacks(resources: CleanupResources): void {
    if (typeof cancelIdleCallback !== 'undefined') {
      if (resources.idleInitHandle !== null) {
        cancelIdleCallback(resources.idleInitHandle);
        resources.idleInitHandle = null;
      }

      if (resources.idleOverviewInitHandle !== null) {
        cancelIdleCallback(resources.idleOverviewInitHandle);
        resources.idleOverviewInitHandle = null;
      }
    }
  }

  /**
   * 销毁相关服务
   */
  private disposeServices(): void {
    this.diagram.dispose();
    this.touch.dispose();
    this.link.dispose();
    this.dragDrop.dispose();
    this.taskOps.dispose();
  }
}
