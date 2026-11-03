import { DOCUMENT } from '@angular/common';
import { Component, ChangeDetectionStrategy, OnInit, OnDestroy, AfterViewInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastContainerComponent } from './app/shared/components/toast-container.component';
import { OfflineBannerComponent } from './app/shared/components/offline-banner.component';
import { DemoBannerComponent } from './app/shared/components/demo-banner.component';
import { PwaInstallPromptBannerComponent } from './app/shared/components/pwa-install-prompt-banner.component';
import { WorkspaceShellCoreComponent } from './app/core/shell/workspace-shell-core.component';
import { WorkspaceSidebarComponent } from './app/core/shell/workspace-sidebar.component';
import { WorkspaceSidebarPanelComponent } from './app/core/shell/workspace-sidebar-panel.component';
import { WorkspaceOverlaysComponent } from './app/core/shell/workspace-overlays.component';
import { WorkspaceSessionStatusOverlaysComponent } from './app/core/shell/workspace-session-status-overlays.component';
import { WorkspaceStartupHintOverlaysComponent } from './app/core/shell/workspace-startup-hint-overlays.component';
import { WorkspaceLoginRequiredOverlayComponent } from './app/core/shell/workspace-login-required-overlay.component';
import { FocusModeComponent } from './app/features/focus/focus-mode.component';
import { createWorkspaceShellControllerGraph } from './app/core/shell/workspace-shell-controller-graph.factory';

/**
 * 应用根组件
 *
 * 认证逻辑委托到 AppAuthCoordinatorService；
 * 会话状态/启动提示/侧栏/未登录占位视图分别下沉到 core/shell 下的子组件。
 */
@Component({
  selector: 'app-workspace-shell',
  standalone: true,
  imports: [
    RouterOutlet,
    ToastContainerComponent,
    OfflineBannerComponent,
    DemoBannerComponent,
    PwaInstallPromptBannerComponent,
    WorkspaceShellCoreComponent,
    WorkspaceSidebarComponent,
    WorkspaceSidebarPanelComponent,
    WorkspaceOverlaysComponent,
    WorkspaceSessionStatusOverlaysComponent,
    WorkspaceStartupHintOverlaysComponent,
    WorkspaceLoginRequiredOverlayComponent,
    // Focus 覆盖层仍走模板 defer
    FocusModeComponent,
  ],
  templateUrl: './workspace-shell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceShellComponent
  implements OnInit, OnDestroy, AfterViewInit
{
  private readonly documentRef = inject(DOCUMENT);
  private readonly shellGraph = createWorkspaceShellControllerGraph();
  protected readonly template = this.shellGraph.template;
  private readonly shellLifecycle = this.shellGraph.shellLifecycle;

  constructor() {
    this.shellLifecycle.startupBootstrap.initialize();
  }

  ngOnInit() {
    this.shellLifecycle.ngOnInitStartup.initialize();
  }

  ngAfterViewInit(): void {
    this.shellLifecycle.afterViewInit.initialize();
  }

  ngOnDestroy() {
    this.shellLifecycle.destroyController.destroy();
  }

  protected reloadCurrentDocument(): void {
    this.documentRef.defaultView?.location.reload();
  }

}
