import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { LoggerService } from '../../../services/logger.service';
import { WriteGuardService } from '../../../services/write-guard.service';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { environment } from '../../../environments/environment';

/**
 * MigrationRecoveryComponent —— 计划 §16.26 / §3 / §7
 *
 * 用途：在 Cloudflare 迁移割接窗口期，针对以下场景显示可见的横幅：
 *
 * 1. **旧 Vercel origin（vercel-legacy / export-only / read-only）**：
 *    旧域名变成只读历史副本，提示用户切换到 canonical origin 并提供导出入口。
 *
 * 2. **canonical origin + 登录后 IndexedDB 为空（首次访问新域）**：
 *    用户从旧 origin 切到新 origin 后本地缓存重置，提示恢复中并展示来源指引。
 *
 * 3. **运行时降级（WriteGuard.escalateTo）**：
 *    Origin Gate 在某些边界场景把当前页升级到 read-only / export-only，
 *    必须有可见反馈而不是静默丢写。
 *
 * 设计：
 * - standalone + OnPush + Signals（Hard Rules）；
 * - 不提供 cloud sync 操作 —— 写入闸门由 WriteGuardService 在更下层强制；
 * - 用户可暂时关闭（每次 reload 重新评估，不持久化），避免 7 天关闭后忽视真实
 *   迁移状态变更。
 */
