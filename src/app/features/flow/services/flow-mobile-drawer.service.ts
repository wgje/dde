import { Injectable, inject, effect, Injector, WritableSignal } from '@angular/core';
import { UiStateService } from '../../../../services/ui-state.service';

/**
 * 抽屉效果上下文接口
 * 组件需要提供这些信号和回调
 */
export interface DrawerEffectContext {
  /** 调色板高度信号 */
  paletteHeight: () => number;
  /** 抽屉高度信号 */
  drawerHeight: () => number;
  /** 手动覆盖标志信号 */
  drawerManualOverride: WritableSignal<boolean>;
  /** 是否正在拖拽信号 */
  isResizingDrawerSignal: () => boolean;
  /** 选中任务ID信号 */
  selectedTaskId: () => string | null;
  /** 调度抽屉高度更新回调 */
  scheduleDrawerHeightUpdate: (vh: number) => void;
}

/** 移动端抽屉协调服务（仅保留状态协调与 rAF 合并更新） */
@Injectable({ providedIn: 'root' })
export class FlowMobileDrawerService {
  private readonly uiState = inject(UiStateService);

  /** 抽屉高度更新的 rAF */
  private pendingDrawerHeightRafId: number | null = null;
  private pendingDrawerHeightTarget: number | null = null;

  /**
   * 合并抽屉高度更新，避免短时间内多次触发布局变化
   */
  scheduleDrawerHeightUpdate(drawerHeight: WritableSignal<number>, targetVh: number): void {
    this.pendingDrawerHeightTarget = targetVh;
    if (this.pendingDrawerHeightRafId !== null) return;
    this.pendingDrawerHeightRafId = requestAnimationFrame(() => {
      this.pendingDrawerHeightRafId = null;
      const nextVh = this.pendingDrawerHeightTarget;
      this.pendingDrawerHeightTarget = null;
      if (nextVh === null) return;
      if (Math.abs(drawerHeight() - nextVh) > 0.2) {
        drawerHeight.set(nextVh);
      }
    });
  }

  /** 取消待处理的抽屉高度 rAF */
  cancelPendingDrawerRaf(): void {
    if (this.pendingDrawerHeightRafId !== null) {
      cancelAnimationFrame(this.pendingDrawerHeightRafId);
      this.pendingDrawerHeightRafId = null;
    }
  }

  /**
   * 设置移动端抽屉高度相关的 effects
   * 将 effect 逻辑从组件迁移到服务，减少组件代码量
   * 
   * @param injector Angular 注入器
   * @param ctx 组件提供的信号和回调上下文
   */
  setupDrawerEffects(injector: Injector, ctx: DrawerEffectContext): void {
    // 移动端详情抽屉高度由 FlowTaskDetailComponent 按内容自适应；
    // 这里仅维护开关状态与手动拖拽状态，不再回写固定预设高度。
    effect(() => {
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const activeView = this.uiState.activeView();

      if (!this.uiState.isMobile()) {
        ctx.drawerManualOverride.set(false);
        return;
      }

      // 离开 flow 页面后，清理手动覆盖标记，避免回到流程图时高度无法自动回收。
      if (activeView !== 'flow') {
        ctx.drawerManualOverride.set(false);
        return;
      }
      
      if (!isDetailOpen) {
        ctx.drawerManualOverride.set(false);
      }
    }, { injector });

    // 监听拖拽标记，用户一旦开始拖拽则启用手动覆盖
    effect(() => {
      if (ctx.isResizingDrawerSignal()) {
        ctx.drawerManualOverride.set(true);
      }
    }, { injector });
  }
}
