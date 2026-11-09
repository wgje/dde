/**
 * StartupBreadcrumbService
 *
 * 从 WorkspaceShellComponent 抽离的启动/同步 Sentry breadcrumb 记录。
 *
 * 职责单一：
 * - 一次性记录预加载开关 / modulepreload 模式的启动 breadcrumb
 * - 监听 `nanoflow:flow-restore-status` / `nanoflow:sync-pulse` 自定义事件并转记 breadcrumb
 *
 * 为什么抽离：
 * - AGENTS.md §12 单文件 ≤ 800 行硬线；workspace-shell.component.ts 长期越界
 * - 纯诊断埋点，仅依赖 SentryLazyLoaderService + window 事件，与组件状态零耦合
 */
import { Injectable, inject } from '@angular/core';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

@Injectable({ providedIn: 'root' })
export class StartupBreadcrumbService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private startupBreadcrumbRecorded = false;
  private listenersAttached = false;

  private readonly flowRestoreListener = (event: Event) => {
    try {
      const detail = (event as CustomEvent<{ mode?: 'applied' | 'degraded'; reason?: string; projectId?: string }>).detail;
      const mode = detail?.mode === 'applied' ? 'applied' : 'degraded';
      this.sentryLazyLoader.addBreadcrumb({
        category: 'startup',
        message: mode === 'applied' ? 'flow.restore.applied' : 'flow.restore.degraded',
        level: 'info',
        data: {
          mode,
          reason: detail?.reason ?? 'unknown',
          projectId: detail?.projectId ?? null,
        },
      });
    } catch {
      // Observability failures must not break the flow restore event path.
    }
  };

  private readonly syncPulseListener = (event: Event) => {
    try {
      const detail = (event as CustomEvent<{ status?: string; reason?: string; skipReason?: string }>).detail;
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'sync.pulse.reason',
        level: 'info',
        data: {
          status: detail?.status ?? 'unknown',
          reason: detail?.reason ?? 'unknown',
          skipReason: detail?.skipReason ?? null,
        },
      });
    } catch {
      // Observability failures must not break the sync pulse event path.
    }
  };

  /** 记录一次性启动 breadcrumb 并注册 flow-restore / sync-pulse 事件监听。 */
  initialize(): void {
    if (typeof window === 'undefined') return;
    if (!this.startupBreadcrumbRecorded) {
      this.recordStartupPreloadBreadcrumb();
      this.recordModulePreloadModeBreadcrumb();
      this.startupBreadcrumbRecorded = true;
    }
    if (this.listenersAttached) return;
    window.addEventListener('nanoflow:flow-restore-status', this.flowRestoreListener as EventListener);
    window.addEventListener('nanoflow:sync-pulse', this.syncPulseListener as EventListener);
    this.listenersAttached = true;
  }

  /** 注销事件监听。 */
  teardown(): void {
    if (!this.listenersAttached) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('nanoflow:flow-restore-status', this.flowRestoreListener as EventListener);
      window.removeEventListener('nanoflow:sync-pulse', this.syncPulseListener as EventListener);
    }
    this.listenersAttached = false;
  }

  private recordStartupPreloadBreadcrumb(): void {
    if (typeof window === 'undefined') return;
    const preloadDisabled = (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__ !== false;
    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: preloadDisabled ? 'startup.preload.disabled' : 'startup.preload.enabled',
      level: 'info',
      data: { preloadDisabled },
    });
  }

  private recordModulePreloadModeBreadcrumb(): void {
    if (typeof window === 'undefined') return;

    const strictModulepreload =
      (window as Window).__NANOFLOW_BOOT_FLAGS__?.STRICT_MODULEPRELOAD_V2 !== false;

    this.sentryLazyLoader.addBreadcrumb({
      category: 'startup',
      message: strictModulepreload
        ? 'startup.modulepreload.strict'
        : 'startup.modulepreload.relaxed',
      level: 'info',
      data: { strictModulepreload },
    });
  }
}
