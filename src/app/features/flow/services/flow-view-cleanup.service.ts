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
import { FlowDiagramEffectsService } from './flow-diagram-effects.service';
import { FlowMobileDrawerService } from './flow-mobile-drawer.service';
import { FlowTouchService } from './flow-touch.service';
import { FlowLinkService } from './flow-link.service';
import { FlowDragDropService } from './flow-drag-drop.service';
import { FlowTaskOperationsService } from './flow-task-operations.service';
import { FlowBatchDeleteService } from './flow-batch-delete.service';
import { FlowCommandService } from './flow-command.service';
import { FlowPaletteResizeService } from './flow-palette-resize.service';
import { flowTemplateEventHandlers } from './flow-template-events';

/**
 * 清理资源接口
 * 组件需要提供这些资源的引用
 */
export interface CleanupResources {
  /** 待清理的定时器列表 */
  pendingTimers: ReturnType<typeof setTimeout>[];
  /** 节点选中重试 rAF ID 列表 */
  pendingRetryRafIds: number[];
  /** Overview 刷新定时器 */
  overviewResizeTimer: ReturnType<typeof setTimeout> | null;
  /** Idle 初始化句柄 */
  idleInitHandle: number | null;
}

@Injectable({
  providedIn: 'root'
})
export class FlowViewCleanupService {
  private readonly diagram = inject(FlowDiagramService);
  private readonly diagramEffects = inject(FlowDiagramEffectsService);
  private readonly mobileDrawer = inject(FlowMobileDrawerService);
  private readonly touch = inject(FlowTouchService);
  private readonly link = inject(FlowLinkService);
  private readonly dragDrop = inject(FlowDragDropService);
  private readonly taskOps = inject(FlowTaskOperationsService);
  private readonly batchDelete = inject(FlowBatchDeleteService);
  private readonly flowCommand = inject(FlowCommandService);
  private readonly paletteResize = inject(FlowPaletteResizeService);

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
    this.runCleanupStep(() => this.flowCommand.markViewDestroyed());

    // 优先卸载 GoJS 监听 + 清理幽灵，避免残留 DOM/引用
    this.runCleanupStep(uninstallMobileListeners);
    this.runCleanupStep(() => this.touch.endDiagramNodeDragGhost());

    // 清理所有定时器
    this.runCleanupStep(() => this.clearTimers(resources));

    // 清理所有 rAF
    this.runCleanupStep(() => this.clearAnimationFrames(resources));

    // 清理 idle callbacks
    this.runCleanupStep(() => this.clearIdleCallbacks(resources));

    // 清理服务
    this.runCleanupStep(() => this.disposeServices());

    // 清理 Delete 键事件处理器
    this.runCleanupStep(() => {
      flowTemplateEventHandlers.onDeleteKeyPressed = undefined;
    });
  }

  /**
   * 清理所有待处理的定时器
   */
  private clearTimers(resources: CleanupResources): void {
    const pendingTimers = [...resources.pendingTimers];
    resources.pendingTimers.length = 0;
    pendingTimers.forEach(timer => {
      this.runCleanupStep(() => clearTimeout(timer));
    });

    if (resources.overviewResizeTimer !== null) {
      const overviewResizeTimer = resources.overviewResizeTimer;
      resources.overviewResizeTimer = null;
      this.runCleanupStep(() => clearTimeout(overviewResizeTimer));
    }
  }

  private clearAnimationFrames(resources: CleanupResources): void {
    // rAF 已迁移到各服务
    this.runCleanupStep(() => this.diagramEffects.cancelPendingRaf());
    this.runCleanupStep(() => this.mobileDrawer.cancelPendingDrawerRaf());

    const pendingRetryRafIds = [...resources.pendingRetryRafIds];
    resources.pendingRetryRafIds.length = 0;
    pendingRetryRafIds.forEach(id => {
      this.runCleanupStep(() => cancelAnimationFrame(id));
    });
  }

  private clearIdleCallbacks(resources: CleanupResources): void {
    if (typeof cancelIdleCallback !== 'undefined') {
      if (resources.idleInitHandle !== null) {
        const idleInitHandle = resources.idleInitHandle;
        resources.idleInitHandle = null;
        this.runCleanupStep(() => cancelIdleCallback(idleInitHandle));
      }
    }
    // Overview idle 已迁移到 FlowDiagramService
    this.runCleanupStep(() => this.diagram.cancelIdleOverviewInit());
  }

  /**
   * 销毁相关服务
   */
  private disposeServices(): void {
    this.runCleanupStep(() => this.diagram.dispose());
    this.runCleanupStep(() => this.touch.dispose());
    this.runCleanupStep(() => this.link.dispose());
    this.runCleanupStep(() => this.dragDrop.dispose());
    this.runCleanupStep(() => this.taskOps.dispose());
    this.runCleanupStep(() => this.batchDelete.reset());
    this.runCleanupStep(() => this.paletteResize.cancelActiveResize());
  }

  private runCleanupStep(cleanup: () => void): void {
    try {
      cleanup();
    } catch {
      // Cleanup is best-effort; later resource releases must still run.
    }
  }
}
