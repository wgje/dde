/**
 * 移动端黑匣子抽屉组件
 * 
 * 底层抽屉内容：黑匣子数据区
 * 专为移动端抽屉布局优化
 */

import { Component, ChangeDetectionStrategy, inject, signal, OnInit, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BlackBoxService } from '../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../../../services/focus-preference.service';
import { BlackBoxRecorderComponent } from '../../focus/components/black-box/black-box-recorder.component';
import { BlackBoxTextInputComponent } from '../../focus/components/black-box/black-box-text-input.component';
import { BlackBoxDateGroupComponent } from '../../focus/components/black-box/black-box-date-group.component';
import { 
  SwipeGestureState, 
  SwipeDirection, 
  startSwipeTracking, 
  detectHorizontalSwipe 
} from '../../../../utils/gesture';

@Component({
  selector: 'app-mobile-black-box-drawer',
  standalone: true,
  imports: [
    CommonModule, 
    BlackBoxRecorderComponent, 
    BlackBoxTextInputComponent,
    BlackBoxDateGroupComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (focusPrefs.isBlackBoxEnabled()) {
      <div class="flex flex-col h-full"
           (touchstart)="onSwipeTouchStart($event)"
           (touchend)="onSwipeTouchEnd($event)">
        <!-- 标题区域 -->
        <div class="shrink-0 px-4 pt-2 pb-2 flex items-center justify-between">
          <h2 class="text-base font-bold text-stone-700 dark:text-stone-200 flex items-center gap-2">
            📦 黑匣子
            @if (pendingCount() > 0) {
              <span class="bg-amber-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-mono">
                {{ pendingCount() }}
              </span>
            }
          </h2>
        </div>
        
        <!-- 滚动内容区域 -->
        <div class="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-8 flex flex-col gap-3 custom-scrollbar">
          
          <!-- 录音按钮或文字输入 -->
          @if (speechService.isSupported()) {
            <app-black-box-recorder 
              (transcribed)="onTranscribed($event)" />
            <div class="mt-2">
              <app-black-box-text-input 
                [showFallbackHint]="false"
                (submitted)="onTranscribed($event)" />
            </div>
          } @else {
            <app-black-box-text-input 
              (submitted)="onTranscribed($event)" />
          }
          
          <!-- 离线待处理提示 -->
          @if (speechService.offlinePendingCount() > 0) {
            <div class="px-2 py-1.5 bg-amber-100 dark:bg-amber-900/30 
                        rounded-lg text-xs text-amber-700 dark:text-amber-300
                        flex items-center gap-2">
              <span class="animate-pulse">📡</span>
              <span>{{ speechService.offlinePendingCount() }} 条录音待联网后转写</span>
            </div>
          }
          
          <!-- 剩余配额提示 -->
          @if (speechService.remainingQuota() <= 10) {
            <div class="px-2 py-1.5 bg-stone-100 dark:bg-stone-700 
                        rounded-lg text-xs text-stone-500 dark:text-stone-400
                        flex items-center gap-2">
              <span>⚡</span>
              <span>今日剩余 {{ speechService.remainingQuota() }} 次转写</span>
            </div>
          }
          
          <!-- 条目列表（按日期分组） -->
          @for (group of entriesByDate(); track group.date) {
            <app-black-box-date-group 
              [group]="group"
              (markRead)="onMarkRead($event)"
              (markCompleted)="onMarkCompleted($event)"
              (archive)="onArchive($event)"
              (delete)="onDeleteRequested($event)" />
          }
          
          <!-- 空状态 -->
          @if (entriesByDate().length === 0) {
            <div class="py-6 text-center text-xs text-stone-400 dark:text-stone-500">
              <p class="mb-1">按住按钮开始录音</p>
              <p class="opacity-60">语音会自动转为文字</p>
            </div>
          }

          <!-- 删除确认栏 -->
          @if (pendingDeleteId()) {
            <div class="px-2 py-1.5 bg-red-50 dark:bg-red-900/30 
                        rounded-lg text-xs text-red-600 dark:text-red-300
                        flex items-center justify-between gap-2">
              <span>确认删除该条目？</span>
              <div class="flex items-center gap-1.5">
                <button
                  class="px-2 py-1 rounded bg-red-500 text-white text-[10px]
                         hover:bg-red-600 transition-colors"
                  data-testid="confirm-delete"
                  (click)="confirmDelete()">
                  删除
                </button>
                <button
                  class="px-2 py-1 rounded bg-stone-200 dark:bg-stone-700
                         text-stone-600 dark:text-stone-300 text-[10px]
                         hover:bg-stone-300 dark:hover:bg-stone-600 transition-colors"
                  (click)="cancelDelete()">
                  取消
                </button>
              </div>
            </div>
          }
          
        </div>
      </div>
    } @else {
      <!-- 黑匣子未启用 -->
      <div class="flex flex-col h-full items-center justify-center text-stone-400 dark:text-stone-500 text-sm">
        <p>黑匣子功能未启用</p>
        <p class="text-xs mt-1">可在设置中开启</p>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
    }
  `]
})
export class MobileBlackBoxDrawerComponent implements OnInit {
  private blackBoxService = inject(BlackBoxService);
  readonly speechService = inject(SpeechToTextService);
  readonly focusPrefs = inject(FocusPreferenceService);
  
  readonly pendingDeleteId = signal<string | null>(null);
  readonly entriesByDate = this.blackBoxService.entriesByDate;
  readonly pendingCount = this.blackBoxService.pendingCount;
  
  /** 滑动切换视图事件 */
  readonly swipeToSwitch = output<SwipeDirection>();
  
  // 滑动手势状态
  private swipeState: SwipeGestureState = { startX: 0, startY: 0, startTime: 0, isActive: false };
  
  ngOnInit(): void {
    // 加载黑匣子数据（如果尚未加载）
    this.blackBoxService.loadFromServer();
  }
  
  /**
   * 处理转写完成
   */
  onTranscribed(text: string): void {
    if (text.trim()) {
      this.blackBoxService.create({ content: text.trim() });
    }
  }
  
  /**
   * 标记为已读
   */
  onMarkRead(id: string): void {
    this.blackBoxService.markAsRead(id);
  }
  
  /**
   * 标记为完成
   */
  onMarkCompleted(id: string): void {
    this.blackBoxService.markAsCompleted(id);
  }
  
  /**
   * 归档
   */
  onArchive(id: string): void {
    this.blackBoxService.archive(id);
  }

  /**
   * 请求删除
   */
  onDeleteRequested(id: string): void {
    this.pendingDeleteId.set(id);
  }

  /**
   * 确认删除
   */
  confirmDelete(): void {
    const id = this.pendingDeleteId();
    if (!id) return;
    this.blackBoxService.delete(id);
    this.pendingDeleteId.set(null);
  }

  /**
   * 取消删除
   */
  cancelDelete(): void {
    this.pendingDeleteId.set(null);
  }
  
  // ===============================================
  // 滑动切换视图手势处理
  // ===============================================
  
  /**
   * 滑动开始 - 在抽屉容器上调用
   * 用于检测水平滑动以切换视图
   */
  onSwipeTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    this.swipeState = startSwipeTracking(event.touches[0]);
  }
  
  /**
   * 滑动结束 - 检测是否触发视图切换
   * 【重要】检测到有效滑动时阻止事件冒泡，避免 app.component 误打开侧边栏
   */
  onSwipeTouchEnd(event: TouchEvent): void {
    if (!this.swipeState.isActive) return;
    
    const touch = event.changedTouches[0];
    const direction = detectHorizontalSwipe(
      this.swipeState,
      touch.clientX,
      touch.clientY
    );
    
    if (direction) {
      // 阻止事件冒泡，避免 app.component 误判为侧边栏切换手势
      event.stopPropagation();
      this.swipeToSwitch.emit(direction);
    }
    
    this.swipeState = { startX: 0, startY: 0, startTime: 0, isActive: false };
  }
}
