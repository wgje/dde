import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellTouchGestureControllerLoader,
  type WorkspaceShellTouchGestureControllerLoaderOptions,
} from './workspace-shell-touch-gesture-controller-loader.factory';
import type {
  WorkspaceShellTouchGestureControllerLike,
} from './workspace-shell-touch-gesture-lazy-load.controller';

const TOUCH_GESTURE_LOAD_FAILURE_MESSAGE =
  '触摸手势控制器懒加载失败，已跳过本次手势';
const TOUCH_GESTURE_OPERATION_FAILURE_MESSAGE =
  '触摸手势控制器手势处理失败，已跳过本次手势';

export interface WorkspaceShellTouchGestureLazyHostControllerOptions
  extends WorkspaceShellTouchGestureControllerLoaderOptions {
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellTouchGestureLazyHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellTouchGestureControllerLike
  >;

  constructor(options: WorkspaceShellTouchGestureLazyHostControllerOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: createWorkspaceShellTouchGestureControllerLoader(options),
      loadFailureMessage: TOUCH_GESTURE_LOAD_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  run(action: (controller: WorkspaceShellTouchGestureControllerLike) => void): void {
    this.host.run(
      action,
      TOUCH_GESTURE_OPERATION_FAILURE_MESSAGE,
      TOUCH_GESTURE_LOAD_FAILURE_MESSAGE,
    );
  }
}
