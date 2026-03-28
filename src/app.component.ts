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
 * AppComponent 只负责标记 launch-shell 阶段，其余阶段由 WorkspaceShell 驱动。
 * initial-loader 的隐藏也交由 WorkspaceShell.ngAfterViewInit() 执行，
 * 确保在真实内容就绪后才移除加载指示器，避免移动端出现空白闪屏。
 */
@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterOutlet],
  template: `
    <div class="app-root-shell">
      <router-outlet></router-outlet>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100dvh;
    }

    .app-root-shell {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
  `],
})
export class AppComponent {
  private readonly bootStage = inject(BootStageService);

  constructor() {
    afterNextRender(() => {
      // 仅标记 launch-shell 阶段（Angular 已启动），
      // handoff 和 ready 由 WorkspaceShell 驱动
      this.bootStage.markLaunchShellVisible();
    });
  }
}
