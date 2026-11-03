import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi, describe, it, expect } from 'vitest';
import { WorkspaceShellComponent } from './workspace-shell.component';
import {
  createWorkspaceShellComponentLifecycleContext,
  initializeWorkspaceShellComponentConstructor,
} from './app/core/shell/workspace-shell-component.spec-helpers';

describe('WorkspaceShellComponent lifecycle delegation', () => {
  const templateSource = readFileSync(
    join(process.cwd(), 'src/workspace-shell.component.html'),
    'utf8',
  );

  it('defers the sidebar panel while preserving the mounted shell geometry contract', () => {
    const sidebarSource = templateSource.match(
      /<app-workspace-sidebar>[\s\S]*?<\/app-workspace-sidebar>/,
    )?.[0];

    expect(sidebarSource).toBeDefined();
    expect(sidebarSource).toContain('@defer (on immediate)');
    expect((sidebarSource?.match(/<app-workspace-sidebar-panel\b/g) ?? [])).toHaveLength(1);
    expect(sidebarSource).toContain('[template]="template"');
    expect(sidebarSource).toContain('data-testid="workspace-sidebar-placeholder"');
    expect(sidebarSource).toContain('role="status"');
    expect(sidebarSource).toContain('aria-busy="true"');
    expect(sidebarSource).toContain('role="alert"');
    expect(sidebarSource).toContain('reloadCurrentDocument()');
    expect(sidebarSource).toContain('[style.width.px]="template.state.focusChrome.workspaceSidebarWidthPx()"');
  });

  it('keeps startup hint states visible and Android callbacks actionable when the deferred chunk fails', () => {
    const startupHintSource = templateSource.slice(
      templateSource.indexOf('@defer (when template.state.floatingNoticeChrome.blockingStartupHintOverlayVisible()'),
      templateSource.indexOf('<!-- Left Sidebar: Project List -->'),
    );
    const errorFallback = startupHintSource.split('} @error {')[1] ?? '';

    expect(errorFallback).toContain('data-testid="startup-hint-overlay-error"');
    expect(errorFallback).toContain('data-testid="startup-hint-banner-error"');
    expect(errorFallback).toContain('compactStartupHintBannerVisible()');
    expect(errorFallback).toContain('data-testid="android-widget-callback-overlay-error"');
    expect(errorFallback).toContain('pendingAndroidWidgetManualCallback()');
    expect(errorFallback).toContain('androidWidgetLazyLoad.continueManualCallback()');
    expect(errorFallback).toContain('androidWidgetLazyLoad.useIntentFallback()');
    expect(errorFallback).toContain('androidWidgetLazyLoad.dismissManualCallback()');
  });

  it('uses same-document reload without changing the current URL state', () => {
    const location = {
      href: 'https://nanoflow.test/#/projects/p1/text?task=t1',
      hash: '#/projects/p1/text?task=t1',
      search: '',
      reload: vi.fn(),
    };
    const context = {
      documentRef: { defaultView: { location } },
    } as unknown as WorkspaceShellComponent;

    const reloadCurrentDocument = Object.getOwnPropertyDescriptor(
      WorkspaceShellComponent.prototype,
      'reloadCurrentDocument',
    )?.value as ((this: WorkspaceShellComponent) => void) | undefined;
    if (!reloadCurrentDocument) throw new Error('reloadCurrentDocument method is missing');
    reloadCurrentDocument.call(context);

    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(location.href).toBe('https://nanoflow.test/#/projects/p1/text?task=t1');
    expect(location.hash).toBe('#/projects/p1/text?task=t1');
    expect(location.search).toBe('');
  });

  it('does not introduce anchor or router URL mutation for sidebar recovery', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/workspace-shell.component.ts'),
      'utf8',
    );

    expect(source).toContain('location.reload()');
    expect(source).not.toMatch(/location\.(href|hash|pathname)\s*=/);
    expect(source).not.toMatch(/history\.(pushState|replaceState)\s*\(/);
    expect(templateSource).not.toContain('href="/"');
  });

  it('constructor 应委托 startup bootstrap lifecycle controller', () => {
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext();

    initializeWorkspaceShellComponentConstructor(context);

    expect(shellLifecycle.startupBootstrap.initialize).toHaveBeenCalledTimes(1);
  });

  it('ngOnInit 应委托启动编排 controller', () => {
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext();

    WorkspaceShellComponent.prototype.ngOnInit.call(context);

    expect(shellLifecycle.ngOnInitStartup.initialize).toHaveBeenCalledTimes(1);
  });

  it('ngAfterViewInit 应委托 after-view-init lifecycle controller', () => {
    const scheduleAggressivePrewarm = vi.fn();
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext({
      flowPrewarm: { scheduleAggressivePrewarm },
    });

    WorkspaceShellComponent.prototype.ngAfterViewInit.call(context);

    expect(shellLifecycle.afterViewInit.initialize).toHaveBeenCalledTimes(1);
    expect(scheduleAggressivePrewarm).not.toHaveBeenCalled();
  });

  it('ngOnDestroy 应委托 destroy controller 统一清理 shell 生命周期资源', () => {
    const teardown = vi.fn();
    const { context, shellLifecycle } =
      createWorkspaceShellComponentLifecycleContext({
      flowPrewarm: { teardown },
    });

    WorkspaceShellComponent.prototype.ngOnDestroy.call(context);

    expect(teardown).not.toHaveBeenCalled();
    expect(shellLifecycle.destroyController.destroy).toHaveBeenCalledTimes(1);
  });

});
