import {
  WorkspaceShellLazyLifecycleHostController,
  type WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';

export interface WorkspaceShellLazyLifecycleServiceHostOptions<
  TService extends WorkspaceShellLazyLifecycleDelegate,
> {
  destroyed: () => boolean;
  initializeFailureMessage: string;
  loadService: () => Promise<TService>;
  teardownFailureMessage: string;
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellLazyLifecycleServiceHost<
  TService extends WorkspaceShellLazyLifecycleDelegate,
>(
  options: WorkspaceShellLazyLifecycleServiceHostOptions<TService>,
): WorkspaceShellLazyLifecycleHostController {
  return new WorkspaceShellLazyLifecycleHostController({
    createController: () => options.loadService()
      .then(service => createLifecycleDelegate(service, options)),
    initializeFailureMessage: options.initializeFailureMessage,
    initializeMode: 'latest-only',
    teardownFailureMessage: options.teardownFailureMessage,
    warn: options.warn,
  });
}

function createLifecycleDelegate<TService extends WorkspaceShellLazyLifecycleDelegate>(
  service: TService,
  options: Pick<
    WorkspaceShellLazyLifecycleServiceHostOptions<TService>,
    'destroyed' | 'teardownFailureMessage' | 'warn'
  >,
): WorkspaceShellLazyLifecycleDelegate {
  return {
    initialize: () => {
      if (options.destroyed()) {
        teardownServiceSafely(service, options.teardownFailureMessage, options.warn);
        return;
      }

      service.initialize();
    },
    teardown: () => service.teardown(),
  };
}

function teardownServiceSafely(
  service: WorkspaceShellLazyLifecycleDelegate,
  failureMessage: string,
  warn: (message: string, error: unknown) => void,
): void {
  try {
    void Promise.resolve(service.teardown())
      .catch(error => warnSafely(warn, failureMessage, error));
  } catch (error) {
    warnSafely(warn, failureMessage, error);
  }
}

function warnSafely(
  warn: (message: string, error: unknown) => void,
  message: string,
  error: unknown,
): void {
  try {
    warn(message, error);
  } catch {
    // Warning sinks must not break destroyed-before-load cleanup.
  }
}
