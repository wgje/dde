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

  readonly launchSnapshot = signal<LaunchSnapshot | null>(this.launchSnapshotService.read());
  // styles.css 已恢复到 angular.json 静态构建，不再依赖动态加载信号
  readonly showLaunchShell = computed(() => !this.bootStage.isWorkspaceHandoffReady());

  constructor() {
    afterNextRender(() => {
      this.bootStage.markLaunchShellVisible();
      // 冷启动首帧只预热工作区壳，项目壳延后到 loader hidden 后。
      this.workspaceStartupPreloader.start();
    });

    effect(() => {
      const workspaceReady = this.bootStage.isWorkspaceHandoffReady();
      const appReady = this.bootStage.isApplicationReady();

      if (workspaceReady && !appReady) {
        this.bootStage.markApplicationReady();
      }
    });

    if (typeof window !== 'undefined') {
      const loaderHiddenListener = () => {
        this.bootStage.noteLoaderHidden();
        void this.workspaceStartupPreloader.continueAfterLoaderHidden();
      };
      window.addEventListener('nanoflow:loader-hidden', loaderHiddenListener as EventListener);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('nanoflow:loader-hidden', loaderHiddenListener as EventListener);
      });
    }
  }
}
