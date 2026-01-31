/**
 * 移动端双向抽屉容器组件
 * 
 * 连续滑动面板布局（类似 Google Maps 底部面板）：
 * - 顶部面板：内容在上，把手在下
 * - 中间区域：流程图画布
 * - 底部面板：把手在上，内容在下
 * 
 * 核心特性：
 * - 内容紧跟把手，无空白间隙
 * - 可停留在任意高度（吸附到3个预设点）
 * - 明显的拖把图标提示
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  input,
  output,
  OnInit,
  OnDestroy,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MobileDrawerGestureService } from '../services/mobile-drawer-gesture.service';
import { DRAWER_CONFIG, DrawerLayer, DrawerStateChangeEvent } from '../../../../config/drawer.config';

@Component({
  selector: 'app-mobile-drawer-container',
  standalone: true,
  imports: [CommonModule],
  providers: [MobileDrawerGestureService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div 
      class="mobile-drawer-container relative w-full h-full overflow-hidden"
      [class.dragging]="gestureService.isDragging()"
      (touchstart)="onTouchStart($event)"
      (touchmove)="onTouchMove($event)"
      (touchend)="onTouchEnd($event)">
      
      <!-- 顶部面板：从顶部向下延伸，内容在上，把手在下 -->
      @if (enableTopDrawer()) {
        <div 
          class="absolute inset-x-0 top-0 bg-stone-50 dark:bg-stone-900 
                 shadow-lg z-20 flex flex-col will-change-[height]"
          [class.transition-all]="!gestureService.isDragging() && gestureService.isAnimating()"
          [class.duration-200]="!gestureService.isDragging() && gestureService.isAnimating()"
          [style.height.vh]="gestureService.topPanelHeight()">
          
          <!-- 内容区域（flex-1 填充，滚动） -->
          <div class="flex-1 min-h-0 overflow-hidden">
            @defer (when gestureService.hasOpenedTop() || gestureService.topPanelHeight() > collapsedThreshold) {
              <ng-content select="[slot=top]"></ng-content>
            }
          </div>

          <!-- 顶部把手（固定在面板底部） -->
          <div 
            class="drawer-handle shrink-0 h-5 flex items-center justify-center cursor-grab active:cursor-grabbing
                   border-t border-stone-200/30 dark:border-stone-700/30"
            (click)="toggleTopPanel()">
            <!-- 紧凑拖把图标 -->
            <div class="w-10 h-1 bg-stone-400 dark:bg-stone-500 rounded-full opacity-50"></div>
          </div>
        </div>
      }
      
      <!-- 中间层：流程图（填充剩余空间） -->
      <div 
        class="absolute inset-0 z-10"
        [style.top.vh]="gestureService.topPanelHeight()"
        [style.bottom.vh]="gestureService.bottomPanelHeight()">
        <ng-content select="[slot=middle]"></ng-content>
      </div>
      
      <!-- 底部面板：从底部向上延伸，把手在上，内容在下 -->
      @if (enableBottomDrawer()) {
        <div 
          class="absolute inset-x-0 bottom-0 bg-stone-50 dark:bg-stone-900 
                 shadow-lg z-20 flex flex-col will-change-[height]"
          [class.transition-all]="!gestureService.isDragging() && gestureService.isAnimating()"
          [class.duration-200]="!gestureService.isDragging() && gestureService.isAnimating()"
          [style.height.vh]="gestureService.bottomPanelHeight()">
          
          <!-- 顶部把手（固定在面板顶部） -->
          <div 
            class="drawer-handle shrink-0 h-5 flex items-center justify-center cursor-grab active:cursor-grabbing
                   border-t border-stone-200/30 dark:border-stone-700/30"
            (click)="toggleBottomPanel()">
            <!-- 紧凑拖把图标 -->
            <div class="w-10 h-1 bg-stone-400 dark:bg-stone-500 rounded-full opacity-50"></div>
          </div>
          
          <!-- 内容区域（flex-1 填充，滚动） -->
          <div class="flex-1 min-h-0 overflow-hidden">
            @defer (when gestureService.hasOpenedBottom() || gestureService.bottomPanelHeight() > collapsedThreshold) {
              <ng-content select="[slot=bottom]"></ng-content>
            }
          </div>
        </div>
      }
      
      <!-- 首次使用手势提示 -->
      @if (gestureService.showGestureHint()) {
        <div class="absolute inset-x-0 z-50 pointer-events-none flex flex-col items-center"
             [style.top.vh]="gestureService.topPanelHeight()">
          <div class="bg-black/70 text-white text-xs px-3 py-1.5 rounded-full mt-2 animate-bounce">
            ↕ 拖动把手调整面板高度
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    
    .mobile-drawer-container {
      touch-action: pan-x;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: none;
    }
    
    .mobile-drawer-container.dragging {
      touch-action: none;
    }
    
    .transition-all.duration-200 {
      transition-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    .drawer-handle {
      touch-action: none;
    }
  `]
})
export class MobileDrawerContainerComponent implements OnInit, OnDestroy {
  readonly gestureService = inject(MobileDrawerGestureService);
  
  // 配置输入
  readonly enableTopDrawer = input<boolean>(true);
  readonly enableBottomDrawer = input<boolean>(true);
  
  // 事件输出
  readonly drawerStateChange = output<DrawerStateChangeEvent>();
  
  // 收起状态阈值（用于懒加载判断）
  readonly collapsedThreshold = DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED + 2;
  
  // 触摸状态
  private isTouchCaptured = false;
  
  ngOnInit(): void {
    this.gestureService.initialize();
  }
  
  ngOnDestroy(): void {
    this.gestureService.destroy();
  }
  
  /**
   * 触摸开始
   */
  onTouchStart(event: TouchEvent): void {
    this.isTouchCaptured = this.gestureService.onTouchStart(event);
  }
  
  /**
   * 触摸移动
   */
  onTouchMove(event: TouchEvent): void {
    if (!this.isTouchCaptured) return;
    this.gestureService.onTouchMove(event);
  }
  
  /**
   * 触摸结束
   */
  onTouchEnd(_event: TouchEvent): void {
    if (!this.isTouchCaptured) return;
    
    const previousLayer = this.gestureService.activeLayer();
    this.gestureService.onTouchEnd();
    
    // 检查状态是否变化并发出事件
    const currentLayer = this.gestureService.activeLayer();
    if (previousLayer !== currentLayer) {
      this.drawerStateChange.emit({
        previousLayer,
        currentLayer,
        triggeredBy: 'gesture'
      });
    }
    
    this.isTouchCaptured = false;
  }
  
  /**
   * 点击顶部面板把手切换状态
   */
  toggleTopPanel(): void {
    const currentHeight = this.gestureService.topPanelHeight();
    const previousLayer = this.gestureService.activeLayer();
    
    if (currentHeight <= DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED + 2) {
      this.gestureService.openTopDrawer();
    } else {
      this.gestureService.collapseTopDrawer();
    }
    
    // 发出事件
    setTimeout(() => {
      const currentLayer = this.gestureService.activeLayer();
      if (previousLayer !== currentLayer) {
        this.drawerStateChange.emit({
          previousLayer,
          currentLayer,
          triggeredBy: 'programmatic'
        });
      }
    }, DRAWER_CONFIG.ANIMATION_DURATION);
  }
  
  /**
   * 点击底部面板把手切换状态
   */
  toggleBottomPanel(): void {
    const currentHeight = this.gestureService.bottomPanelHeight();
    const previousLayer = this.gestureService.activeLayer();
    
    if (currentHeight <= DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED + 2) {
      this.gestureService.openBottomDrawer();
    } else {
      this.gestureService.collapseBottomDrawer();
    }
    
    // 发出事件
    setTimeout(() => {
      const currentLayer = this.gestureService.activeLayer();
      if (previousLayer !== currentLayer) {
        this.drawerStateChange.emit({
          previousLayer,
          currentLayer,
          triggeredBy: 'programmatic'
        });
      }
    }, DRAWER_CONFIG.ANIMATION_DURATION);
  }
  
  // ========== 公共 API ==========
  
  /**
   * 程序化打开顶层抽屉
   */
  openTopDrawer(): void {
    const previousLayer = this.gestureService.activeLayer();
    this.gestureService.openTopDrawer();
    this.drawerStateChange.emit({
      previousLayer,
      currentLayer: 'top',
      triggeredBy: 'programmatic'
    });
  }
  
  /**
   * 程序化打开底层抽屉
   */
  openBottomDrawer(): void {
    const previousLayer = this.gestureService.activeLayer();
    this.gestureService.openBottomDrawer();
    this.drawerStateChange.emit({
      previousLayer,
      currentLayer: 'bottom',
      triggeredBy: 'programmatic'
    });
  }
  
  /**
   * 程序化关闭抽屉
   */
  closeDrawer(): void {
    const previousLayer = this.gestureService.activeLayer();
    this.gestureService.closeDrawer();
    this.drawerStateChange.emit({
      previousLayer,
      currentLayer: 'middle',
      triggeredBy: 'programmatic'
    });
  }
  
  /**
   * 获取当前活动层
   */
  getActiveLayer(): DrawerLayer {
    return this.gestureService.activeLayer();
  }
}
