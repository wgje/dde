import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { UiStateService } from '../../../../services/ui-state.service';

/**
 * 滑动手势状态
 */
interface SwipeState {
  startX: number;
  startY: number;
  startTime: number;
  isSwiping: boolean;
  isVerticalScroll: boolean;
}

/**
 * 滑动结果
 */
export type SwipeResult = 'left' | 'right' | 'none' | 'close-panel';

/**
 * FlowSwipeGestureService - 滑动手势处理服务
 * 
 * 职责：
 * - 右侧面板滑动关闭
 * - 流程图区域左右滑动切换视图
 * 
 * 从 FlowViewComponent 提取，减少组件复杂度
 */
@Injectable({
  providedIn: 'root'
})
export class FlowSwipeGestureService {
  private readonly logger = inject(LoggerService).category('FlowSwipeGesture');
  private readonly uiState = inject(UiStateService);
  
  // ========== 右侧面板滑动状态 ==========
  private rightPanelSwipeState = {
    startX: 0,
    startY: 0,
    isSwiping: false
  };
  
  // ========== 流程图区域滑动状态 ==========
  private diagramAreaSwipeState: SwipeState = {
    startX: 0,
    startY: 0,
    startTime: 0,
    isSwiping: false,
    isVerticalScroll: false
  };
  
  // ========== 右侧面板手势 ==========
  
  handleRightPanelTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    this.rightPanelSwipeState = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      isSwiping: false
    };
  }
  
  handleRightPanelTouchMove(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const deltaX = e.touches[0].clientX - this.rightPanelSwipeState.startX;
    const deltaY = Math.abs(e.touches[0].clientY - this.rightPanelSwipeState.startY);
    
    if (deltaX > 30 && deltaX > deltaY * 1.5) {
      this.rightPanelSwipeState.isSwiping = true;
    }
  }
  
  handleRightPanelTouchEnd(e: TouchEvent): SwipeResult {
    if (!this.rightPanelSwipeState.isSwiping) return 'none';
    
    const deltaX = e.changedTouches[0].clientX - this.rightPanelSwipeState.startX;
    this.rightPanelSwipeState.isSwiping = false;
    
    if (deltaX > 50) {
      return 'close-panel';
    }
    return 'none';
  }
  
  handleBackdropTouchEnd(e: TouchEvent): SwipeResult {
    if (!this.rightPanelSwipeState.isSwiping) {
      this.rightPanelSwipeState.isSwiping = false;
      return 'close-panel'; // 点击背景关闭
    }
    return this.handleRightPanelTouchEnd(e);
  }
  
  isRightPanelSwiping(): boolean {
    return this.rightPanelSwipeState.isSwiping;
  }
  
  // ========== 流程图区域手势 ==========
  
  handleDiagramAreaTouchStart(e: TouchEvent): void {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    this.diagramAreaSwipeState = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      isSwiping: false,
      isVerticalScroll: false
    };
  }
  
  handleDiagramAreaTouchMove(e: TouchEvent): void {
    if (!this.uiState.isMobile()) return;
    if (e.touches.length !== 1) return;
    if (this.diagramAreaSwipeState.isVerticalScroll) return;
    
    const touch = e.touches[0];
    const deltaX = touch.clientX - this.diagramAreaSwipeState.startX;
    const deltaY = touch.clientY - this.diagramAreaSwipeState.startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);
    
    if (!this.diagramAreaSwipeState.isSwiping && !this.diagramAreaSwipeState.isVerticalScroll) {
      if (absDeltaX < 15 && absDeltaY < 15) return;
      
      if (absDeltaX > absDeltaY * 1.5 && absDeltaX > 20) {
        this.diagramAreaSwipeState.isSwiping = true;
      } else if (absDeltaY > absDeltaX) {
        this.diagramAreaSwipeState.isVerticalScroll = true;
      }
    }
  }
  
  handleDiagramAreaTouchEnd(e: TouchEvent): SwipeResult {
    if (!this.uiState.isMobile()) return 'none';
    
    if (this.diagramAreaSwipeState.isVerticalScroll || !this.diagramAreaSwipeState.isSwiping) {
      return 'none';
    }
    
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - this.diagramAreaSwipeState.startX;
    const deltaTime = Date.now() - this.diagramAreaSwipeState.startTime;
    
    const threshold = deltaTime < 300 ? 40 : 60;
    
    // 重置状态
    this.diagramAreaSwipeState.isSwiping = false;
    this.diagramAreaSwipeState.isVerticalScroll = false;
    
    if (deltaX > threshold) {
      return 'right'; // 向右滑动 → 打开任务列表
    } else if (deltaX < -threshold) {
      return 'left'; // 向左滑动 → 切换到文本视图
    }
    
    return 'none';
  }
}
