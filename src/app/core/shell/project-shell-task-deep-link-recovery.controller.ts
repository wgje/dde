import type { Router } from '@angular/router';

import type { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { reloadViaForceClearCache } from '../../../utils/force-clear-cache';

export interface ProjectShellDeepLinkTaskState {
  task: unknown;
  isLoading: boolean;
}

export interface ProjectShellTaskDeepLinkRecoveryControllerOptions {
  activateFlowIntent(source: 'deeplink'): void;
  isAttemptCurrent(generation: number): boolean;
  reloadPage?: () => void;
  router: Pick<Router, 'navigate'>;
  setActiveView(view: 'flow'): void;
  taskOpsAdapter: Pick<TaskOperationAdapterService, 'addFloatingTask'>;
  toast: {
    info(title: string, message: string, options?: unknown): void;
    warning(title: string, message: string, options?: unknown): void;
    success(title: string): void;
  };
}

export class ProjectShellTaskDeepLinkRecoveryController {
  constructor(
    private readonly options: ProjectShellTaskDeepLinkRecoveryControllerOptions,
  ) {}

  degradeMissingTaskToWorkspace(enabled: boolean): boolean {
    if (!enabled) return false;

    this.options.toast.warning('任务不存在', '请求的任务已失效，已返回工作区');
    try {
      void Promise.resolve(this.options.router.navigate(['/projects']))
        .catch(() => this.showWorkspaceNavigationFailure());
    } catch {
      this.showWorkspaceNavigationFailure();
    }
    return true;
  }

  showFallback(taskState: ProjectShellDeepLinkTaskState, generation: number): void {
    this.options.activateFlowIntent('deeplink');
    this.options.setActiveView('flow');

    if (!taskState.isLoading && !taskState.task) {
      this.showMissingTaskToast(generation);
      return;
    }

    this.showTimeoutToast();
  }

  private showWorkspaceNavigationFailure(): void {
    this.options.toast.warning('返回工作区失败', '请稍后重试或手动返回项目列表');
  }

  private showMissingTaskToast(generation: number): void {
    this.options.toast.warning(
      '任务不存在',
      '请求的任务可能已被删除或您没有访问权限',
      {
        duration: 10000,
        action: {
          label: '新建任务',
          onClick: () => {
            void this.createFallbackTask(generation);
          },
        },
      },
    );
  }

  private async createFallbackTask(generation: number): Promise<void> {
    if (!this.options.isAttemptCurrent(generation)) return;

    let saved = false;
    try {
      saved = await this.options.taskOpsAdapter.addFloatingTask('新任务', '', 100, 100);
    } catch {
      saved = false;
    }

    if (!this.options.isAttemptCurrent(generation)) return;

    if (saved) {
      this.options.toast.success('已创建新任务');
      return;
    }

    this.options.toast.warning('创建任务失败', '本地持久化暂不可用，请稍后重试');
  }

  private showTimeoutToast(): void {
    this.options.toast.info(
      '加载超时',
      '数据仍在加载中',
      {
        duration: 8000,
        action: {
          label: '刷新页面',
          onClick: () => (this.options.reloadPage ?? reloadViaForceClearCache)(),
        },
      },
    );
  }
}
