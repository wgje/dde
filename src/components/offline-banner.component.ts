import { Component, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SyncService } from '../services/sync.service';
import { ActionQueueService } from '../services/action-queue.service';

/**
 * 离线模式横幅组件
 * 
 * 在用户处于离线状态时显示在页面顶部，
 * 提醒用户当前处于只读模式，更改将在恢复连接后同步。
 */
@Component({
  selector: 'app-offline-banner',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showBanner()) {
      <div class="fixed top-0 left-0 right-0 z-50 animate-slide-down">
        <div class="px-4 py-2 text-center text-sm font-medium flex items-center justify-center gap-2"
             [class]="bannerClass()">
          <!-- 图标 -->
          <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            @if (!isOnline()) {
              <!-- 离线图标 -->
              <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
            } @else if (pendingCount() > 0) {
              <!-- 同步中图标 -->
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            } @else {
              <!-- 警告图标 -->
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            }
          </svg>
          
          <!-- 消息 -->
          <span>{{ bannerMessage() }}</span>
          
          <!-- 待同步数量 -->
          @if (pendingCount() > 0) {
            <span class="px-1.5 py-0.5 bg-white/20 rounded text-xs">
              {{ pendingCount() }} 待同步
            </span>
          }
          
          <!-- 关闭按钮（仅在有待同步时显示，允许用户暂时隐藏） -->
          @if (canDismiss()) {
            <button 
              (click)="dismiss()"
              class="ml-2 p-1 hover:bg-white/20 rounded transition-colors"
              title="隐藏提示">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    @keyframes slide-down {
      from {
        transform: translateY(-100%);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }
    .animate-slide-down {
      animation: slide-down 0.3s ease-out;
    }
  `]
})
export class OfflineBannerComponent {
  private syncService = inject(SyncService);
  private actionQueue = inject(ActionQueueService);
  
  /** 用户是否手动关闭了横幅 */
  private dismissed = false;
  
  /** 网络状态 */
  readonly isOnline = computed(() => this.syncService.syncState().isOnline);
  
  /** 离线模式（网络在线但服务不可用） */
  readonly offlineMode = computed(() => this.syncService.syncState().offlineMode);
  
  /** 待同步操作数量 */
  readonly pendingCount = this.actionQueue.queueSize;
  
  /** 是否显示横幅 */
  readonly showBanner = computed(() => {
    if (this.dismissed) return false;
    // 离线、连接中断或有待同步操作时显示
    return !this.isOnline() || this.offlineMode() || this.pendingCount() > 0;
  });
  
  /** 横幅样式类 */
  readonly bannerClass = computed(() => {
    if (!this.isOnline()) {
      return 'bg-amber-500 text-white';
    }
    if (this.offlineMode()) {
      return 'bg-orange-500 text-white';
    }
    if (this.pendingCount() > 0) {
      return 'bg-blue-500 text-white';
    }
    return 'bg-amber-500 text-white';
  });
  
  /** 横幅消息 */
  readonly bannerMessage = computed(() => {
    if (!this.isOnline()) {
      return '离线模式 - 更改将保存在本地，恢复网络后自动同步';
    }
    if (this.offlineMode()) {
      return '服务连接中断 - 正在尝试重新连接...';
    }
    if (this.pendingCount() > 0) {
      return '正在同步更改到云端...';
    }
    return '您处于离线状态';
  });
  
  /** 是否可以关闭横幅 */
  readonly canDismiss = computed(() => {
    // 只有在有待同步但在线时才能关闭（暂时隐藏）
    // 真正离线时不允许关闭，确保用户知道状态
    return this.isOnline() && !this.offlineMode() && this.pendingCount() > 0;
  });
  
  /** 关闭横幅 */
  dismiss() {
    this.dismissed = true;
    // 5秒后自动重置，允许再次显示
    setTimeout(() => {
      this.dismissed = false;
    }, 5000);
  }
}
