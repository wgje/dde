import type { Injector } from '@angular/core';

import { WorkspaceShellInteractionSidebarResizeLazyDelegateController } from './workspace-shell-interaction-sidebar-resize-lazy-delegate.controller';
import {
  createWorkspaceShellInteractionSidebarResizeHostLoader,
} from './workspace-shell-interaction-sidebar-resize-host-loader.factory';
import type {
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate,
  WorkspaceShellSidebarResizeDeferredLazyLoadHostOptions,
} from './workspace-shell-sidebar-resize-deferred-lazy-load-host.controller';

export type WorkspaceShellInteractionSidebarResizeDelegate =
  WorkspaceShellSidebarResizeDeferredLazyLoadHostDelegate;

type WorkspaceShellInteractionSidebarResizeDelegateOptions = Pick<
  WorkspaceShellSidebarResizeDeferredLazyLoadHostOptions,
  'destroyed' | 'injector' | 'loadSidebarResize' | 'warn'
> & {
  createSidebarResizeLazyLoadHost?: () => Promise<WorkspaceShellInteractionSidebarResizeDelegate>;
};

export interface WorkspaceShellInteractionSidebarResizeHostOptions {
  destroyed?: () => boolean;
  listenToDocument?: (eventName: string, listener: EventListener) => () => void;
  injector: Injector;
  getDocument?: () => Document | undefined;
  warn: (message: string, error: unknown) => void;
  createSidebarResizeFactoryHost?: () => Promise<WorkspaceShellInteractionSidebarResizeDelegate>;
  createSidebarResizeDelegate?: (
    options: WorkspaceShellInteractionSidebarResizeDelegateOptions,
  ) => WorkspaceShellInteractionSidebarResizeDelegate;
  createSidebarResizeLazyLoadHost?: () => Promise<WorkspaceShellInteractionSidebarResizeDelegate>;
  loadSidebarResize?: WorkspaceShellSidebarResizeDeferredLazyLoadHostOptions['loadSidebarResize'];
}

export function createWorkspaceShellInteractionSidebarResizeHost(
  options: WorkspaceShellInteractionSidebarResizeHostOptions,
): WorkspaceShellInteractionSidebarResizeDelegate {
  const listenToDocument = options.listenToDocument ?? createDocumentListener(options);
  const loadSidebarResizeHost = createWorkspaceShellInteractionSidebarResizeHostLoader({
    options: {
      ...options,
      listenToDocument,
    },
  });

  return new WorkspaceShellInteractionSidebarResizeLazyDelegateController({
    listenToDocument,
    loadSidebarResizeHost,
    warn: options.warn,
  });
}

export function loadWorkspaceShellInteractionSidebarResizeHost(
  options: WorkspaceShellInteractionSidebarResizeHostOptions,
): Promise<WorkspaceShellInteractionSidebarResizeDelegate> {
  return createWorkspaceShellInteractionSidebarResizeHostLoader({
    options: {
      ...options,
      listenToDocument: options.listenToDocument ?? createDocumentListener(options),
    },
  })();
}

function createDocumentListener(
  options: WorkspaceShellInteractionSidebarResizeHostOptions,
): (eventName: string, listener: EventListener) => () => void {
  return (eventName, listener) => {
    const targetDocument = options.getDocument?.()
      ?? (typeof document === 'undefined' ? undefined : document);
    if (!targetDocument) {
      return () => undefined;
    }

    targetDocument.addEventListener(eventName, listener);
    return () => targetDocument.removeEventListener(eventName, listener);
  };
}
