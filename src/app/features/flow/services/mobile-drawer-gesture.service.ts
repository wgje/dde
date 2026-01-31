/**
 * 移动端抽屉手势服务
 * 
 * 处理触摸手势识别、连续高度调节和吸附点逻辑
 * 
 * 核心改进：
 * - 支持连续高度值（而非全开/全关）
 * - 3个吸附点：收起、半开、全开
 * - 内容紧跟把手，无空白间隙
 */

import { Injectable, signal } from '@angular/core';
import { DRAWER_CONFIG } from '../../../../config/drawer.config';

/** 手势状态 */
interface GestureState {
  startY: number;
  startTime: number;
  currentY: number;
  velocity: number;
  startHeight: number;  // 手势开始时的面板高度
  panel: 'top' | 'bottom' | null;
}

@Injectable()
export class MobileDrawerGestureService {
  // 顶部面板当前高度（vh百分比）
  readonly topPanelHeight = signal(DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED);
  
  // 底部面板当前高度（vh百分比）
  readonly bottomPanelHeight = signal(DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED);
  
  // 是否正在拖拽
  readonly isDragging = signal(false);
  
  // 是否正在动画
  readonly isAnimating = signal(false);
  
  // 是否显示手势提示
  readonly showGestureHint = signal(false);
  
  // 顶层是否曾经打开过（用于 @defer 懒加载）
  readonly hasOpenedTop = signal(false);
  
  // 底层是否曾经打开过（用于 @defer 懒加载）
  readonly hasOpenedBottom = signal(false);
  
  // 私有状态
  private gestureState: GestureState | null = null;
  private animationFrameId: number | null = null;
  private hintTimerId: ReturnType<typeof setTimeout> | null = null;
  
  // 视口高度缓存
  private viewportHeight = 0;
  
  /**
   * 初始化服务
   */
  initialize(): void {
    this.viewportHeight = window.innerHeight;
    this.checkAndShowGestureHint();
  }
  
