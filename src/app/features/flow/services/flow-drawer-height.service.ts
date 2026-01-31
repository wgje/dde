import { Injectable, inject } from '@angular/core';
import { UiStateService } from '../../../../services/ui-state.service';

/**
 * 抽屉高度计算结果
 */
export interface DrawerHeightResult {
  targetVh: number;
  preset: 'none' | 'direct' | 'reenter';
}

/**
 * FlowDrawerHeightService - 移动端抽屉高度计算服务
 * 
 * 职责：
 * - 根据场景计算最佳抽屉高度（vh）
 * - 基于调色板高度作为参考系进行自适应计算
 * 
 * 场景说明：
 * - 场景一（direct）：直接点击任务块展开详情 => 较大高度
 * - 场景二（reenter）：从文本视图切回且详情已开 => 较小高度
 * 
 * 从 FlowViewComponent 提取，减少组件复杂度
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDrawerHeightService {
  private readonly uiState = inject(UiStateService);
  
  // 基准屏幕参数
  private readonly REFERENCE_SCREEN_HEIGHT = 667;
  private readonly REFERENCE_PALETTE_HEIGHT_PX = 80;
  private readonly DRAWER_VH_DIRECT_CLICK = 24.88; // 场景一
  private readonly DRAWER_VH_REENTER = 8.62;       // 场景二
  private readonly SMALL_DRAWER_THRESHOLD_VH = 12;
  
  /**
   * 计算场景一的最佳抽屉高度（直接点击任务块）
   */
  calculateDirectClickHeight(paletteHeightPx: number): number {
    if (typeof window === 'undefined' || window.innerHeight <= 0) return 25;
    
    const refDrawerPx = (this.REFERENCE_SCREEN_HEIGHT * this.DRAWER_VH_DIRECT_CLICK) / 100;
    const ratio = refDrawerPx / this.REFERENCE_PALETTE_HEIGHT_PX;
    
    const targetDrawerPx = paletteHeightPx * ratio;
    const targetVh = (targetDrawerPx / window.innerHeight) * 100;
    
    return this.clampVh(targetVh);
  }
  
  /**
   * 计算场景二的最佳抽屉高度（重新进入流程图）
   */
  calculateReenterHeight(paletteHeightPx: number): number {
    if (typeof window === 'undefined' || window.innerHeight <= 0) return 8.62;
    
    const refDrawerPx = (this.REFERENCE_SCREEN_HEIGHT * this.DRAWER_VH_REENTER) / 100;
    const ratio = refDrawerPx / this.REFERENCE_PALETTE_HEIGHT_PX;
    
    const targetDrawerPx = paletteHeightPx * ratio;
    const targetVh = (targetDrawerPx / window.innerHeight) * 100;
    
    return this.clampVh(targetVh);
  }
  
  /**
   * 根据场景计算最佳高度
   */
  calculateOptimalHeight(
    paletteHeightPx: number,
    isScenarioTwo: boolean
  ): DrawerHeightResult {
    const targetVh = isScenarioTwo 
      ? this.calculateReenterHeight(paletteHeightPx)
      : this.calculateDirectClickHeight(paletteHeightPx);
    
    return {
      targetVh,
      preset: isScenarioTwo ? 'reenter' : 'direct'
    };
  }
  
  /**
   * 判断当前高度是否属于"小抽屉"（需要自动扩展）
   */
  isSmallDrawer(currentVh: number): boolean {
    return currentVh < this.SMALL_DRAWER_THRESHOLD_VH;
  }
  
  /**
   * 判断是否需要更新高度（差异足够大）
   */
  shouldUpdateHeight(currentVh: number, targetVh: number): boolean {
    return Math.abs(currentVh - targetVh) > 0.2;
  }
  
  /**
   * 限制高度在合理范围内
   */
  private clampVh(vh: number): number {
    return Math.max(5, Math.min(vh, 70));
  }
}
