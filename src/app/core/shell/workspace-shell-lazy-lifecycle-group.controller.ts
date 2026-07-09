import {
  createWorkspaceShellLazyLifecycleHosts,
  type WorkspaceShellLazyLifecycleGroupMember,
  type WorkspaceShellLazyLifecycleHostsOptions,
} from './workspace-shell-lazy-lifecycle-hosts.factory';
import {
  WorkspaceShellLazyLifecycleStageRunnerController,
} from './workspace-shell-lazy-lifecycle-stage-runner.controller';

export type { WorkspaceShellLazyLifecycleGroupMember } from './workspace-shell-lazy-lifecycle-hosts.factory';

export interface WorkspaceShellLazyLifecycleGroupControllerOptions
  extends WorkspaceShellLazyLifecycleHostsOptions {
  createKeyboardShortcuts?: () => WorkspaceShellLazyLifecycleGroupMember;
  createStartupBreadcrumb?: () => WorkspaceShellLazyLifecycleGroupMember;
  createSwUpdateLifecycle?: () => WorkspaceShellLazyLifecycleGroupMember;
}

export class WorkspaceShellLazyLifecycleGroupController {
  private readonly keyboardShortcuts: WorkspaceShellLazyLifecycleGroupMember;
  private readonly startupBreadcrumb: WorkspaceShellLazyLifecycleGroupMember;
  private readonly swUpdateLifecycle: WorkspaceShellLazyLifecycleGroupMember;
  private readonly stageRunner: WorkspaceShellLazyLifecycleStageRunnerController;

  constructor(options: WorkspaceShellLazyLifecycleGroupControllerOptions) {
    const lazyHosts = createWorkspaceShellLazyLifecycleHosts(options);
    this.keyboardShortcuts = options.createKeyboardShortcuts?.()
      ?? lazyHosts.keyboardShortcuts;
    this.startupBreadcrumb = options.createStartupBreadcrumb?.()
      ?? lazyHosts.startupBreadcrumb;
    this.swUpdateLifecycle = options.createSwUpdateLifecycle?.()
      ?? lazyHosts.swUpdateLifecycle;
    this.stageRunner = new WorkspaceShellLazyLifecycleStageRunnerController({
      warn: options.warn,
    });
  }

  initializeConstructorStage(): void {
    this.stageRunner.run([
      {
        label: 'swUpdateLifecycle.initialize',
        run: () => this.swUpdateLifecycle.initialize(),
      },
    ]);
  }

  initializeNgOnInitStage(): void {
    this.stageRunner.run([
      {
        label: 'keyboardShortcuts.initialize',
        run: () => this.keyboardShortcuts.initialize(),
      },
      {
        label: 'startupBreadcrumb.initialize',
        run: () => this.startupBreadcrumb.initialize(),
      },
    ]);
  }

  teardownKeyboardShortcutsStage(): void {
    this.stageRunner.run([
      {
        label: 'keyboardShortcuts.teardown',
        run: () => this.keyboardShortcuts.teardown(),
      },
    ]);
  }

  teardownStartupStage(): void {
    this.stageRunner.run([
      {
        label: 'startupBreadcrumb.teardown',
        run: () => this.startupBreadcrumb.teardown(),
      },
      {
        label: 'swUpdateLifecycle.teardown',
        run: () => this.swUpdateLifecycle.teardown(),
      },
    ]);
  }
}
