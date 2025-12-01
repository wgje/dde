import { Component, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SyncService } from '../services/sync.service';
import { ActionQueueService } from '../services/action-queue.service';

/**
 * 离线状态横幅组件
 * 
 * 设计理念（参考 Gmail/Google Docs）：
 * - 始终可见的状态指示器，不是弹窗或可关闭的提示
 * - 使用颜色区分不同状态：
 *   - 琥珀色：离线但可编辑（本地保存）
 *   - 橙色：在线但有待同步的更改
 *   - 蓝色：正在同步中
 *   - 红色：同步错误/服务中断
 * - 在 flex 布局中占据固定高度，不遮挡下方内容
 * - 简洁的单行显示，不阻碍用户操作
 */
@Component({
  selector: 'app-offline-banner',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block w-full flex-shrink-0',
    '[class.hidden]': '!showBanner()',
  },
  template: `
    @if (showBanner()) {
      <!-- 状态横幅 - 非固定定位，融入flex布局 -->
      <div 
        class="flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium select-none"
        [class]="bannerClass()"
        role="status"
        [attr.aria-label]="ariaLabel()">
        
        <!-- 状态图标 -->
        <span class="flex-shrink-0">
          @switch (statusType()) {
            @case ('offline') {
              <!-- 离线图标 -->
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
              </svg>
            }
            @case ('syncing') {
              <!-- 同步中图标（旋转动画） -->
              <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            }
            @case ('pending') {
              <!-- 待同步图标 -->
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
            @case ('error') {
              <!-- 错误图标 -->
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            }
          }
        </span>
        
        <!-- 状态文字 -->
        <span class="truncate">{{ statusMessage() }}</span>
        
        <!-- 待同步数量徽章 -->
        @if (pendingCount() > 0) {
          <span class="px-1.5 py-0.5 bg-white/20 rounded-full text-[10px] font-semibold min-w-[20px] text-center">
            {{ pendingCount() }}
          </span>
        }
        
        <!-- 同步进度点（仅在同步时显示） -->
        @if (statusType() === 'syncing') {
          <span class="flex gap-0.5">
            <span class="w-1 h-1 bg-white/60 rounded-full animate-bounce" style="animation-delay: 0ms"></span>
            <span class="w-1 h-1 bg-white/60 rounded-full animate-bounce" style="animation-delay: 150ms"></span>
            <span class="w-1 h-1 bg-white/60 rounded-full animate-bounce" style="animation-delay: 300ms"></span>
          </span>
        }
      </div>
    }
  `,
  styles: [`
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-3px); }
    }
    .animate-bounce {
      animation: bounce 0.6s infinite;
    }
  `]
})
export class OfflineBannerComponent {
  private syncService = inject(SyncService);
  private actionQueue = inject(ActionQueueService);
  
  /** 网络状态 */
  readonly isOnline = computed(() => this.syncService.syncState().isOnline);
  
  /** 离线模式（网络在线但服务不可用） */
  readonly offlineMode = computed(() => this.syncService.syncState().offlineMode);
  
  /** 是否正在同步 */
  readonly isSyncing = computed(() => this.syncService.syncState().isSyncing);
  
  /** 待同步操作数量 */
  readonly pendingCount = this.actionQueue.queueSize;
  
  /** 是否显示横幅 */
  readonly showBanner = computed(() => {
    // 离线、连接中断、正在同步或有待同步操作时显示
    return !this.isOnline() || this.offlineMode() || this.isSyncing() || this.pendingCount() > 0;
  });
  
  /** 状态类型 */
  readonly statusType = computed<'offline' | 'syncing' | 'pending' | 'error'>(() => {
    if (!this.isOnline()) {
      return 'offline';
    }
    if (this.offlineMode()) {
      return 'error'; // 服务中断视为错误状态
    }
    if (this.isSyncing()) {
      return 'syncing';
    }
    if (this.pendingCount() > 0) {
      return 'pending';
    }
    return 'offline';
  });
  
  /** 横幅样式类 - 使用语义化颜色 */
  readonly bannerClass = computed(() => {
    const type = this.statusType();
    
    switch (type) {
      case 'offline':
        // 离线模式：琥珀色（可编辑但未同步）
        return 'bg-amber-500 text-white shadow-sm';
      case 'syncing':
        // 同步中：蓝色
        return 'bg-blue-500 text-white shadow-sm';
      case 'pending':
        // 有待同步：橙色
        return 'bg-orange-500 text-white shadow-sm';
      case 'error':
        // 服务中断：红色
        return 'bg-red-500 text-white shadow-sm';
      default:
        return 'bg-stone-500 text-white shadow-sm';
    }
  });
  
  /** 状态消息 */
  readonly statusMessage = computed(() => {
    const type = this.statusType();
    const pending = this.pendingCount();
    
    switch (type) {
      case 'offline':
        return pending > 0 
          ? '离线模式 · 更改已保存到本地' 
          : '离线模式 · 无网络连接';
      case 'syncing':
        return '正在同步到云端...';
      case 'pending':
        return `${pending} 项更改待同步`;
      case 'error':
        return '服务连接中断 · 正在重试...';
      default:
        return '离线';
    }
  });
  
  /** 无障碍标签 */
  readonly ariaLabel = computed(() => {
    return `网络状态: ${this.statusMessage()}`;
  });
}
