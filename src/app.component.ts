import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { LaunchShellComponent } from './launch-shell.component';
import { BootStageService } from './services/boot-stage.service';
import { LaunchSnapshotService, type LaunchSnapshot } from './services/launch-snapshot.service';
import { WorkspaceStartupPreloaderService } from './services/workspace-startup-preloader.service';

/**
 * 读取 index.html 注入的运行时 Boot Flag。
 * 用于在 Angular 启动前由 index.html 设置的灰度开关。
 */
function readBootFlag(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const flags = (window as Window & { __NANOFLOW_BOOT_FLAGS__?: Record<string, unknown> }).__NANOFLOW_BOOT_FLAGS__;
  const value = flags?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * BootShell（轻量根组件）
 * 仅承载全局错误边界与路由出口，重型工作区逻辑下沉到 WorkspaceShell 路由组件。
 */
@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterOutlet, LaunchShellComponent],
  templateUrl: './app.component.html',
  styles: [`
    :host {
      display: block;
      width: 100%;
      min-height: 100dvh;
    }

    .app-root-shell {
      position: relative;
      width: 100%;
      min-height: 100dvh;
      overflow: hidden;
      background: #f5f5f4;
      color: #1c1917;
    }

    .app-root-shell__workspace {
      min-height: 100dvh;
      width: 100%;
    }

    @media (prefers-color-scheme: dark) {
      .app-root-shell {
        background: #0f172a;
        color: #f5f5f4;
      }
    }
  `],
})
export class AppComponent {
  readonly bootStage = inject(BootStageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly launchSnapshotService = inject(LaunchSnapshotService);
  private readonly workspaceStartupPreloader = inject(WorkspaceStartupPreloaderService);

  /** BOOT_SHELL_SPLIT_V1 门控：关闭时跳过 launch shell，走传统启动路径 */
  private readonly bootShellEnabled = readBootFlag('BOOT_SHELL_SPLIT_V1', true);

  readonly launchSnapshot = signal<LaunchSnapshot | null>(
    this.bootShellEnabled ? this.launchSnapshotService.read() : null,
  );
  readonly showLaunchShell = computed(() =>
    this.bootShellEnabled && !this.bootStage.isWorkspaceHandoffReady(),
  );

  /** 淡出中标志：handoff 后先加 fade class，动画结束再从 DOM 移除 */
  readonly launchShellFadingOut = signal(false);
  /** DOM 存在标志：淡出动画完成后才变 false，避免硬切闪烁 */
  readonly showLaunchShellDom = computed(() =>
    this.showLaunchShell() || this.launchShellFadingOut(),
  );

  constructor() {
    // 第一阶段预热：仅拉取 workspace-shell chunk
    this.workspaceStartupPreloader.start();

    afterNextRender(() => {
      this.bootStage.markLaunchShellVisible();
    });

    // 【P0 新增 2026-03-27】启动壳淡出动画：handoff 完成后先淡出再移除
    effect(() => {
      const workspaceReady = this.bootStage.isWorkspaceHandoffReady();
      const appReady = this.bootStage.isApplicationReady();

      if (workspaceReady && !appReady) {
        this.bootStage.markApplicationReady();
      }

      // handoff 完成 → 触发淡出
      if (workspaceReady && !this.launchShellFadingOut()) {
        this.launchShellFadingOut.set(true);
        // 200ms 淡出动画后从 DOM 移除
        setTimeout(() => {
          this.launchShellFadingOut.set(false);
        }, 200);
      }
    });

    if (typeof window !== 'undefined') {
      const loaderHiddenListener = () => {
        this.bootStage.noteLoaderHidden();
        // 第二阶段预热：initial-loader 淡出后再拉取 project-shell chunk，
        // 避免与首屏渲染争抢主线程。
        this.workspaceStartupPreloader.scheduleProjectShellPreload();
      };
      window.addEventListener('nanoflow:loader-hidden', loaderHiddenListener as EventListener);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('nanoflow:loader-hidden', loaderHiddenListener as EventListener);
      });
    }
  }
}
