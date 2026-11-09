export interface WorkspaceShellProjectSubscriptionControllerOptions {
  isEnabled: () => boolean;
  isReady: () => boolean;
  currentUserId: () => string | null;
  activeProjectId: () => string | null;
  subscribeToProject: (projectId: string, userId: string) => Promise<unknown>;
  unsubscribeFromProject: () => Promise<unknown>;
  warn?: (message: string, context?: unknown) => void;
}

interface WorkspaceShellProjectSubscriptionState {
  projectId: string;
  userId: string;
}

export class WorkspaceShellProjectSubscriptionController {
  private subscribedProject: WorkspaceShellProjectSubscriptionState | null = null;

  constructor(private readonly options: WorkspaceShellProjectSubscriptionControllerOptions) {}

  sync(): void {
    if (!this.options.isEnabled()) {
      this.unsubscribeIfNeeded();
      return;
    }

    const userId = this.options.currentUserId();
    if (!this.options.isReady() || !userId) {
      this.unsubscribeIfNeeded();
      return;
    }

    const projectId = this.options.activeProjectId();
    if (!projectId) {
      this.unsubscribeIfNeeded();
      return;
    }

    if (
      this.subscribedProject?.projectId === projectId &&
      this.subscribedProject.userId === userId
    ) {
      return;
    }

    this.subscribedProject = { projectId, userId };
    try {
      void this.options.subscribeToProject(projectId, userId)
      .catch(error => {
        this.handleSubscribeFailure(projectId, userId, error);
      });
    } catch (error) {
      this.handleSubscribeFailure(projectId, userId, error);
    }
  }

  clear(): void {
    this.unsubscribeIfNeeded();
  }

  private unsubscribeIfNeeded(): void {
    if (this.subscribedProject === null) {
      return;
    }

    const { projectId } = this.subscribedProject;
    this.subscribedProject = null;
    try {
      void this.options.unsubscribeFromProject()
      .catch(error => {
        this.warn('项目订阅取消失败，已继续后续同步流程', {
          error,
          projectId,
        });
      });
    } catch (error) {
      this.warn('项目订阅取消失败，已继续后续同步流程', {
        error,
        projectId,
      });
    }
  }

  private handleSubscribeFailure(projectId: string, userId: string, error: unknown): void {
    if (
      this.subscribedProject?.projectId === projectId &&
      this.subscribedProject.userId === userId
    ) {
      this.subscribedProject = null;
    }

    this.warn('项目订阅失败，已允许下次同步重试', {
      error,
      projectId,
      userId,
    });
  }

  private warn(message: string, context: unknown): void {
    try {
      this.options.warn?.(message, context);
    } catch {
      // Warning failures must not leak into subscription state transitions.
    }
  }
}
