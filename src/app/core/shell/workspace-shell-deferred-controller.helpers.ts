export interface WorkspaceShellDeferredControllerOptions {
  actionFailureMessage?: string;
  failureMessage: string;
  teardownFailureMessage?: string;
  warn: (message: string, error: unknown) => void;
}

interface WorkspaceShellDeferredControllerState<TController extends object> {
  controller: TController | null;
  controllerPromise: Promise<TController> | null;
  isTornDown: boolean;
}

export function createWorkspaceShellDeferredController<TController extends object>(
  createController: () => Promise<TController>,
  options: WorkspaceShellDeferredControllerOptions,
): TController {
  const state: WorkspaceShellDeferredControllerState<TController> = {
    controller: null,
    controllerPromise: null,
    isTornDown: false,
  };

  return new Proxy({}, createDeferredControllerProxyHandler(
    createController,
    options,
    state,
  )) as TController;
}

function createDeferredControllerProxyHandler<TController extends object>(
  createController: () => Promise<TController>,
  options: WorkspaceShellDeferredControllerOptions,
  state: WorkspaceShellDeferredControllerState<TController>,
): ProxyHandler<object> {
  return {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === 'teardown') {
        return () => teardownDeferredController(state, options);
      }

      return (...args: unknown[]) => callDeferredControllerMember(
        property,
        args,
        createController,
        options,
        state,
      );
    },
  };
}

function resolveDeferredController<TController extends object>(
  createController: () => Promise<TController>,
  state: WorkspaceShellDeferredControllerState<TController>,
): Promise<TController> {
  if (state.controller) {
    return Promise.resolve(state.controller);
  }

  return (state.controllerPromise ??= createDeferredControllerSafely(createController)
    .then(resolvedController => {
      if (!state.isTornDown) {
        state.controller = resolvedController;
      }
      return resolvedController;
    })
    .catch(error => {
      state.controllerPromise = null;
      throw error;
    }));
}

function createDeferredControllerSafely<TController extends object>(
  createController: () => Promise<TController>,
): Promise<TController> {
  try {
    return Promise.resolve(createController());
  } catch (error) {
    return Promise.reject(error);
  }
}

function callDeferredControllerMember<TController extends object>(
  property: string | symbol,
  args: unknown[],
  createController: () => Promise<TController>,
  options: WorkspaceShellDeferredControllerOptions,
  state: WorkspaceShellDeferredControllerState<TController>,
): Promise<unknown> {
  if (state.isTornDown) {
    return Promise.resolve(undefined);
  }

  return resolveDeferredController(createController, state)
    .catch(error => {
      warn(options, options.failureMessage, error);
      return null;
    })
    .then(resolvedController => {
      if (!resolvedController || state.isTornDown) return undefined;

      const member = Reflect.get(resolvedController, property);
      if (typeof member !== 'function') return member;

      return Reflect.apply(member, resolvedController, args);
    })
    .catch(error => {
      warn(options, options.actionFailureMessage ?? options.failureMessage, error);
      return undefined;
    });
}

function teardownDeferredController<TController extends object>(
  state: WorkspaceShellDeferredControllerState<TController>,
  options: WorkspaceShellDeferredControllerOptions,
): void {
  if (state.isTornDown) return;

  state.isTornDown = true;
  if (state.controller) {
    try {
      teardownResolvedController(state.controller);
    } catch (error) {
      warn(options, options.teardownFailureMessage ?? options.failureMessage, error);
    }
    return;
  }

  void state.controllerPromise
    ?.then(teardownResolvedController)
    .catch(error => {
      warn(options, options.failureMessage, error);
    });
}

function teardownResolvedController<TController extends object>(
  resolvedController: TController,
): void {
  const teardown = Reflect.get(resolvedController, 'teardown');
  if (typeof teardown === 'function') {
    Reflect.apply(teardown, resolvedController, []);
  }
}

function warn(
  options: WorkspaceShellDeferredControllerOptions,
  message: string,
  error: unknown,
): void {
  try {
    options.warn(message, error);
  } catch {
    // Warning sinks are best-effort and must not break deferred fallback paths.
  }
}
