import { Component, inject, ChangeDetectionStrategy, computed } from '@angular/core';
import { AuthService } from '../../../services/auth.service';
import { isLocalModeEnabled } from '../../../services/guards/auth.guard';
import { AUTH_CONFIG, FEATURE_FLAGS } from '../../../config';

/**
 * Demo 模式横幅组件
 * 
 * 功能：
 * - 当用户处于本地模式（Demo 模式）时，显示提示横幅
 * - 提供快速入口引导用户部署私有实例或登录
 * 
 * 显示时机：
 * - 用户使用本地模式（未登录云端账号）
 * - 或环境变量中启用了 DEMO_MODE
 */
@Component({
  selector: 'app-demo-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showBanner()) {
      <div class="demo-banner">
        <div class="banner-content">
          <span class="banner-icon">🎮</span>
          <span class="banner-text">
            <strong>Demo 模式</strong>：数据仅保存在当前浏览器，清除缓存会丢失数据
          </span>
          <div class="banner-actions">
            <a 
              href="https://github.com/dydyde/dde#一键部署私有实例" 
              target="_blank"
              rel="noopener noreferrer"
              class="banner-btn primary"
            >
              一键部署私有实例
            </a>
            <button 
              type="button"
              class="banner-btn secondary"
              (click)="onLoginClick()"
            >
              登录 / 注册
            </button>
            <button 
              type="button"
              class="banner-close"
              (click)="dismissBanner()"
              aria-label="关闭提示"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .demo-banner {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 0.625rem 1rem;
      position: relative;
      z-index: 1000;
      font-size: 0.875rem;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }

    .banner-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      max-width: 1200px;
      margin: 0 auto;
    }

    .banner-icon {
      font-size: 1.25rem;
    }

    .banner-text {
      flex: 1 1 auto;
      text-align: center;
      min-width: 200px;
    }

    .banner-text strong {
      font-weight: 600;
    }

    .banner-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }

    .banner-btn {
      padding: 0.375rem 0.875rem;
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .banner-btn.primary {
      background: white;
      color: #667eea;
      border: none;
    }

    .banner-btn.primary:hover {
      background: rgba(255, 255, 255, 0.9);
      transform: translateY(-1px);
    }

    .banner-btn.secondary {
      background: rgba(255, 255, 255, 0.15);
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.3);
    }

    .banner-btn.secondary:hover {
      background: rgba(255, 255, 255, 0.25);
    }

    .banner-close {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      padding: 0.25rem 0.5rem;
      font-size: 1rem;
      line-height: 1;
      transition: color 0.2s ease;
    }

    .banner-close:hover {
      color: white;
    }

    /* 移动端适配 */
    @media (max-width: 640px) {
      .demo-banner {
        padding: 0.5rem 0.75rem;
      }

      .banner-content {
        flex-direction: column;
        gap: 0.5rem;
      }

      .banner-text {
        font-size: 0.8125rem;
      }

      .banner-actions {
        width: 100%;
        justify-content: center;
      }

      .banner-btn {
        padding: 0.25rem 0.625rem;
        font-size: 0.75rem;
      }
    }

    /* 深色模式适配 - 使用项目的 data-color-mode 属性 */
    :host-context([data-color-mode="dark"]) .demo-banner,
    .dark .demo-banner {
      background: linear-gradient(135deg, #4c51bf 0%, #6b46c1 100%);
    }
  `]
})
export class DemoBannerComponent {
  private static readonly DISMISS_STORAGE_KEY = 'nanoflow.demo-banner-dismissed';
  private auth = inject(AuthService);
  
  /** 是否已被用户手动关闭（从 localStorage 恢复） */
  private dismissed = this.loadDismissedState();
  
  /** 从 localStorage 读取关闭状态 */
  private loadDismissedState(): boolean {
    try {
      const stored = localStorage.getItem(DemoBannerComponent.DISMISS_STORAGE_KEY);
      if (!stored) return false;
      const data = JSON.parse(stored);
      // 关闭状态有效期：7 天
      const DISMISS_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - data.timestamp < DISMISS_EXPIRY_MS) {
        return true;
      }
      // 已过期，清除
      localStorage.removeItem(DemoBannerComponent.DISMISS_STORAGE_KEY);
      return false;
    } catch {
      return false;
    }
  }
  
  /** 是否显示 Banner */
  showBanner = computed(() => {
    // 如果用户已关闭，不再显示
    if (this.dismissed) {
      return false;
    }
    
    // 检查是否处于本地模式（Demo 模式）
    const isLocalMode = isLocalModeEnabled();
    
    // 检查当前用户是否是本地模式用户
    const currentUserId = this.auth.currentUserId();
    const isLocalModeUser = currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID;
    
    // 检查 feature flag（可通过环境变量控制）
    const demoModeFlag = FEATURE_FLAGS.DEMO_MODE_ENABLED ?? false;
    
    // 满足以下任一条件时显示：
    // 1. 处于本地模式
    // 2. 当前用户是本地模式用户
    // 3. 启用了 DEMO_MODE feature flag
    return isLocalMode || isLocalModeUser || demoModeFlag;
  });
  
  /**
   * 点击登录按钮
   * 触发登录模态框
   */
  onLoginClick(): void {
    // 清除本地模式标记，让用户可以正常登录
    try {
      localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    } catch {
      // 忽略存储错误
    }
    
    // 刷新页面以重新进入登录流程
    window.location.reload();
  }
  
  /**
   * 关闭横幅
   * 持久化到 localStorage，7 天内不再显示
   */
  dismissBanner(): void {
    this.dismissed = true;
    try {
      localStorage.setItem(
        DemoBannerComponent.DISMISS_STORAGE_KEY, 
        JSON.stringify({ timestamp: Date.now() })
      );
    } catch {
      // 忽略存储错误
    }
  }
}
