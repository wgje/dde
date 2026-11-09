import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';
import {
  createWorkspaceShellSessionTransitionControllerLoader,
  type WorkspaceShellSessionTransitionControllerLoaderOptions,
} from './workspace-shell-session-transition-controller-loader.factory';
import type {
  WorkspaceShellSessionTransitionControllerLike,
} from './workspace-shell-session-transition-lazy-load.controller';

const SESSION_TRANSITION_LOAD_FAILURE_MESSAGE =
  '会话切换控制器懒加载失败，会话事件监听暂不可用';
const SESSION_TRANSITION_SETUP_FAILURE_MESSAGE =
  '会话切换控制器监听初始化失败，会话事件监听暂不可用';
const SESSION_TRANSITION_TEARDOWN_FAILURE_MESSAGE =
  '会话切换控制器清理失败，已跳过';
const SESSION_TRANSITION_SETUP_RETRY_DELAY_MS = 1_000;
const SESSION_TRANSITION_SETUP_MAX_RETRIES = 2;

interface WorkspaceShellSessionTransitionLazyDelegate
  extends WorkspaceShellSessionTransitionControllerLike {
  teardown(): void;
}

export interface WorkspaceShellSessionTransitionLazyHostControllerOptions
  extends WorkspaceShellSessionTransitionControllerLoaderOptions {}

export class WorkspaceShellSessionTransitionLazyHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellSessionTransitionLazyDelegate
  >;
  private readonly loadSessionTransitionController:
    () => Promise<WorkspaceShellSessionTransitionControllerLike>;
  private setupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private tornDown = false;

  constructor(private readonly options: WorkspaceShellSessionTransitionLazyHostControllerOptions) {
    this.loadSessionTransitionController =
      createWorkspaceShellSessionTransitionControllerLoader(options);
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: () => this.createDelegate(),
      loadFailureMessage: SESSION_TRANSITION_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: SESSION_TRANSITION_TEARDOWN_FAILURE_MESSAGE,
      warn: this.options.warn,
    });
  }

  setupSessionHandlers(): void {
    this.runSetupAttempt(0);
  }

  teardown(): void {
    this.tornDown = true;
    this.clearSetupRetryTimer();
    this.host.teardown();
  }

  private runSetupAttempt(retryCount: number): void {
    void this.host.call(
      controller => {
        controller.setupSessionHandlers();
        return true;
      },
      false,
      SESSION_TRANSITION_SETUP_FAILURE_MESSAGE,
      SESSION_TRANSITION_LOAD_FAILURE_MESSAGE,
    ).then(setupSucceeded => {
      if (setupSucceeded) {
        this.clearSetupRetryTimer();
        return;
      }
      if (this.tornDown || retryCount >= SESSION_TRANSITION_SETUP_MAX_RETRIES) {
        return;
      }
      this.scheduleSetupRetry(retryCount + 1);
    });
  }

  private scheduleSetupRetry(retryCount: number): void {
    if (this.setupRetryTimer !== null || this.tornDown) {
      return;
    }
    this.setupRetryTimer = setTimeout(() => {
      this.setupRetryTimer = null;
      this.runSetupAttempt(retryCount);
    }, SESSION_TRANSITION_SETUP_RETRY_DELAY_MS);
  }

  private clearSetupRetryTimer(): void {
    if (this.setupRetryTimer === null) {
      return;
    }
    clearTimeout(this.setupRetryTimer);
    this.setupRetryTimer = null;
  }

  private createDelegate(): Promise<WorkspaceShellSessionTransitionLazyDelegate> {
    return this.loadSessionTransitionController()
      .then(controller => {
        const delegate = controller as WorkspaceShellSessionTransitionLazyDelegate;
        delegate.teardown = controller.cleanup;
        return delegate;
      });
  }
}