  /**
   * 清理资源
   */
  destroy(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.hintTimerId) {
      clearTimeout(this.hintTimerId);
      this.hintTimerId = null;
    }
  }
  
  /**
   * 检测并显示首次使用提示
   */
  private checkAndShowGestureHint(): void {
    try {
      const shown = localStorage.getItem(DRAWER_CONFIG.GESTURE_HINT_SHOWN_KEY);
      if (!shown) {
        this.showGestureHint.set(true);
        this.hintTimerId = setTimeout(() => {
          this.showGestureHint.set(false);
          localStorage.setItem(DRAWER_CONFIG.GESTURE_HINT_SHOWN_KEY, 'true');
        }, DRAWER_CONFIG.GESTURE_HINT_DURATION);
      }
    } catch {
      // localStorage 不可用时忽略
    }
  }
  
  /**
   * 隐藏手势提示
   */
  dismissGestureHint(): void {
    this.showGestureHint.set(false);
    if (this.hintTimerId) {
      clearTimeout(this.hintTimerId);
      this.hintTimerId = null;
    }
    try {
      localStorage.setItem(DRAWER_CONFIG.GESTURE_HINT_SHOWN_KEY, 'true');
    } catch {
      // 忽略
    }
  }
  
  /**
   * 检测触摸是否在把手区域
   * @param touchY 触摸点Y坐标
   * @returns 'top' | 'bottom' | null
   */
  detectHandleTouch(touchY: number): 'top' | 'bottom' | null {
    this.viewportHeight = window.innerHeight;
    
    const topHeightPx = this.topPanelHeight() * this.viewportHeight / 100;
    const bottomHeightPx = this.bottomPanelHeight() * this.viewportHeight / 100;
    
    // 扩大触摸热区（实际把手仅 20px，但触摸区域扩展到 48px）
    // touchZone 常量定义在配置中，此处使用硬编码值以匹配把手和触摸区域
    
    // 顶部面板把手在面板底部边缘
    // 把手视觉位置：从 (topHeightPx - HANDLE_HEIGHT) 到 topHeightPx
    // 触摸区域：把手上方 10px 到 把手下方 28px
    if (touchY >= topHeightPx - DRAWER_CONFIG.HANDLE_HEIGHT - 10 && touchY <= topHeightPx + 28) {
      return 'top';
    }
    
    // 底部面板把手在其顶部边缘
    const bottomPanelTop = this.viewportHeight - bottomHeightPx;
    // 把手视觉位置：从 bottomPanelTop 到 bottomPanelTop + HANDLE_HEIGHT
    // 触摸区域：把手上方 28px 到 把手下方 10px
    if (touchY >= bottomPanelTop - 28 && touchY <= bottomPanelTop + DRAWER_CONFIG.HANDLE_HEIGHT + 10) {
      return 'bottom';
    }
    
    return null;
  }
  
  /**
   * 处理触摸开始
   * @returns 是否应该捕获此手势
   */
  onTouchStart(event: TouchEvent): boolean {
    if (event.touches.length !== 1) return false;
    
    const touch = event.touches[0];
    const panel = this.detectHandleTouch(touch.clientY);
    
    if (!panel) {
      return false;
    }
    
    const startHeight = panel === 'top' 
      ? this.topPanelHeight() 
      : this.bottomPanelHeight();
    
    this.gestureState = {
      startY: touch.clientY,
      startTime: performance.now(),
      currentY: touch.clientY,
      velocity: 0,
      startHeight,
      panel,
    };
    
    // 隐藏手势提示
    if (this.showGestureHint()) {
      this.dismissGestureHint();
    }
    
    // 标记曾经打开过（用于懒加载）
    if (panel === 'top') {
      this.hasOpenedTop.set(true);
    } else {
      this.hasOpenedBottom.set(true);
    }
    
    return true;
  }
  
  /**
   * 处理触摸移动
   * @returns 是否消费了此事件
   */
  onTouchMove(event: TouchEvent): boolean {
    if (!this.gestureState || event.touches.length !== 1) return false;
    
    const touch = event.touches[0];
    const deltaY = touch.clientY - this.gestureState.startY;
    const absY = Math.abs(deltaY);
    
    // 更新速度
    const prevY = this.gestureState.currentY;
    const now = performance.now();
    const dt = now - this.gestureState.startTime;
    this.gestureState.currentY = touch.clientY;
    this.gestureState.velocity = dt > 0 ? (touch.clientY - prevY) / dt : 0;
    
    // 检查是否超过阈值
    if (absY < DRAWER_CONFIG.DRAG_THRESHOLD && !this.isDragging()) {
      return false;
    }
    
    // 开始拖拽
    if (!this.isDragging()) {
      this.isDragging.set(true);
    }
    
    // 计算新高度
    const panel = this.gestureState.panel;
    const deltaVh = (deltaY / this.viewportHeight) * 100;
    
    if (panel === 'top') {
      // 顶部面板：向下拉增加高度，向上推减少高度
      const newHeight = Math.max(
        DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED,
        Math.min(
          DRAWER_CONFIG.TOP_SNAP_POINTS.EXPANDED + 5, // 允许轻微过冲
          this.gestureState.startHeight + deltaVh
        )
      );
      this.topPanelHeight.set(newHeight);
    } else if (panel === 'bottom') {
      // 底部面板：向上推增加高度，向下拉减少高度
      const newHeight = Math.max(
        DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED,
        Math.min(
          DRAWER_CONFIG.BOTTOM_SNAP_POINTS.EXPANDED + 5,
          this.gestureState.startHeight - deltaVh
        )
      );
      this.bottomPanelHeight.set(newHeight);
    }
    
    event.preventDefault();
    return true;
  }
  
  /**
   * 处理触摸结束 - 自由停靠，不吸附预设点
   */
  onTouchEnd(): void {
    if (!this.gestureState) return;
    
    const panel = this.gestureState.panel;
    
    this.isDragging.set(false);
    
    // 仅确保不低于最小高度
    if (panel === 'top') {
      const currentHeight = this.topPanelHeight();
      if (currentHeight < DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED) {
        this.animateToHeight('top', DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED);
      }
    } else if (panel === 'bottom') {
      const currentHeight = this.bottomPanelHeight();
      if (currentHeight < DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED) {
        this.animateToHeight('bottom', DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED);
      }
    }
    
    this.gestureState = null;
  }
  
  /**
   * 动画到目标高度
   */
  private animateToHeight(panel: 'top' | 'bottom', targetHeight: number): void {
    const currentHeight = panel === 'top' 
      ? this.topPanelHeight() 
      : this.bottomPanelHeight();
    
    if (Math.abs(currentHeight - targetHeight) < 0.5) {
      // 已经在目标位置，直接设置
      if (panel === 'top') {
        this.topPanelHeight.set(targetHeight);
      } else {
        this.bottomPanelHeight.set(targetHeight);
      }
      return;
    }
    
    this.isAnimating.set(true);
    
    this.animateSpring(currentHeight, targetHeight, (value) => {
      if (panel === 'top') {
        this.topPanelHeight.set(value);
      } else {
        this.bottomPanelHeight.set(value);
      }
    }, () => {
      this.isAnimating.set(false);
    });
  }
  
  /**
   * 弹簧动画
   */
  private animateSpring(
    from: number,
    to: number,
    onUpdate: (value: number) => void,
    onComplete: () => void
  ): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    const duration = DRAWER_CONFIG.ANIMATION_DURATION;
    const start = performance.now();
    
    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      
      // cubic-bezier(0.2, 0.8, 0.2, 1) - 快出慢入
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = from + (to - from) * eased;
      
      onUpdate(current);
      
      if (progress < 1) {
        this.animationFrameId = requestAnimationFrame(animate);
      } else {
        this.animationFrameId = null;
        onComplete();
      }
    };
    
    this.animationFrameId = requestAnimationFrame(animate);
  }
  
  // ========== 程序化控制 ==========
  
  /**
   * 展开顶部面板到半开
   */
  openTopDrawer(): void {
    this.hasOpenedTop.set(true);
    this.animateToHeight('top', DRAWER_CONFIG.TOP_SNAP_POINTS.HALF);
  }
  
  /**
   * 展开底部面板到半开
   */
  openBottomDrawer(): void {
    this.hasOpenedBottom.set(true);
    this.animateToHeight('bottom', DRAWER_CONFIG.BOTTOM_SNAP_POINTS.HALF);
  }
  
  /**
   * 收起顶部面板
   */
  collapseTopDrawer(): void {
    this.animateToHeight('top', DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED);
  }
  
  /**
   * 收起底部面板
   */
  collapseBottomDrawer(): void {
    this.animateToHeight('bottom', DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED);
  }
  
  /**
   * 关闭所有抽屉（收起到最小）
   */
  closeDrawer(): void {
    this.collapseTopDrawer();
    this.collapseBottomDrawer();
  }
  
  // ========== 兼容旧 API ==========
  
  /** 获取当前活动层（兼容旧 API） */
  activeLayer(): 'top' | 'middle' | 'bottom' {
    const topHeight = this.topPanelHeight();
    const bottomHeight = this.bottomPanelHeight();
    
    // 判断哪个面板是"打开"状态
    if (topHeight > DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED + 5) {
      return 'top';
    }
    if (bottomHeight > DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED + 5) {
      return 'bottom';
    }
    return 'middle';
  }
  
  /** 拖拽偏移量（兼容旧 API，现在不需要了）*/
  dragOffset(): number {
    return 0;
  }
  
  /** 旧 API 兼容 */
  getTopTranslateY(): number {
    return 0; // 不再使用 transform
  }
  
  getMiddleTranslateY(): number {
    return 0;
  }
  
  getBottomTranslateY(): number {
    return 0;
  }
}
