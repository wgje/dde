import { Component, input, output, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from '../../services/store.service';
import { Task } from '../../models';

/**
 * 流程图工具栏组件
 * 包含缩放、自动布局、连接模式等控制按钮
 * 移动端额外提供侧边栏切换按钮
 */
@Component({
  selector: 'app-flow-toolbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- 移动端顶部工具栏：侧边栏切换按钮 + 返回文本视图 -->
    @if (store.isMobile()) {
      <div class="absolute top-2 left-2 z-10 flex items-center gap-2">
        <!-- 侧边栏/项目列表切换按钮 -->
        <button 
          (click)="toggleSidebar.emit()"
          class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600 p-1.5 flex items-center"
          title="打开项目列表">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        
        <!-- 返回文本视图按钮 -->
        <button 
          (click)="goBackToText.emit()"
          class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600 p-1.5 flex items-center gap-1"
          title="返回文本视图">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          <span class="text-[10px] font-medium">文本</span>
        </button>
      </div>
    }

    <!-- Zoom Controls -->
    <div class="absolute z-10 flex gap-2"
         [class.transition-all]="!isResizingDrawer()"
         [class.duration-200]="!isResizingDrawer()"
         [class.flex-col]="!store.isMobile()"
         [class.flex-row]="store.isMobile()"
         [class.bottom-4]="!store.isMobile()"
         [class.left-4]="!store.isMobile()"
         [class.left-2]="store.isMobile()"
         [style.bottom]="mobileBottomPosition()">
        
        <!-- 放大按钮 -->
        <button (click)="zoomIn.emit()" 
                class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                [class.p-2]="!store.isMobile()"
                [class.p-1.5]="store.isMobile()"
                title="放大">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                 [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
        </button>
        
        <!-- 缩小按钮 -->
        <button (click)="zoomOut.emit()" 
                class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
                [class.p-2]="!store.isMobile()"
                [class.p-1.5]="store.isMobile()"
                title="缩小">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                 [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
            </svg>
        </button>
        
        <!-- 自动布局按钮 -->
        <button 
          (click)="autoLayout.emit()" 
          class="bg-white/90 backdrop-blur rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 text-stone-600"
          [class.p-2]="!store.isMobile()"
          [class.p-1.5]="store.isMobile()"
          title="自动整理布局">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()"
                 [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
            </svg>
        </button>
        
        <!-- 连接模式按钮 -->
        <button (click)="toggleLinkMode.emit()" 
                class="backdrop-blur rounded-lg shadow-sm border transition-all hover:bg-stone-50" 
                [class.p-2]="!store.isMobile()" 
                [class.p-1.5]="store.isMobile()" 
                [class.bg-indigo-500]="isLinkMode()" 
                [class.text-white]="isLinkMode()" 
                [class.border-indigo-500]="isLinkMode()" 
                [class.bg-white]="!isLinkMode()" 
                [class.text-stone-600]="!isLinkMode()" 
                [class.border-stone-200]="!isLinkMode()" 
                title="连接模式">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" 
                 [class.h-5]="!store.isMobile()" [class.w-5]="!store.isMobile()" 
                 [class.h-4]="store.isMobile()" [class.w-4]="store.isMobile()">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
        </button>
    </div>
    
    <!-- 连接模式提示 -->
    @if (isLinkMode()) {
      <div class="absolute z-10 bg-indigo-500 text-white font-medium rounded-lg shadow-lg animate-fade-in flex items-center px-3 py-2 text-xs top-4 left-4" 
           [ngClass]="{'top-2 left-1/2 -translate-x-1/2 px-2 py-1.5 max-w-[90vw]': store.isMobile(), 'text-[10px]': store.isMobile()}">
        @if (linkSourceTask(); as source) {
          <span class="truncate">已选: <span class="font-bold">{{ source.title }}</span></span>
          <span class="mx-1">&rarr;</span>
          <span>点击目标</span>
        } @else {
          点击源节点
        }
        <button (click)="cancelLinkMode.emit()" class="ml-2 px-1.5 py-0.5 bg-white/20 rounded hover:bg-white/30 transition-colors">取消</button>
      </div>
    }
  `
})
export class FlowToolbarComponent {
  readonly store = inject(StoreService);
  
  // 输入
  readonly isLinkMode = input<boolean>(false);
  readonly linkSourceTask = input<Task | null>(null);
  readonly isResizingDrawer = input<boolean>(false);
  readonly drawerHeightVh = input<number>(35);
  
  // 输出事件
  readonly zoomIn = output<void>();
  readonly zoomOut = output<void>();
  readonly autoLayout = output<void>();
  readonly toggleLinkMode = output<void>();
  readonly cancelLinkMode = output<void>();
  readonly toggleSidebar = output<void>();
  readonly goBackToText = output<void>();
  
  // 计算移动端工具栏底部位置
  // 使用 calc() 和 vh 单位，确保位置与抽屉高度正确绑定
  readonly mobileBottomPosition = computed(() => {
    if (!this.store.isMobile()) {
      return '16px'; // 桌面端使用固定值
    }
    if (this.store.isFlowDetailOpen()) {
      // 抽屉打开时，工具栏位于抽屉上方 8px
      return `calc(${this.drawerHeightVh()}vh + 8px)`;
    }
    return '8px'; // 抽屉关闭时
  });
}
