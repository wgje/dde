import { Component, inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { GlobalErrorHandler } from '../../../services/global-error-handler.service';

/**
 * 致命错误信息接口
 */
interface FatalErrorInfo {
  message: string;
  userMessage: string;
  timestamp: string;
  stack?: string;
}

/**
 * 致命错误页面组件
 * 当应用发生无法恢复的错误时显示
 * 提供重载应用和返回首页的选项
 */
// 【P2-25 修复】添加 OnPush
@Component({
  selector: 'app-error-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="min-h-screen bg-gradient-to-br from-red-50 to-stone-100 dark:from-red-950 dark:to-stone-900 flex items-center justify-center p-4">
      <div class="text-center max-w-lg">
        <!-- 错误图标 -->
        <div class="mb-8">
          <div class="w-32 h-32 mx-auto bg-red-100 dark:bg-red-900/50 rounded-full flex items-center justify-center animate-pulse">
            <svg class="w-16 h-16 text-red-400 dark:text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
        </div>
        
        <!-- 标题 -->
        <h1 class="text-3xl font-bold text-stone-800 dark:text-stone-100 mb-4">应用出错了</h1>
        <p class="text-stone-600 dark:text-stone-300 mb-2 text-lg">
          {{ errorInfo?.userMessage || '抱歉，应用遇到了一个严重错误。' }}
        </p>
        <p class="text-stone-400 dark:text-stone-500 text-sm mb-8">
          我们已记录此问题，正在努力修复中。
        </p>
        
        <!-- 操作按钮 -->
        <div class="flex flex-col sm:flex-row gap-3 justify-center mb-8">
          <button 
            (click)="clearCacheAndReload()"
            class="px-6 py-3 bg-red-600 rounded-lg text-white font-medium hover:bg-red-700 transition-colors shadow-md hover:shadow-lg flex items-center justify-center gap-2">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            清除缓存并刷新
          </button>
          <button 
            (click)="reloadApp()"
            class="px-6 py-3 bg-teal-600 rounded-lg text-white font-medium hover:bg-teal-700 transition-colors shadow-md hover:shadow-lg flex items-center justify-center gap-2">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            简单刷新
          </button>
        </div>
        
        <!-- 错误详情（可折叠） -->
        @if (errorInfo) {
          <details class="text-left bg-white/50 dark:bg-stone-800/50 rounded-lg p-4 border border-stone-200 dark:border-stone-700">
            <summary class="text-sm text-stone-500 dark:text-stone-400 cursor-pointer hover:text-stone-700 dark:hover:text-stone-200 select-none">
              查看错误详情
            </summary>
            <div class="mt-4 text-xs text-stone-400 dark:text-stone-500 font-mono overflow-auto max-h-48">
              <p class="mb-2"><strong>时间：</strong>{{ errorInfo.timestamp | date:'yyyy-MM-dd HH:mm:ss' }}</p>
              <p class="mb-2"><strong>错误：</strong>{{ errorInfo.message }}</p>
              @if (errorInfo.stack) {
                <pre class="whitespace-pre-wrap break-all bg-stone-100 dark:bg-stone-700 p-2 rounded mt-2">{{ errorInfo.stack }}</pre>
              }
            </div>
          </details>
        }
        
        <!-- 帮助信息 -->
        <div class="mt-8 text-xs text-stone-400 dark:text-stone-500">
          <p>推荐操作：</p>
          <ul class="mt-2 space-y-1">
            <li>• 点击上方「清除缓存并刷新」按钮（可修复大部分问题）</li>
            <li>• 检查网络连接是否正常</li>
            <li>• 如问题持续，尝试使用其他浏览器</li>
          </ul>
          <p class="mt-4">NanoFlow © {{ currentYear }}</p>
        </div>
      </div>
    </div>
  `
})
export class ErrorPageComponent implements OnInit {
  private router = inject(Router);
  private errorHandler = inject(GlobalErrorHandler);
  
  readonly currentYear = new Date().getFullYear();
  errorInfo: FatalErrorInfo | null = null;
  
  ngOnInit() {
    // 尝试从 sessionStorage 获取错误信息
    this.loadErrorInfo();
  }
  
  /**
   * 加载错误信息
   */
  private loadErrorInfo() {
    try {
      const stored = sessionStorage.getItem('nanoflow.fatal-error');
      if (stored) {
        this.errorInfo = JSON.parse(stored);
      }
    } catch {
      // 忽略解析错误
    }
    
    // 也尝试从路由状态获取
    const navState = this.router.getCurrentNavigation()?.extras?.state as { errorMessage?: string; userMessage?: string } | undefined;
    if (navState?.errorMessage && !this.errorInfo) {
      this.errorInfo = {
        message: navState.errorMessage,
        userMessage: navState.userMessage || '应用遇到了一个错误',
        timestamp: new Date().toISOString()
      };
    }
  }
  
  /**
   * 重新加载应用
   */
  reloadApp() {
    // 清除错误状态
    this.clearErrorState();
    
    // 强制刷新页面
    window.location.href = '/';
  }

  /**
   * 清除所有缓存并重新加载应用
   * 这是解决版本偏移/JIT 编译错误的最有效方法
   */
  clearCacheAndReload() {
    // 清除错误状态
    this.clearErrorState();

    // 优先使用全局强制清缓存工具
    type ForceClearCacheWindow = Window & {
      __NANOFLOW_FORCE_CLEAR_CACHE__?: () => Promise<void> | void;
    };
    const forceClearCache = (window as ForceClearCacheWindow).__NANOFLOW_FORCE_CLEAR_CACHE__;

    if (typeof forceClearCache === 'function') {
      void Promise.resolve(forceClearCache()).catch(() => {
        window.location.href = '/';
      });
      return;
    }

    // 回退：手动清理缓存
    void this.forceClearCacheFallback();
  }

  /**
   * 回退缓存清理逻辑
   */
  private async forceClearCacheFallback(): Promise<void> {
    try {
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
    } catch {
      // 忽略清理错误
    }
    window.location.href = '/';
  }
  
  /**
   * 返回首页（不刷新）
   */
  goHome() {
    // 清除错误状态
    this.clearErrorState();
    
    // 重置错误处理器状态
    this.errorHandler.resetFatalState();
    
    // 导航到首页
    void this.router.navigate(['/projects']);
  }
  
  /**
   * 清除错误状态
   */
  private clearErrorState() {
    try {
      sessionStorage.removeItem('nanoflow.fatal-error');
    } catch {
      // 忽略
    }
  }
}
