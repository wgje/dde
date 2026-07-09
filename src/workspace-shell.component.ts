import { Component, ChangeDetectionStrategy, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { ToastContainerComponent } from './app/shared/components/toast-container.component';
import { SyncStatusComponent } from './app/shared/components/sync-status.component';
import { OfflineBannerComponent } from './app/shared/components/offline-banner.component';
import { DemoBannerComponent } from './app/shared/components/demo-banner.component';
import { PwaInstallPromptBannerComponent } from './app/shared/components/pwa-install-prompt-banner.component';
import { WorkspaceShellCoreComponent } from './app/core/shell/workspace-shell-core.component';
import { WorkspaceSidebarComponent } from './app/core/shell/workspace-sidebar.component';
import { WorkspaceOverlaysComponent } from './app/core/shell/workspace-overlays.component';
import { WorkspaceBootstrapFailureComponent } from './app/core/shell/workspace-bootstrap-failure.component';
import { FocusModeComponent } from './app/features/focus/focus-mode.component';
import { createWorkspaceShellControllerGraph } from './app/core/shell/workspace-shell-controller-graph.factory';

/**
 * 应用根组件
 *
 * 认证逻辑委托到 AppAuthCoordinatorService
 */
@Component({
  selector: 'app-workspace-shell',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    ToastContainerComponent,
    SyncStatusComponent,
    OfflineBannerComponent,
    DemoBannerComponent,
    PwaInstallPromptBannerComponent,
    WorkspaceShellCoreComponent,
    WorkspaceSidebarComponent,
    WorkspaceOverlaysComponent,
    WorkspaceBootstrapFailureComponent,
    // Focus 覆盖层仍走模板 defer
    FocusModeComponent,
  ],
  templateUrl: './workspace-shell.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceShellComponent
  implements OnInit, OnDestroy, AfterViewInit
{
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

}
