import { Component, inject, effect, signal, computed, ChangeDetectionStrategy, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { ToastService } from '../../../services/toast.service';
import { ActionQueueService } from '../../../services/action-queue.service';

/**
 * 离线状态通知 + 持久化状态指示器组件
 * 
 * 设计理念：
 * - 使用 Toast 通知 + 持久化小型状态点，避免全屏 banner 遮挡内容
 * - 网络状态变化时弹一次通知
 * - 持久化状态点：
 *   - 在线：绿色圆点（3s 后淡出）
 *   - 离线：红色圆点 + "离线模式"
 *   - 存储受限：橙色圆点 + "存储受限"
 * - 首次加载即离线时发出通知（NEW-7）
 */
@Component({
  selector: 'app-offline-banner',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- 持久化状态指示器 -->
    @if (showIndicator()) {
      <div class="fixed top-2 right-2 z-50 flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium backdrop-blur-sm transition-all duration-300"
           [ngClass]="{
             'bg-red-100/90 dark:bg-red-900/70 text-red-700 dark:text-red-300': isOffline(),
             'bg-amber-100/90 dark:bg-amber-900/70 text-amber-700 dark:text-amber-300': !isOffline() && isStorageFrozen(),
             'bg-green-100/90 dark:bg-green-900/70 text-green-700 dark:text-green-300 opacity-0': !isOffline() && !isStorageFrozen()
           }">
        <div class="w-1.5 h-1.5 rounded-full flex-shrink-0"
             [ngClass]="{
               'bg-red-500 animate-pulse': isOffline(),
               'bg-amber-500 animate-pulse': !isOffline() && isStorageFrozen(),
               'bg-green-500': !isOffline() && !isStorageFrozen()
             }">
        </div>
        @if (isOffline()) {
          <span>离线模式</span>
        } @else if (isStorageFrozen()) {
          <span>存储受限</span>
        }
      </div>
    }
  `,
})
export class OfflineBannerComponent {
  private syncService = inject(SimpleSyncService);
  private actionQueue = inject(ActionQueueService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);
  
  /** 上一次的网络连接状态（用于检测状态变化） */
  private previousOnlineState: boolean | null = null;
  
  /** 上一次的离线模式状态（服务中断） */
  private previousOfflineMode: boolean | null = null;

  /** 是否显示指示器 */
  readonly showIndicator = signal(false);

  /** 离线状态 */
  readonly isOffline = computed(() => 
    !this.syncService.syncState().isOnline || this.syncService.syncState().offlineMode
  );

  /** 存储冻结状态 */
  readonly isStorageFrozen = this.actionQueue.queueFrozen;

  /** 在线恢复后淡出定时器 */
  private fadeOutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // 【NEW-7】首次加载时检测离线状态
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.toast.info('当前处于离线模式', '数据将保存在本地，联网后自动同步');
      this.showIndicator.set(true);
    }

    // 使用 effect 监听网络状态变化
    effect(() => {
      const isOnline = this.syncService.syncState().isOnline;
      const offlineMode = this.syncService.syncState().offlineMode;
      const queueFrozen = this.actionQueue.queueFrozen();
      
      // 检测网络连接状态变化
      if (this.previousOnlineState !== null && this.previousOnlineState !== isOnline) {
        if (isOnline) {
          this.toast.success('网络已恢复', '数据将自动同步到云端');
          // 在线恢复后 3s 淡出指示器
          this.scheduleFadeOut();
        } else {
          this.toast.warning('网络已断开', '更改将保存到本地，联网后自动同步');
          this.cancelFadeOut();
        }
      }
      
      // 检测服务中断状态变化（网络在线但服务不可用）
      if (this.previousOfflineMode !== null && this.previousOfflineMode !== offlineMode) {
        if (offlineMode) {
          this.toast.warning('服务连接中断', '正在重试连接...更改将保存到本地');
          this.cancelFadeOut();
        } else if (isOnline) {
          this.toast.success('服务已恢复', '数据将自动同步');
          this.scheduleFadeOut();
        }
      }

      // 根据状态决定是否显示指示器
      const shouldShow = !isOnline || offlineMode || queueFrozen;
      this.showIndicator.set(shouldShow);
      
      // 更新状态
      this.previousOnlineState = isOnline;
      this.previousOfflineMode = offlineMode;
    });
  }

  private scheduleFadeOut(): void {
    this.cancelFadeOut();
    this.fadeOutTimer = setTimeout(() => {
      if (!this.isOffline() && !this.isStorageFrozen()) {
        this.showIndicator.set(false);
      }
    }, 3000);
  }

  private cancelFadeOut(): void {
    if (this.fadeOutTimer) {
      clearTimeout(this.fadeOutTimer);
      this.fadeOutTimer = null;
    }
  }
}
