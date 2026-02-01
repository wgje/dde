import { Injectable, inject, signal, effect, untracked, Injector, WritableSignal } from '@angular/core';
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

/**
 * 🎯 移动端抽屉高度计算服务
 * 
 * 负责计算和管理移动端详情面板的最佳高度：
 * - 场景一（直接点击）：从关闭状态点击任务块展开
 * - 场景二（切回流程图）：从其他视图切回且详情已打开
 * 
 * 基准屏幕：高度 667px；调色板：80px
 * - 场景一抽屉高度：24.88vh
 * - 场景二抽屉高度：8.62vh
 */
@Injectable({ providedIn: 'root' })
export class FlowMobileDrawerService {
  private readonly uiState = inject(UiStateService);

  /** 参考基准 */
  private readonly REFERENCE_SCREEN_HEIGHT = 667;
  private readonly REFERENCE_PALETTE_HEIGHT_PX = 80;
  
  /** 场景预设 (基准屏幕) */
  private readonly DRAWER_VH_DIRECT_CLICK = 24.88;  // 场景一
  private readonly DRAWER_VH_REENTER = 8.62;        // 场景二
  
  /** 小抽屉阈值，低于此值视为需要自动扩展 */
  private readonly SMALL_DRAWER_THRESHOLD_VH = 12;

  /** 当前抽屉预设状态 */
  private lastDrawerPreset: 'none' | 'direct' | 'reenter' = 'none';
  
  /** 是否已初始化（用于区分首次挂载与运行时状态） */
  private isInitialized = false;
  
  /** 上一次详情面板是否打开 */
  private previousIsOpen = false;

  /**
   * 计算直接点击场景的最佳抽屉高度比例
   */
  get directClickRatio(): number {
    const refDrawerPx = (this.REFERENCE_SCREEN_HEIGHT * this.DRAWER_VH_DIRECT_CLICK) / 100;
    return refDrawerPx / this.REFERENCE_PALETTE_HEIGHT_PX; // ≈ 2.074
  }

  /**
   * 计算切回场景的抽屉高度比例
   */
  get reenterRatio(): number {
    const refDrawerPx = (this.REFERENCE_SCREEN_HEIGHT * this.DRAWER_VH_REENTER) / 100;
    return refDrawerPx / this.REFERENCE_PALETTE_HEIGHT_PX; // ≈ 0.719
  }

  /**
   * 根据调色板高度计算目标抽屉 vh
   * @param palettePx 当前调色板像素高度
   * @param scenario 场景类型
   * @returns 计算后的 vh 值（已 clamp 到合理范围）
   */
  calculateDrawerVh(palettePx: number, scenario: 'direct' | 'reenter'): number | null {
    if (typeof window === 'undefined' || window.innerHeight <= 0) {
      return null;
    }
    
    const ratio = scenario === 'direct' ? this.directClickRatio : this.reenterRatio;
    const targetDrawerPx = palettePx * ratio;
    const targetVh = (targetDrawerPx / window.innerHeight) * 100;
    
    // 合理范围保护：避免极端屏幕把抽屉顶满
    return Math.max(5, Math.min(targetVh, 70));
  }

  /**
   * 判断是否应该展开到最佳高度
   * 适用于场景：详情已开启，选中任务变化，当前抽屉较小
   * 
   * @param currentVh 当前抽屉高度
   * @param targetVh 目标抽屉高度
   * @returns 是否应该展开
   */
  shouldExpandDrawer(currentVh: number, targetVh: number): boolean {
    // 仅在"明显偏小"时提升，避免覆盖用户手动调大的高度
    return currentVh < this.SMALL_DRAWER_THRESHOLD_VH && targetVh - currentVh > 0.2;
  }