@Component({
  selector: 'app-migration-recovery',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showBanner()) {
      <div class="migration-banner-shell" role="status" aria-live="polite">
        <div class="migration-banner" [attr.data-mode]="bannerMode()">
          <div class="banner-content">
            <span class="banner-icon">{{ bannerIcon() }}</span>
            <div class="banner-text">
              <strong>{{ bannerTitle() }}</strong>
              <p>{{ bannerDescription() }}</p>
            </div>
            <div class="banner-actions">
              @if (canonicalOriginUrl(); as url) {
                <a
                  class="banner-btn primary"
                  [href]="url"
                  rel="noopener"
                >迁移到新地址</a>
              }
              @if (showExportLink()) {
                <button
                  type="button"
                  class="banner-btn secondary"
                  (click)="onExportClick()"
                >导出本地数据</button>
              }
              <button
                type="button"
                class="banner-close"
                (click)="dismissForSession()"
                aria-label="本次会话隐藏提示"
              >✕</button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .migration-banner-shell {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 905;
      pointer-events: none;
      padding-top: env(safe-area-inset-top, 0px);
    }

    .migration-banner {
      pointer-events: auto;
      padding: 0.75rem 1rem;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
      color: var(--theme-primary-contrast, white);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--theme-warning, #c2410c) 82%, white 18%) 0%,
        color-mix(in srgb, var(--theme-warning, #c2410c) 92%, #1f2937 8%) 100%
      );
    }

    .migration-banner[data-mode="export-only"] {
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--theme-error, #b91c1c) 82%, white 18%) 0%,
        color-mix(in srgb, var(--theme-error, #b91c1c) 92%, #1f2937 8%) 100%
      );
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

    .banner-icon { font-size: 1.5rem; }

    .banner-text {
      flex: 1 1 auto;
      min-width: 200px;
    }

    .banner-text strong {
      display: block;
      font-weight: 600;
      margin-bottom: 0.125rem;
    }

    .banner-text p {
      margin: 0;
      font-size: 0.8125rem;
      opacity: 0.92;
    }

    .banner-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .banner-btn {
      padding: 0.375rem 0.875rem;
      border-radius: 0.375rem;
      font-size: 0.8125rem;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
      white-space: nowrap;
      transition: transform 0.15s ease;
    }
    .banner-btn:hover { transform: translateY(-1px); }

    .banner-btn.primary {
      background: var(--theme-surface-base, white);
      color: var(--theme-primary-text, #c2410c);
      border: none;
    }

    .banner-btn.secondary {
      background: color-mix(in srgb, var(--theme-surface-base) 16%, transparent);
      color: var(--theme-primary-contrast, white);
      border: 1px solid color-mix(in srgb, var(--theme-surface-base) 28%, transparent);
    }

    .banner-close {
      background: transparent;
      border: none;
      color: color-mix(in srgb, var(--theme-primary-contrast, white) 78%, transparent);
      cursor: pointer;
      padding: 0.25rem 0.5rem;
      font-size: 1rem;
    }

    @media (max-width: 640px) {
      .banner-content { flex-direction: column; gap: 0.5rem; }
      .banner-actions { width: 100%; justify-content: center; }
    }
  `],
})
export class MigrationRecoveryComponent {
  private readonly logger = inject(LoggerService).category('MigrationRecovery');
  private readonly writeGuard = inject(WriteGuardService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  private readonly dismissed = signal<boolean>(this.loadSessionDismissed());

  /** 当前是否需要显示 banner —— 取决于 WriteGuard mode 与 dismiss 状态。 */
  readonly showBanner = computed<boolean>(() => {
    if (this.dismissed()) return false;
    return this.writeGuard.isReadOnly();
  });

  readonly bannerMode = computed<'read-only' | 'export-only'>(() =>
    this.writeGuard.isExportOnly() ? 'export-only' : 'read-only'
  );

  readonly bannerIcon = computed<string>(() =>
    this.writeGuard.isExportOnly() ? '🚧' : '⚠️'
  );

  readonly bannerTitle = computed<string>(() =>
    this.writeGuard.isExportOnly()
      ? '此地址已停止接受新数据'
      : '当前为只读模式'
  );

  readonly bannerDescription = computed<string>(() => {
    if (this.writeGuard.isExportOnly()) {
      return '我们正在迁移到新域名。这里展示的是历史数据快照，请尽快导出本地数据并切换到新地址继续使用。';
    }
    return '当前页面暂时禁止云端同步，可继续浏览历史数据。导出数据或刷新后将自动尝试恢复同步。';
  });

  readonly canonicalOriginUrl = computed<string | null>(() => {
    const env = environment as unknown as { canonicalOrigin?: string };
    const origin = env.canonicalOrigin;
    if (!origin) return null;
    if (typeof location === 'undefined') return origin;
    if (origin === location.origin) return null;
    try {
      const dest = new URL(location.pathname + location.search + location.hash, origin);
      return dest.toString();
    } catch {
      return origin;
    }
  });

  readonly showExportLink = computed<boolean>(() => {
    // 仅在 export-only 模式提示导出，避免 read-only 阶段过度打扰。
    return this.writeGuard.isExportOnly();
  });

  /** 用户暂时隐藏：仅在当前 sessionStorage 生命周期内有效。 */
  dismissForSession(): void {
    this.dismissed.set(true);
    if (typeof sessionStorage !== 'undefined') {
      try { sessionStorage.setItem(MigrationRecoveryComponent.DISMISS_KEY, '1'); } catch { /* noop */ }
    }
    this.sentryLazyLoader.addBreadcrumb({
      category: 'migration',
      level: 'info',
      message: 'migration_recovery_dismissed',
      data: { mode: this.bannerMode() },
    });
  }

  /**
   * 点击导出：派发自定义事件，由 ShellComponent 拦截后弹出 ExportDataModal。
   * 这里不直接耦合具体导出实现，避免 component 之间产生硬依赖。
   */
  onExportClick(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('nanoflow:request-data-export', {
      detail: { source: 'migration-recovery-banner' },
    }));
    this.logger.info('migration_recovery_export_requested');
    this.sentryLazyLoader.addBreadcrumb({
      category: 'migration',
      level: 'info',
      message: 'migration_recovery_export_requested',
      data: { mode: this.bannerMode() },
    });
  }

  private loadSessionDismissed(): boolean {
    if (typeof sessionStorage === 'undefined') return false;
    try {
      return sessionStorage.getItem(MigrationRecoveryComponent.DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  private static readonly DISMISS_KEY = 'nanoflow.migration-recovery-dismissed';
}
