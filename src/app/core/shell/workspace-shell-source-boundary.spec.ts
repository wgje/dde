import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WorkspaceShellComponent } from '../../../workspace-shell.component';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellPublicControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

function readWorkspaceShellControllerGraphBuilderSource(): string {
  return readFileSync(
    join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-controller-graph-builder.factory.ts',
    ),
    'utf8',
  );
}

describe('WorkspaceShell source boundary', () => {
  it('keeps lazy lifecycle delegation contract split into focused files', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-lazy-lifecycle-delegation.contract.spec.ts',
      ),
      'utf8',
    );

    expect(source.split(/\r?\n/).length).toBeLessThan(520);
  });

  it('不再暴露 projectDraft wrapper，由 actions controller 承接模板读取', () => {
    expect('projectDraft' in WorkspaceShellComponent.prototype).toBe(false);
  });

  it('不再为 shell lifecycle delegates 保留本地透传字段', () => {
    const source = readWorkspaceShellSource();

    expect(source).toContain('private readonly shellLifecycle');
    expect(source).not.toContain(
      'private readonly startupBootstrap = this.shellLifecycle.startupBootstrap',
    );
    expect(source).not.toContain(
      'private readonly afterViewInit = this.shellLifecycle.afterViewInit',
    );
    expect(source).not.toContain(
      'private readonly ngOnInitStartup = this.shellLifecycle.ngOnInitStartup',
    );
    expect(source).not.toContain(
      'private readonly destroyController = this.shellLifecycle.destroyController',
    );
  });

  it('不再为 session exit surface 保留本地透传字段', () => {
    const source = readWorkspaceShellSource();
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const sessionRoutingSurfaceSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-session-routing-surface.factory.ts',
      ),
      'utf8',
    );

    expect(graphBuilderSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(sessionRoutingSurfaceSource).toContain(
      'sessionExitSurface: createWorkspaceShellSessionExitSurface',
    );
    expect(source).not.toContain('private readonly sessionExitSurface');
    expect(source).not.toContain(
      'private readonly signOutController = this.sessionExitSurface.signOutController',
    );
    expect(source).not.toContain(
      'private readonly beforeUnloadController =',
    );
    expect(source).not.toContain('signOutController: this.signOutController');
    expect(source).not.toContain(
      'beforeUnloadController: this.beforeUnloadController',
    );
  });

  it('不再为 session launch controllers 保留本地透传字段', () => {
    const source = readWorkspaceShellSource();
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const lifecycleGraphSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-lifecycle-graph.factory.ts',
      ),
      'utf8',
    );
    const sessionLifecycleSurfaceSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-session-lifecycle-surface.factory.ts',
      ),
      'utf8',
    );

    expect(graphBuilderSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource).toContain(
      'createWorkspaceShellSessionLifecycleSurface',
    );
    expect(sessionLifecycleSurfaceSource).toContain(
      'const sessionLaunchControllers =',
    );
    expect(sessionLifecycleSurfaceSource).toContain(
      'createWorkspaceShellSessionLaunchSurface',
    );
    expect(source).not.toContain('private readonly sessionLaunchControllers');
    expect(source).not.toContain(
      'private readonly sessionTransition =',
    );
    expect(source).not.toContain(
      'private readonly launchSnapshotController =',
    );
    expect(source).not.toContain(
      'launchSnapshotController: this.launchSnapshotController',
    );
    expect(source).not.toContain(
      'sessionTransition: this.sessionTransition',
    );
    expect(source).not.toContain(
      'sessionTransitionCleanup: this.sessionTransition',
    );
  });

  it('将 session lifecycle surface 组装迁移出 controller graph factory', () => {
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const lifecycleGraphSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-lifecycle-graph.factory.ts',
      ),
      'utf8',
    );
    const sessionLifecycleSurfacePath = join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-session-lifecycle-surface.factory.ts',
    );

    expect(existsSync(sessionLifecycleSurfacePath)).toBe(true);

    const sessionLifecycleSurfaceSource = readFileSync(
      sessionLifecycleSurfacePath,
      'utf8',
    );

    expect(graphBuilderSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(lifecycleGraphSource).toContain(
      'createWorkspaceShellSessionLifecycleSurface',
    );
    expect(graphBuilderSource).not.toContain('createWorkspaceShellProjectSubscriptionDelegate');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellRemoteCallbacksDelegate');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellSessionLaunchSurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellSignalEffectsSurface');
    expect(sessionLifecycleSurfaceSource).toContain(
      'createWorkspaceShellProjectSubscriptionDelegate',
    );
    expect(sessionLifecycleSurfaceSource).toContain(
      'createWorkspaceShellRemoteCallbacksDelegate',
    );
    expect(sessionLifecycleSurfaceSource).toContain(
      'createWorkspaceShellSessionLaunchSurface',
    );
    expect(sessionLifecycleSurfaceSource).toContain(
      'createWorkspaceShellSignalEffectsSurface',
    );
  });

  it('将 session routing surface 组装迁移出 controller graph factory', () => {
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const sessionRoutingSurfacePath = join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-session-routing-surface.factory.ts',
    );

    expect(existsSync(sessionRoutingSurfacePath)).toBe(true);

    const sessionRoutingSurfaceSource = readFileSync(
      sessionRoutingSurfacePath,
      'utf8',
    );

    expect(graphBuilderSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellFocusSyncSurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellRoutingSurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellSessionExitSurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellStorageEscapeDelegates');
    expect(sessionRoutingSurfaceSource).toContain(
      'createWorkspaceShellFocusSyncSurface',
    );
    expect(sessionRoutingSurfaceSource).toContain(
      'createWorkspaceShellRoutingSurface',
    );
    expect(sessionRoutingSurfaceSource).toContain(
      'createWorkspaceShellSessionExitSurface',
    );
    expect(sessionRoutingSurfaceSource).toContain(
      'createWorkspaceShellStorageEscapeDelegates',
    );
  });

  it('将 interaction surface 组装迁移出 controller graph factory', () => {
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const interactionSurfacesPath = join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-interaction-surfaces.factory.ts',
    );

    expect(existsSync(interactionSurfacesPath)).toBe(true);

    const interactionSurfacesSource = readFileSync(
      interactionSurfacesPath,
      'utf8',
    );

    expect(graphBuilderSource).toContain('createWorkspaceShellInteractionSurfaces');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellDerivedUiStateController');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellHandoffSurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellInteractionBoundarySurface');
    expect(interactionSurfacesSource).toContain(
      'createWorkspaceShellDerivedUiStateController',
    );
    expect(interactionSurfacesSource).toContain(
      'createWorkspaceShellHandoffSurface',
    );
    expect(interactionSurfacesSource).toContain(
      'createWorkspaceShellInteractionBoundarySurface',
    );
  });

  it('将 startup template surface 组装迁移出 controller graph factory', () => {
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const startupTemplateSurfacesPath = join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-startup-template-surfaces.factory.ts',
    );

    expect(existsSync(startupTemplateSurfacesPath)).toBe(true);

    const startupTemplateSurfacesSource = readFileSync(
      startupTemplateSurfacesPath,
      'utf8',
    );

    expect(graphBuilderSource).toContain('createWorkspaceShellStartupTemplateSurfaces');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellStartupEntrySurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellTemplateSurface');
    expect(startupTemplateSurfacesSource).toContain(
      'createWorkspaceShellStartupEntrySurface',
    );
    expect(startupTemplateSurfacesSource).toContain(
      'createWorkspaceShellTemplateSurface',
    );
  });

  it('将 startup entry registry 迁移出 controller graph factory', () => {
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const startupEntryRegistryPath = join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-startup-entry-registry.factory.ts',
    );

    expect(existsSync(startupEntryRegistryPath)).toBe(true);

    const startupEntryRegistrySource = readFileSync(
      startupEntryRegistryPath,
      'utf8',
    );

    expect(graphBuilderSource).toContain('createWorkspaceShellStartupEntryRegistry');
    expect(graphBuilderSource).not.toContain('interface StartupEntryRef');
    expect(graphBuilderSource).not.toContain('resolveStartupEntryControllers');
    expect(graphBuilderSource).not.toContain(
      'Workspace shell startup entry controllers are not initialized',
    );
    expect(startupEntryRegistrySource).toContain(
      'Workspace shell startup entry controllers are not initialized',
    );
  });

  it('将 base surface 组装迁移出 controller graph factory', () => {
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const baseSurfacesPath = join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-base-surfaces.factory.ts',
    );

    expect(existsSync(baseSurfacesPath)).toBe(true);

    const baseSurfacesSource = readFileSync(baseSurfacesPath, 'utf8');

    expect(graphBuilderSource).toContain('createWorkspaceShellBaseSurfaces');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellLazyServiceRefs');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellLaunchSnapshotSurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellSearchDelegates');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellToolSurface');
    expect(baseSurfacesSource).toContain('createWorkspaceShellLazyServiceRefs');
    expect(baseSurfacesSource).toContain('createWorkspaceShellLaunchSnapshotSurface');
    expect(baseSurfacesSource).toContain('createWorkspaceShellSearchDelegates');
    expect(baseSurfacesSource).toContain('createWorkspaceShellToolSurface');
  });

  it('将 lifecycle graph 组装迁移出 controller graph factory', () => {
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const lifecycleGraphPath = join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-lifecycle-graph.factory.ts',
    );

    expect(existsSync(lifecycleGraphPath)).toBe(true);

    const lifecycleGraphSource = readFileSync(lifecycleGraphPath, 'utf8');

    expect(graphBuilderSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellSessionLifecycleSurface');
    expect(graphBuilderSource).not.toContain('createWorkspaceShellLifecycleSurface');
    expect(lifecycleGraphSource).toContain(
      'createWorkspaceShellSessionLifecycleSurface',
    );
    expect(lifecycleGraphSource).toContain('createWorkspaceShellLifecycleSurface');
  });

  it('不再为 search 与 focus sync surface 保留本地透传字段', () => {
    const source = readWorkspaceShellSource();
    const graphBuilderSource = readWorkspaceShellControllerGraphBuilderSource();
    const baseSurfacesSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-base-surfaces.factory.ts',
      ),
      'utf8',
    );
    const sessionRoutingSurfaceSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-session-routing-surface.factory.ts',
      ),
      'utf8',
    );

    expect(baseSurfacesSource).toContain(
      'searchDelegates: createWorkspaceShellSearchDelegates',
    );
    expect(graphBuilderSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(sessionRoutingSurfaceSource).toContain('const focusSyncControllers =');
    expect(source).not.toContain('private readonly searchDelegates');
    expect(source).not.toContain('private readonly focusSyncControllers');
    expect(source).not.toContain(
      'private readonly searchLazyLoad = this.searchDelegates.searchLazyLoad',
    );
    expect(source).not.toContain(
      'private readonly focusMountIntent =',
    );
    expect(source).not.toContain(
      'private readonly syncPulseLifecycle =',
    );
    expect(source).not.toContain(
      'private readonly mobileFocusGate =',
    );
    expect(source).not.toContain('searchLazyLoad: this.searchLazyLoad');
    expect(source).not.toContain('mobileFocusGate: this.mobileFocusGate');
    expect(source).not.toContain('focusMountIntent: this.focusMountIntent');
    expect(source).not.toContain('syncPulseLifecycle: this.syncPulseLifecycle');
  });

  it('不再为基础 UI 状态和 feature flag 依赖保留本地透传字段', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('private get isSidebarOpen()');
    expect(source).not.toContain('this.isSidebarOpen');
    expect(source).not.toContain(
      'private readonly isMobile = this.uiState.isMobile',
    );
    expect(source).not.toContain('private readonly criticalFeatureFlags =');
    expect(source).not.toContain('isMobile: this.isMobile');
    expect(source).not.toContain('criticalFeatureFlags: this.criticalFeatureFlags');
  });

  it('不再保留未使用的 ngZone 和 destroyRef 注入字段', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toContain('private readonly ngZone = inject(NgZone)');
    expect(source).not.toContain('private readonly destroyRef = inject(DestroyRef)');
  });

  it('不再直接维护 destroyed 标记，由 runtime state controller 承接', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-lifecycle-graph.factory.ts',
      ),
      'utf8',
    );
    const graphContextSource = readFileSync(
      join(process.cwd(), 'src/app/core/shell/workspace-shell-graph-context.factory.ts'),
      'utf8',
    );
    const graphRuntimeContextSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-graph-runtime-context.factory.ts',
      ),
      'utf8',
    );
    const sessionRoutingSurfaceSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-session-routing-surface.factory.ts',
      ),
      'utf8',
    );

    expect(graphContextSource).toContain('createWorkspaceShellGraphRuntimeContext');
    expect(graphContextSource).not.toContain('new WorkspaceShellRuntimeStateController()');
    expect(graphRuntimeContextSource).toContain('new WorkspaceShellRuntimeStateController()');
    expect(graphRuntimeContextSource).toContain('runtime: runtimeState.destroyedDelegate');
    expect(graphRuntimeContextSource).toContain(
      'markDestroyed: runtimeState.markDestroyedDelegate',
    );
    expect(lifecycleGraphSource).toContain(
      'markDestroyed: options.markDestroyed',
    );
    expect(lifecycleGraphSource).toContain('destroyed: options.runtime');
    expect(sessionRoutingSurfaceSource).toContain('isDestroyed: options.runtime');
    expect(lifecycleGraphSource).toContain('markDestroyed');
    expect(source).not.toContain('private destroyed = false');
    expect(source).not.toContain('private readonly runtimeState');
    expect(source).not.toContain('this.destroyed = true');
    expect(source).not.toContain('() => this.destroyed');
    expect(source).not.toContain('() => this.runtimeState.destroyed()');
  });

  it('将 shell controller graph 组装迁移出根组件', () => {
    const source = readWorkspaceShellSource();

    expect(source).toContain('createWorkspaceShellControllerGraph');
    expect(source).toContain('private readonly shellGraph =');
    expect(source).toContain('protected readonly template = this.shellGraph.template');
    expect(source).toContain('private readonly shellLifecycle = this.shellGraph.shellLifecycle');
    expect(source).not.toContain('createWorkspaceShellChromeSurface');
    expect(source).not.toContain('createWorkspaceShellFocusSyncSurface');
    expect(source).not.toContain('createWorkspaceShellLifecycleSurface');
    expect(source).not.toContain('createWorkspaceShellTemplateSurface');
    expect(source).not.toContain('private readonly logger = inject(LoggerService)');
    expect(source).not.toContain('private readonly runtimeState =');
  });

  it('将 controller graph context 编排迁移出 public graph factory', () => {
    const graphSource = readWorkspaceShellPublicControllerGraphSource();
    const builderSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-controller-graph-builder.factory.ts',
      ),
      'utf8',
    );

    expect(graphSource).toContain('createWorkspaceShellControllerGraphFromContext');
    expect(graphSource).toContain('workspace-shell-controller-graph-builder.factory');
    expect(graphSource).not.toContain('createWorkspaceShellBaseSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellInteractionSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellLifecycleGraph');
    expect(graphSource).not.toContain('createWorkspaceShellSessionRoutingSurface');
    expect(graphSource).not.toContain('createWorkspaceShellStartupEntryRegistry');
    expect(graphSource).not.toContain('createWorkspaceShellStartupTemplateSurfaces');
    expect(builderSource).toContain('createWorkspaceShellBaseSurfaces');
    expect(builderSource).toContain('createWorkspaceShellInteractionSurfaces');
    expect(builderSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(builderSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(builderSource).toContain('createWorkspaceShellStartupEntryRegistry');
    expect(builderSource).toContain('createWorkspaceShellStartupTemplateSurfaces');
  });
});
