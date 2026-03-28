import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  NgZone,
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

  /** 淡出动画是否已触发（普通布尔值，不是 signal，防止 effect 重入循环） */
  private handoffFadeStarted = false;

  /**
   * 最终兜底超时（ms）。
   * 不依赖 WorkspaceShellComponent 是否加载成功，
   * 如果 handoff 在此时间内仍未到达 'handoff' 阶段，
   * AppComponent 直接强制推进，避免用户永远卡在启动壳。
   *
   * 【P0 秒开优化 2026-03-28】从 5s 降至 2.5s
   * HandoffCoordinator 安全超时已降至 1.5s，此处 2.5s 作为终极兜底。
   */
  private static readonly MASTER_SAFETY_TIMEOUT_MS = 2500;

  constructor() {
    // 第一阶段预热：仅拉取 workspace-shell chunk
    this.workspaceStartupPreloader.start();

    afterNextRender(() => {
      this.bootStage.markLaunchShellVisible();
    });

    // 启动壳淡出动画：handoff 完成后根据启动速度决定是否淡出
    effect(() => {
      const workspaceReady = this.bootStage.isWorkspaceHandoffReady();
      const appReady = this.bootStage.isApplicationReady();

      if (workspaceReady && !appReady) {
        this.bootStage.markApplicationReady();
      }

      // handoff 完成 → 触发移除（仅触发一次）
      if (workspaceReady && !this.handoffFadeStarted) {
        this.handoffFadeStarted = true;
        // 【P1 秒开优化 2026-03-28】快速 handoff 时跳过 200ms 淡出动画。
        // 当 handoff 在 initial-loader 消失前就完成（快照预填充成功路径），
        // 用户看不到 LaunchShell，无需淡出直接移除。
        const metrics = this.bootStage.metrics();
        const handoffFast = (metrics.workspaceHandoffMs ?? Infinity) < 500;
        if (handoffFast) {
          // 快速路径：直接移除，不做淡出动画
          this.launchShellFadingOut.set(false);
        } else {
          // 慢速路径：保留 200ms 淡出，避免硬切闪烁
          this.launchShellFadingOut.set(true);
          setTimeout(() => {
            this.launchShellFadingOut.set(false);
          }, 200);
        }
      }
    });

    // 【P0 终极兜底 2026-03-28】
    // 即使 WorkspaceShellComponent 从未加载（路由守卫失败、懒加载超时、
    // JS 碎片加载失败等灾难场景），确保启动壳一定消失。
    // 不依赖 HandoffCoordinator（它的安全超时由 markLayoutStable 启动，
    // 而 markLayoutStable 在 WorkspaceShell.ngAfterViewInit 中调用——
    // 如果 WorkspaceShell 从未挂载，HandoffCoordinator 的安全超时永远不会开始）。
    if (this.bootShellEnabled) {
      // runOutsideAngular：避免 Zone.js 追踪此定时器（不阻塞测试稳定性，不触发额外 CD）
      const ngZone = inject(NgZone);
      let masterTimer: ReturnType<typeof setTimeout> | null = null;
      ngZone.runOutsideAngular(() => {
        masterTimer = setTimeout(() => {
          if (!this.bootStage.isWorkspaceHandoffReady()) {
            console.warn(
              '[NanoFlow] 启动壳终极兜底触发：2.5s 内 handoff 未完成，强制推进。',
              'stage:', this.bootStage.currentStage(),
            );
            ngZone.run(() => this.bootStage.markWorkspaceHandoffReady());
          }
        }, AppComponent.MASTER_SAFETY_TIMEOUT_MS);
      });
      this.destroyRef.onDestroy(() => { if (masterTimer) clearTimeout(masterTimer); });
    }

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
