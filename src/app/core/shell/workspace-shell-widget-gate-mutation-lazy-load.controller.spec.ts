import { describe, expect, it, vi } from 'vitest';

interface WidgetGateMutation {
  intent: 'mark-gate-read';
  widgetGateEntryId: string | null;
}

interface WidgetGateMutationDelegate {
  apply(intent: WidgetGateMutation): Promise<void>;
}

interface LazyLoadControllerOptions {
  loadController: () => Promise<WidgetGateMutationDelegate>;
}

interface LazyLoadController {
  apply(intent: WidgetGateMutation): Promise<void>;
}

type LazyLoadControllerConstructor = new (
  options: LazyLoadControllerOptions,
) => LazyLoadController;

async function loadController(): Promise<LazyLoadControllerConstructor> {
  const modulePath = './workspace-shell-widget-gate-mutation-lazy-load.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellWidgetGateMutationLazyLoadController',
  ) as LazyLoadControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

const firstMutation: WidgetGateMutation = {
  intent: 'mark-gate-read',
  widgetGateEntryId: 'entry-1',
};

const secondMutation: WidgetGateMutation = {
  intent: 'mark-gate-read',
  widgetGateEntryId: 'entry-2',
};

describe('WorkspaceShellWidgetGateMutationLazyLoadController', () => {
  it('loads on the first apply and reuses the resolved controller', async () => {
    const Controller = await loadController();
    const delegate = { apply: vi.fn().mockResolvedValue(undefined) };
    const loadDelegate = vi.fn().mockResolvedValue(delegate);
    const controller = new Controller({ loadController: loadDelegate });

    expect(loadDelegate).not.toHaveBeenCalled();

    await controller.apply(firstMutation);
    await controller.apply(secondMutation);

    expect(loadDelegate).toHaveBeenCalledTimes(1);
    expect(delegate.apply).toHaveBeenNthCalledWith(1, firstMutation);
    expect(delegate.apply).toHaveBeenNthCalledWith(2, secondMutation);
  });

  it('shares a pending load across concurrent apply calls', async () => {
    const Controller = await loadController();
    const deferred = createDeferred<WidgetGateMutationDelegate>();
    const delegate = { apply: vi.fn().mockResolvedValue(undefined) };
    const loadDelegate = vi.fn(() => deferred.promise);
    const controller = new Controller({ loadController: loadDelegate });

    const firstApply = controller.apply(firstMutation);
    const secondApply = controller.apply(secondMutation);

    expect(loadDelegate).toHaveBeenCalledTimes(1);
    expect(delegate.apply).not.toHaveBeenCalled();

    deferred.resolve(delegate);
    await Promise.all([firstApply, secondApply]);

    expect(delegate.apply).toHaveBeenNthCalledWith(1, firstMutation);
    expect(delegate.apply).toHaveBeenNthCalledWith(2, secondMutation);
  });

  it('propagates and reuses a rejected load promise', async () => {
    const Controller = await loadController();
    const failure = new Error('load failed');
    const loadDelegate = vi.fn().mockRejectedValue(failure);
    const controller = new Controller({ loadController: loadDelegate });

    await expect(controller.apply(firstMutation)).rejects.toBe(failure);
    await expect(controller.apply(secondMutation)).rejects.toBe(failure);

    expect(loadDelegate).toHaveBeenCalledTimes(1);
  });

  it('propagates delegate failures without discarding the loaded controller', async () => {
    const Controller = await loadController();
    const failure = new Error('apply failed');
    const delegate = {
      apply: vi.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(undefined),
    };
    const loadDelegate = vi.fn().mockResolvedValue(delegate);
    const controller = new Controller({ loadController: loadDelegate });

    await expect(controller.apply(firstMutation)).rejects.toBe(failure);
    await expect(controller.apply(secondMutation)).resolves.toBeUndefined();

    expect(loadDelegate).toHaveBeenCalledTimes(1);
  });

  it('converts synchronous loader failures to rejections and retries later', async () => {
    const Controller = await loadController();
    const failure = new Error('load threw');
    const delegate = { apply: vi.fn().mockResolvedValue(undefined) };
    const loadDelegate = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValueOnce(delegate);
    const controller = new Controller({ loadController: loadDelegate });

    await expect(controller.apply(firstMutation)).rejects.toBe(failure);
    await expect(controller.apply(secondMutation)).resolves.toBeUndefined();

    expect(loadDelegate).toHaveBeenCalledTimes(2);
  });
});
