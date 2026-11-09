import {
  createWorkspaceShellActionsControllerLoader,
  type WorkspaceShellActionsControllerLoaderOptions,
} from './workspace-shell-actions-controller-loader.factory';
import {
  isWorkspaceShellActionsMethodName,
  WorkspaceShellActionsCommandHostController,
  type WorkspaceShellActionsHostDelegate,
  type WorkspaceShellActionsMethodName,
} from './workspace-shell-actions-command-host.controller';
import { WorkspaceShellActionsDocumentClickListenerController } from './workspace-shell-actions-document-click-listener.controller';
import {
  WorkspaceShellProjectActionsController,
} from './workspace-shell-project-actions.controller';

export type { WorkspaceShellActionsHostDelegate } from './workspace-shell-actions-command-host.controller';

export interface WorkspaceShellActionsLazyLoadHostOptions
  extends WorkspaceShellActionsControllerLoaderOptions {
  listenToDocument?: (eventName: string, listener: EventListener) => () => void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellActionsLazyLoadHostController
  extends WorkspaceShellProjectActionsController<WorkspaceShellActionsLazyLoadHostOptions> {
  private readonly commandHost: WorkspaceShellActionsCommandHostController;
  private readonly documentClickListener: WorkspaceShellActionsDocumentClickListenerController;

  constructor(options: WorkspaceShellActionsLazyLoadHostOptions) {
    super(options);
    this.documentClickListener = new WorkspaceShellActionsDocumentClickListenerController({
      listenToDocument: options.listenToDocument,
      onDocumentClick: event => this.onGlobalClick(event),
      warn: options.warn,
    });
    this.commandHost = new WorkspaceShellActionsCommandHostController({
      loadActionsController: createWorkspaceShellActionsControllerLoader(options),
      warn: options.warn,
    });
  }

  setupDocumentClickListener(): void {
    this.documentClickListener.setup();
  }

  teardown(): void {
    this.documentClickListener.teardown();
    this.commandHost.teardown();
  }

  createNewProject(): void {
    if (this.blockHintOnlyMutation('创建项目')) return;
    void this.runActionCommand('openNewProjectModal', []);
  }

  runActionCommand(
    method: WorkspaceShellActionsMethodName,
    args: unknown[],
  ): Promise<unknown> {
    return this.commandHost.runActionCommand(method, args);
  }

  skipUnknownActionCommand(method: string): Promise<unknown> {
    return this.commandHost.skipUnknownActionCommand(method);
  }
}

export type WorkspaceShellActionsLazyLoadHostDelegate =
  WorkspaceShellActionsLazyLoadHostController &
  WorkspaceShellActionsHostDelegate;

export function createWorkspaceShellActionsLazyLoadHost(
  options: WorkspaceShellActionsLazyLoadHostOptions,
): WorkspaceShellActionsLazyLoadHostDelegate {
  const controller = new WorkspaceShellActionsLazyLoadHostController(options);

  return new Proxy(controller, {
    get(target, property, receiver) {
      if (property === 'then') {
        return undefined;
      }

      const member = Reflect.get(target, property, receiver);
      if (member !== undefined) {
        return typeof member === 'function' ? member.bind(target) : member;
      }

      if (typeof property !== 'string') {
        return undefined;
      }

      if (!isWorkspaceShellActionsMethodName(property)) {
        return () => target.skipUnknownActionCommand(property);
      }

      return (...args: never[]) =>
        target.runActionCommand(property, args);
    },
  }) as WorkspaceShellActionsLazyLoadHostDelegate;
}
