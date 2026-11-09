import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import type {
  WorkspaceShellActionsLazyLoadHostOptions,
} from './workspace-shell-actions-lazy-load-host.controller';
import type {
  WorkspaceShellActionsInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';
import {
  createWorkspaceShellInteractionActionsHostLoader,
} from './workspace-shell-interaction-actions-host-loader.factory';

type WindowDocumentTarget = Pick<Document, 'addEventListener' | 'removeEventListener'>;

export type WorkspaceShellInteractionActionsHostOptions =
  Omit<
    WorkspaceShellActionsLazyLoadHostOptions,
    'createActionsController' | 'listenToDocument' | 'warn'
  > & {
    getDocument?: () => Document | undefined;
    warn: (message: string, error: unknown) => void;
    createActionsHost?: () => WorkspaceShellActionsInteractionDelegate;
  };

export function createWorkspaceShellInteractionActionsHost(
  options: WorkspaceShellInteractionActionsHostOptions,
): WorkspaceShellActionsInteractionDelegate {
  const loadActionsHost = createWorkspaceShellInteractionActionsHostLoader({
    options: {
      ...options,
      listenToDocument: createDocumentListener(options),
    },
  });

  const deferredHost = createWorkspaceShellDeferredController<WorkspaceShellActionsInteractionDelegate>(
    () => resolveActionsHost(options, loadActionsHost),
    {
      actionFailureMessage: '工作区操作执行失败，已跳过本次操作',
      failureMessage: '工作区操作 lazy-load host 加载失败，已跳过本次操作',
      warn: options.warn,
    },
  );
  return new Proxy(deferredHost, {
    get(target, property, receiver) {
      if (property === 'openTrashModal') {
        return () => target.openTrashModal(options.modalCoord.captureProjectUiOwner());
      }
      if (property === 'confirmDeleteProject') {
        return (projectId: string, projectName: string, event: Event) => {
          const owner = options.modalCoord.captureProjectUiOwner();
          return target.confirmDeleteProject(projectId, projectName, event, owner ?? undefined);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function resolveActionsHost(
  options: WorkspaceShellInteractionActionsHostOptions,
  loadActionsHost: () => Promise<WorkspaceShellActionsInteractionDelegate>,
): Promise<WorkspaceShellActionsInteractionDelegate> {
  if (options.createActionsHost) {
    return Promise.resolve(options.createActionsHost());
  }

  return loadActionsHost();
}

function createDocumentListener(
  options: WorkspaceShellInteractionActionsHostOptions,
): (eventName: string, listener: EventListener) => () => void {
  return (eventName, listener) => {
    const targetDocument = (options.getDocument?.() as WindowDocumentTarget | undefined)
      ?? (typeof document === 'undefined' ? undefined : document);
    if (!targetDocument) {
      return () => undefined;
    }

    targetDocument.addEventListener(eventName, listener);
    return () => targetDocument.removeEventListener(eventName, listener);
  };
}
