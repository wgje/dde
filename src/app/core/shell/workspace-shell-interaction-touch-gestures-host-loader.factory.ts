import type {
  WorkspaceShellTouchGestureControllerLike,
  WorkspaceShellTouchGestureLazyLoadControllerOptions,
} from './workspace-shell-touch-gesture-lazy-load.controller';

type MaybePromise<T> = T | Promise<T>;

export type WorkspaceShellInteractionTouchGesturesHostLike =
  WorkspaceShellTouchGestureControllerLike;

export type WorkspaceShellInteractionTouchGesturesHostFactory =
  () => MaybePromise<WorkspaceShellInteractionTouchGesturesHostLike>;

export type WorkspaceShellInteractionTouchGesturesHostOptions =
  Omit<
    WorkspaceShellTouchGestureLazyLoadControllerOptions,
    'createTouchGestureController' | 'warn'
  > & {
    warn: (message: string, error: unknown) => void;
    createTouchGesturesHost?: WorkspaceShellInteractionTouchGesturesHostFactory;
  };

export interface WorkspaceShellInteractionTouchGesturesHostLoaderOptions {
  readonly options: WorkspaceShellTouchGestureLazyLoadControllerOptions;
  readonly createTouchGesturesHost?: WorkspaceShellInteractionTouchGesturesHostFactory;
}

export function createWorkspaceShellInteractionTouchGesturesHostLoader(
  loaderOptions: WorkspaceShellInteractionTouchGesturesHostLoaderOptions,
): () => Promise<WorkspaceShellInteractionTouchGesturesHostLike> {
  const createTouchGesturesHost = loaderOptions.createTouchGesturesHost;
  if (createTouchGesturesHost) {
    return () => Promise.resolve()
      .then(() => createTouchGesturesHost())
      .then(host => {
        if (!host) {
          throw new Error('Touch gestures host loader returned no host');
        }

        return host;
      });
  }

  return () => import('./workspace-shell-touch-gesture-lazy-load.controller')
    .then(({ WorkspaceShellTouchGestureLazyLoadController }) =>
      new WorkspaceShellTouchGestureLazyLoadController(loaderOptions.options));
}