  /**
   * 判断当前状态是否需要调整抽屉高度（基于详情开关状态变化）
   * 
   * @returns 场景类型或 null（无需调整）
   */
  determineScenario(isDetailOpen: boolean): 'direct' | 'reenter' | null {
    const justOpened = isDetailOpen && !this.previousIsOpen;
    const openedOnMount = !this.isInitialized && isDetailOpen;
    
    // 更新追踪状态
    this.previousIsOpen = isDetailOpen;
    this.isInitialized = true;
    
    // 详情关闭后重置预设
    if (!isDetailOpen) {
      this.lastDrawerPreset = 'none';
      return null;
    }
    
    if (justOpened || openedOnMount) {
      // 场景判定：首次挂载且详情已开 → 场景二；运行中从关到开 → 场景一
      const scenario = openedOnMount ? 'reenter' : 'direct';
      this.lastDrawerPreset = scenario;
      return scenario;
    }
    
    return null;
  }

  /**
   * 检查是否已在直接点击场景高度
   */
  isAtDirectPreset(): boolean {
    return this.lastDrawerPreset === 'direct';
  }

  /**
   * 标记为直接点击场景预设
   */
  markAsDirectPreset(): void {
    this.lastDrawerPreset = 'direct';
  }

  /**
   * 重置手动覆盖状态（详情关闭时调用）
   */
  resetPreset(): void {
    this.lastDrawerPreset = 'none';
  }

  /**
   * 设置移动端抽屉高度相关的 effects
   * 将 effect 逻辑从组件迁移到服务，减少组件代码量
   * 
   * @param injector Angular 注入器
   * @param ctx 组件提供的信号和回调上下文
   */
  setupDrawerEffects(injector: Injector, ctx: DrawerEffectContext): void {
    // 🎯 移动端：基于"调色板高度"为参考系，设置详情抽屉的最佳高度（vh）
    effect(() => {
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const activeView = this.uiState.activeView();

      if (!this.uiState.isMobile() || activeView !== 'flow') {
        // 非移动端或非流程图视图时，仅更新状态追踪
        this.determineScenario(isDetailOpen);
        if (!isDetailOpen) {
          ctx.drawerManualOverride.set(false);
        }
        return;
      }

      const scenario = this.determineScenario(isDetailOpen);
      
      if (scenario && !ctx.drawerManualOverride()) {
        untracked(() => {
          const targetVh = this.calculateDrawerVh(ctx.paletteHeight(), scenario);
          if (targetVh !== null) {
            ctx.scheduleDrawerHeightUpdate(targetVh);
          }
        });
      }
      
      if (!isDetailOpen) {
        ctx.drawerManualOverride.set(false);
      }
    }, { injector });

    // 🎯 场景二之后：当详情已开且点击任务块时，自动切回"场景一"最佳高度
    effect(() => {
      const selectedId = ctx.selectedTaskId();
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const activeView = this.uiState.activeView();

      if (!this.uiState.isMobile() || activeView !== 'flow' || !isDetailOpen || !selectedId) return;
      if (ctx.drawerManualOverride()) return;
      if (this.isAtDirectPreset()) return;

      untracked(() => {
        const targetVh = this.calculateDrawerVh(ctx.paletteHeight(), 'direct');
        if (targetVh !== null) {
          ctx.scheduleDrawerHeightUpdate(targetVh);
          this.markAsDirectPreset();
        }
      });
    }, { injector });

    // 监听拖拽标记，用户一旦开始拖拽则启用手动覆盖
    effect(() => {
      if (ctx.isResizingDrawerSignal()) {
        ctx.drawerManualOverride.set(true);
      }
    }, { injector });
    
    // 🎯 移动端：场景2（小抽屉）后，点击任务块应自动扩展到场景1的最佳位置
    effect(() => {
      const activeView = this.uiState.activeView();
      const isDetailOpen = this.uiState.isFlowDetailOpen();
      const selectedTaskId = ctx.selectedTaskId();
      const isResizing = ctx.isResizingDrawerSignal();

      if (!this.uiState.isMobile()) return;
      if (activeView !== 'flow' || !isDetailOpen || !selectedTaskId || isResizing) return;
      if (ctx.drawerManualOverride()) return;

      untracked(() => {
        const targetVh = this.calculateDrawerVh(ctx.paletteHeight(), 'direct');
        if (targetVh === null) return;
        
        const currentVh = ctx.drawerHeight();
        if (this.shouldExpandDrawer(currentVh, targetVh)) {
          ctx.scheduleDrawerHeightUpdate(targetVh);
        }
      });
    }, { injector });
  }
}
