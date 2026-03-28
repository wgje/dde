import {
  Component,
  ChangeDetectionStrategy,
  afterNextRender,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { BootStageService } from './services/boot-stage.service';

/**
 * BootShell（轻量根组件）
 * 仅承载路由出口，重型工作区逻辑下沉到 WorkspaceShell 路由组件。
 *
 * 【2026-03-28 大改】移除启动壳（LaunchShellComponent）及其全部中间态逻辑。
 * Angular 引导后直接显示 WorkspaceShell，不再有任何覆盖层/淡出动画。
 */
@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterOutlet],
  template: `
    <div class="app-root-shell">
      <div class="app-root-shell__workspace">
        <router-outlet></router-outlet>
      </div>
    </div>
  `,
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
  private readonly bootStage = inject(BootStageService);

  constructor() {
    afterNextRender(() => {
      // 立即推进启动阶段到 ready，不再有中间态
      this.bootStage.markLaunchShellVisible();
      this.bootStage.markWorkspaceHandoffReady();
      this.bootStage.markApplicationReady();

      // 隐藏 index.html 的 initial-loader（如果还存在）
      if (typeof window !== 'undefined') {
        const loader = document.getElementById('initial-loader');
        if (loader) {
          loader.style.display = 'none';
        }
        window.dispatchEvent(new CustomEvent('nanoflow:loader-hidden'));
      }
    });
  }
}
