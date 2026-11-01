import type { Router } from '@angular/router';

import type { FlowCommandService } from '../../features/flow/services/flow-command.service';
import type { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import type { ActiveProjectOwner } from '../../../services/project-state.service';
import { ProjectShellTaskDeepLinkAttemptController } from './project-shell-task-deep-link-attempt.controller';
import {
  ProjectShellTaskDeepLinkRecoveryController,
  type ProjectShellDeepLinkTaskState,
} from './project-shell-task-deep-link-recovery.controller';

export type ProjectShellTaskDeepLinkRouteResult = 'flow' | 'workspace' | 'pending';

interface DeepLinkRetryState {
  taskId: string;
  generation: number;
  owner: ActiveProjectOwner | null;
  deferCenter: boolean;
  retries: number;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  degradeToWorkspaceOnMissing: boolean;
}

export interface ProjectShellTaskDeepLinkControllerOptions {
  projectState: {
    tasks(): unknown[];
    getTask(taskId: string): unknown;
    captureActiveProjectOwner?(): ActiveProjectOwner;
    isActiveProjectOwnerCurrent?(owner: ActiveProjectOwner): boolean;
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
  private readonly attempt = new ProjectShellTaskDeepLinkAttemptController();
  private readonly rejectedNavigationGenerations: number[] = [];
  private readonly recovery: ProjectShellTaskDeepLinkRecoveryController;
  private readonly recoveryPublicationStack: number[] = [];
  private activeAttemptOwner: Readonly<{
    generation: number;
    owner: ActiveProjectOwner | null;
  }> | null = null;

  constructor(private readonly options: ProjectShellTaskDeepLinkControllerOptions) {
    this.recovery = new ProjectShellTaskDeepLinkRecoveryController({
      activateFlowIntent: source => this.publishRecoverySideEffect(
        () => options.activateFlowIntent(source),
      ),
      isAttemptCurrent: generation => this.isAttemptCurrent(generation),
      router: { navigate: commands => this.navigateForRecovery(commands) },
      setActiveView: view => this.publishRecoverySideEffect(() => options.setActiveView(view)),
      taskOpsAdapter: options.taskOpsAdapter,
      toast: {
        info: (title, message, toastOptions) => this.publishRecoverySideEffect(() => {
          if (toastOptions === undefined) options.toast.info(title, message);
          else options.toast.info(title, message, toastOptions);
        }),
        success: title => this.publishRecoverySideEffect(() => options.toast.success(title)),
        warning: (title, message, toastOptions) => {
          const navigationGeneration = title === '返回工作区失败'
            && message === '请稍后重试或手动返回项目列表'
            ? (this.rejectedNavigationGenerations.shift() ?? null)
            : null;
          this.publishRecoverySideEffect(() => {
            if (toastOptions === undefined) options.toast.warning(title, message);
            else options.toast.warning(title, message, toastOptions);
          }, navigationGeneration);
        },
      },
    });
  }

  handleTaskDeepLink(
    taskId: string,
    options?: { degradeToWorkspaceOnMissing?: boolean; deferCenter?: boolean },
  ): ProjectShellTaskDeepLinkRouteResult {
    const generation = this.attempt.beginAttempt();
    const owner = this.options.projectState.captureActiveProjectOwner?.() ?? null;
    this.activeAttemptOwner = Object.freeze({ generation, owner });
    const retryState: DeepLinkRetryState = {
      taskId,
      generation,
      owner,
      deferCenter: options?.deferCenter === true,
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

  retirePendingAttempt(): void {
    this.attempt.beginAttempt();
    this.activeAttemptOwner = null;
  }

  destroy(): void {
    this.attempt.destroy();
    this.activeAttemptOwner = null;
  }

  private tryFocusDeepLinkTask(retryState: DeepLinkRetryState): void {
    if (!this.isAttemptCurrent(retryState.generation)) {
      return;
    }

    retryState.retries++;
    const taskState = this.resolveDeepLinkTaskState(retryState.taskId);

    if (taskState.task) {
      this.focusDeepLinkTask(
        retryState.taskId,
        retryState.generation,
        retryState.owner,
        retryState.deferCenter,
      );
      return;
    }

    if (!taskState.isLoading && this.isAttemptCurrent(retryState.generation)
      && this.withRecoveryPublication(retryState.generation, () => (
        this.recovery.degradeMissingTaskToWorkspace(retryState.degradeToWorkspaceOnMissing)
      ))) {
      return;
    }

    if (retryState.retries < retryState.maxRetries && taskState.isLoading) {
      this.scheduleDeepLinkRetry(retryState);
      return;
    }

    if (this.isAttemptCurrent(retryState.generation)) {
      this.showDeepLinkFallbackToast(taskState, retryState.generation);
    }
  }

  private resolveDeepLinkTaskState(taskId: string): ProjectShellDeepLinkTaskState {
    const tasks = this.options.projectState.tasks();
    return {
      task: this.options.projectState.getTask(taskId),
      isLoading: this.options.syncCoordinator.isLoadingRemote?.() ?? (tasks.length === 0),
    };
  }

  private focusDeepLinkTask(
    taskId: string,
    generation: number,
    owner: ActiveProjectOwner | null,
    deferCenter: boolean,
  ): void {
    if (!this.isPublicationCurrent(generation, owner)) return;
    this.options.activateFlowIntent('deeplink');
    if (!this.isPublicationCurrent(generation, owner)) return;
    this.options.setActiveView('flow');
    if (!this.isPublicationCurrent(generation, owner)) return;
    if (deferCenter) {
      this.attempt.schedule(generation, 100, () => {
        if (!this.isPublicationCurrent(generation, owner)) return;
        this.options.flowCommand.centerOnNode(taskId, true);
      });
      return;
    }
    this.options.flowCommand.centerOnNode(taskId, true);
  }

  private isPublicationCurrent(generation: number, owner: ActiveProjectOwner | null): boolean {
    return this.isAttemptCurrent(generation) && this.activeAttemptOwner?.owner === owner;
  }

  private isAttemptCurrent(generation: number): boolean {
    const active = this.activeAttemptOwner;
    return this.attempt.isCurrent(generation)
      && active?.generation === generation
      && active.owner !== null
      && this.options.projectState.isActiveProjectOwnerCurrent?.(active.owner) === true;
  }

  private publishRecoverySideEffect(effect: () => void, exactGeneration: number | null = null): void {
    const generation = exactGeneration ?? this.recoveryPublicationStack.at(-1)
      ?? this.activeAttemptOwner?.generation;
    if (generation !== undefined && this.isAttemptCurrent(generation)) effect();
  }

  private navigateForRecovery(
    commands: Parameters<Router['navigate']>[0],
  ): ReturnType<Router['navigate']> {
    const generation = this.recoveryPublicationStack.at(-1);
    if (generation === undefined || !this.isAttemptCurrent(generation)) return Promise.resolve(false);
    try {
      return Promise.resolve(this.options.router.navigate(commands)).catch(error => {
        this.rejectedNavigationGenerations.push(generation);
        throw error;
      });
    } catch (error) {
      this.rejectedNavigationGenerations.push(generation);
      throw error;
    }
  }

  private withRecoveryPublication<T>(generation: number, publish: () => T): T {
    this.recoveryPublicationStack.push(generation);
    try {
      return publish();
    } finally {
      this.recoveryPublicationStack.pop();
    }
  }

  private scheduleDeepLinkRetry(retryState: DeepLinkRetryState): void {
    const delay = Math.min(
      retryState.baseDelay * Math.pow(1.5, retryState.retries - 1),
      retryState.maxDelay,
    );
    this.attempt.schedule(retryState.generation, delay, () => {
      this.tryFocusDeepLinkTask(retryState);
    });
  }

  private showDeepLinkFallbackToast(
    taskState: ProjectShellDeepLinkTaskState,
    generation: number,
  ): void {
    this.withRecoveryPublication(generation, () => this.recovery.showFallback(taskState, generation));
  }
}
