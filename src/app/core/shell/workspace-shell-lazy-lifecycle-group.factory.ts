import type {
  WorkspaceShellLazyLifecycleGroupControllerOptions,
} from './workspace-shell-lazy-lifecycle-group.controller';
import {
  WorkspaceShellLazyLifecycleGroupLazyDelegateController,
} from './workspace-shell-lazy-lifecycle-group-lazy-delegate.controller';

const LAZY_LIFECYCLE_CONSTRUCTOR_STAGE_FAILURE_MESSAGE =
  '懒生命周期构造加载失败';
const LAZY_LIFECYCLE_NG_ON_INIT_STAGE_FAILURE_MESSAGE =
  '懒生命周期初始化加载失败';
const LAZY_LIFECYCLE_KEYBOARD_TEARDOWN_FAILURE_MESSAGE =
  '快捷键生命周期清理失败';
const LAZY_LIFECYCLE_STARTUP_TEARDOWN_FAILURE_MESSAGE =
  '启动生命周期清理失败';

export interface WorkspaceShellLazyLifecycleGroupControllerLike {
  initializeConstructorStage(): void;
  initializeNgOnInitStage(): void;
  teardownKeyboardShortcutsStage(): void;
  teardownStartupStage(): void;
}

export function createWorkspaceShellLazyLifecycleGroupController(
  options: WorkspaceShellLazyLifecycleGroupControllerOptions,
): WorkspaceShellLazyLifecycleGroupControllerLike {
  const lazyGroup = createLazyLifecycleGroupDelegate(options);

  return {
    initializeConstructorStage(): void {
      runLazyLifecycleGroup(
        lazyGroup,
        'initializeConstructorStage',
        LAZY_LIFECYCLE_CONSTRUCTOR_STAGE_FAILURE_MESSAGE,
      );
    },
    initializeNgOnInitStage(): void {
      runLazyLifecycleGroup(
        lazyGroup,
        'initializeNgOnInitStage',
        LAZY_LIFECYCLE_NG_ON_INIT_STAGE_FAILURE_MESSAGE,
      );
    },
    teardownKeyboardShortcutsStage(): void {
      runLazyLifecycleGroup(
        lazyGroup,
        'teardownKeyboardShortcutsStage',
        LAZY_LIFECYCLE_KEYBOARD_TEARDOWN_FAILURE_MESSAGE,
      );
    },
    teardownStartupStage(): void {
      runLazyLifecycleGroup(
        lazyGroup,
        'teardownStartupStage',
        LAZY_LIFECYCLE_STARTUP_TEARDOWN_FAILURE_MESSAGE,
      );
    },
  };
}

type WorkspaceShellLazyLifecycleGroupDelegateHost =
  WorkspaceShellLazyLifecycleGroupLazyDelegateController;

function createLazyLifecycleGroupDelegate(
  options: WorkspaceShellLazyLifecycleGroupControllerOptions,
): WorkspaceShellLazyLifecycleGroupDelegateHost {
  return new WorkspaceShellLazyLifecycleGroupLazyDelegateController(options);
}

function runLazyLifecycleGroup(
  lazyGroup: WorkspaceShellLazyLifecycleGroupDelegateHost,
  method: keyof WorkspaceShellLazyLifecycleGroupControllerLike,
  failureMessage: string,
): void {
  lazyGroup.run(method, failureMessage);
}
