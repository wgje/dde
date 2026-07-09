import type { Router } from '@angular/router';

import type { FlowCommandService } from '../../features/flow/services/flow-command.service';
import type { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { reloadViaForceClearCache } from '../../../utils/force-clear-cache';

export type ProjectShellTaskDeepLinkRouteResult = 'flow' | 'workspace' | 'pending';

interface DeepLinkRetryState {
  taskId: string;
  generation: number;
  retries: number;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  degradeToWorkspaceOnMissing: boolean;
}

interface DeepLinkTaskState {
  task: unknown;
  isLoading: boolean;
}

export interface ProjectShellTaskDeepLinkControllerOptions {
  projectState: {
    tasks(): unknown[];
    getTask(taskId: string): unknown;
  };
  syncCoordinator: {
    isLoadingRemote?: () => boolean;
  };
  router: Pick<Router, 'navigate'>;
  toast: {
    info(title: string, message: string, options?: unknown): void;
    warning(title: string, message: string, options?: unknown): void;
    success(title: string): void;
  };
  taskOpsAdapter: Pick<TaskOperationAdapterService, 'addFloatingTask'>;
  flowCommand: Pick<FlowCommandService, 'centerOnNode'>;
  activateFlowIntent(source: 'deeplink'): void;
  setActiveView(view: 'flow'): void;
}

export class ProjectShellTaskDeepLinkController {
  private isDestroyed = false;
  private deepLinkGeneration = 0;
  private deepLinkRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ProjectShellTaskDeepLinkControllerOptions) {}

  handleTaskDeepLink(
    taskId: string,
    options?: { degradeToWorkspaceOnMissing?: boolean },
  ): ProjectShellTaskDeepLinkRouteResult {
    const generation = this.beginDeepLinkAttempt();
    const retryState: DeepLinkRetryState = {
      taskId,
      generation,
      retries: 0,
      maxRetries: 10,
      baseDelay: 100,
      maxDelay: 2000,
      degradeToWorkspaceOnMissing: options?.degradeToWorkspaceOnMissing === true,
    };

    const initialTasks = this.options.projectState.tasks();
    const initialTask = this.options.projectState.getTask(taskId);
    const initialIsLoading =
      this.options.syncCoordinator.isLoadingRemote?.() ?? (initialTasks.length === 0);
    const initialResult: ProjectShellTaskDeepLinkRouteResult = initialTask
      ? 'flow'
      : (!initialIsLoading ? (retryState.degradeToWorkspaceOnMissing ? 'workspace' : 'flow') : 'pending');

    this.tryFocusDeepLinkTask(retryState);
    return initialResult;
  }

  destroy(): void {
    this.isDestroyed = true;
    this.deepLinkGeneration += 1;
    this.clearDeepLinkTimer();
  }

  private beginDeepLinkAttempt(): number {
    this.deepLinkGeneration += 1;
    this.clearDeepLinkTimer();
    return this.deepLinkGeneration;
  }

  private clearDeepLinkTimer(): void {
    if (this.deepLinkRetryTimer === null) return;

    clearTimeout(this.deepLinkRetryTimer);
    this.deepLinkRetryTimer = null;
  }

  private tryFocusDeepLinkTask(retryState: DeepLinkRetryState): void {
    if (this.isDestroyed || retryState.generation !== this.deepLinkGeneration) {
      return;
    }

    retryState.retries++;
    const taskState = this.resolveDeepLinkTaskState(retryState.taskId);

    if (taskState.task) {
      this.focusDeepLinkTask(retryState.taskId, retryState.generation);
      return;
    }

    if (!taskState.isLoading && this.maybeDegradeMissingDeepLinkToWorkspace(retryState)) {
      return;
    }

    if (retryState.retries < retryState.maxRetries && taskState.isLoading) {
      this.scheduleDeepLinkRetry(retryState);
      return;
    }

    this.showDeepLinkFallbackToast(taskState);
  }

  private resolveDeepLinkTaskState(taskId: string): DeepLinkTaskState {
    const tasks = this.options.projectState.tasks();
    return {
      task: this.options.projectState.getTask(taskId),
      isLoading: this.options.syncCoordinator.isLoadingRemote?.() ?? (tasks.length === 0),
    };
  }

  private focusDeepLinkTask(taskId: string, generation: number): void {
    this.options.activateFlowIntent('deeplink');
    this.options.setActiveView('flow');

    this.deepLinkRetryTimer = setTimeout(() => {
      if (this.isDestroyed || generation !== this.deepLinkGeneration) {
        return;
      }
      this.deepLinkRetryTimer = null;
      this.options.flowCommand.centerOnNode(taskId, true);
    }, 100);
  }

  private maybeDegradeMissingDeepLinkToWorkspace(retryState: DeepLinkRetryState): boolean {
    if (!retryState.degradeToWorkspaceOnMissing) {
      return false;
    }

    this.options.toast.warning('任务不存在', '请求的任务已失效，已返回工作区');
    try {
      void Promise.resolve(this.options.router.navigate(['/projects']))
        .catch(() => {
          this.options.toast.warning('返回工作区失败', '请稍后重试或手动返回项目列表');
        });
    } catch {
      this.options.toast.warning('返回工作区失败', '请稍后重试或手动返回项目列表');
    }
    return true;
  }

  private scheduleDeepLinkRetry(retryState: DeepLinkRetryState): void {
    const delay = Math.min(
      retryState.baseDelay * Math.pow(1.5, retryState.retries - 1),
      retryState.maxDelay,
    );
    this.clearDeepLinkTimer();
    this.deepLinkRetryTimer = setTimeout(() => {
      if (retryState.generation !== this.deepLinkGeneration) {
        return;
      }
      this.deepLinkRetryTimer = null;
      this.tryFocusDeepLinkTask(retryState);
    }, delay);
  }

  private showDeepLinkFallbackToast(taskState: DeepLinkTaskState): void {
    this.options.activateFlowIntent('deeplink');
    this.options.setActiveView('flow');

    if (!taskState.isLoading && !taskState.task) {
      this.showMissingDeepLinkTaskToast(this.deepLinkGeneration);
      return;
    }

    this.showDeepLinkTimeoutToast();
  }

  private showMissingDeepLinkTaskToast(generation: number): void {
    this.options.toast.warning(
      '任务不存在',
      '请求的任务可能已被删除或您没有访问权限',
      {
        duration: 10000,
        action: {
          label: '新建任务',
          onClick: () => {
            void this.createFallbackTaskFromDeepLink(generation);
          },
        },
      },
    );
  }

  private async createFallbackTaskFromDeepLink(generation: number): Promise<void> {
    if (this.isDestroyed || generation !== this.deepLinkGeneration) {
      return;
    }

    let saved = false;
    try {
      saved = await this.options.taskOpsAdapter.addFloatingTask('新任务', '', 100, 100);
    } catch {
      saved = false;
    }

    if (this.isDestroyed || generation !== this.deepLinkGeneration) {
      return;
    }

    if (saved) {
      this.options.toast.success('已创建新任务');
      return;
    }

    this.options.toast.warning('创建任务失败', '本地持久化暂不可用，请稍后重试');
  }

  private showDeepLinkTimeoutToast(): void {
    this.options.toast.info(
      '加载超时',
      '数据仍在加载中',
      {
        duration: 8000,
        action: {
          label: '刷新页面',
          onClick: () => reloadViaForceClearCache(),
        },
      },
    );
  }
}
