import { describe, expect, it, vi } from 'vitest';

interface CriticalFeatureFlagsDelegate {
  validate(): void;
}

interface DelegateLoaderControllerOptions {
  loadDelegate: () => Promise<CriticalFeatureFlagsDelegate>;
  warn: (message: string, error: unknown) => void;
}

interface DelegateLoaderController {
  validate(): void;
}

type DelegateLoaderControllerConstructor = new (
  options: DelegateLoaderControllerOptions,
) => DelegateLoaderController;

async function loadController(): Promise<DelegateLoaderControllerConstructor> {
  const modulePath = './workspace-shell-critical-feature-flags-delegate-loader.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellCriticalFeatureFlagsDelegateLoaderController',
  ) as DelegateLoaderControllerConstructor | undefined;

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

describe('WorkspaceShellCriticalFeatureFlagsDelegateLoaderController', () => {
  it('loads lazily, shares the pending load, and reuses the resolved delegate', async () => {
    const Controller = await loadController();
    const deferred = createDeferred<CriticalFeatureFlagsDelegate>();
    const delegate = { validate: vi.fn() };
    const loadDelegate = vi.fn(() => deferred.promise);
    const controller = new Controller({ loadDelegate, warn: vi.fn() });

    expect(loadDelegate).not.toHaveBeenCalled();

    controller.validate();
    controller.validate();
    expect(loadDelegate).toHaveBeenCalledTimes(1);

    deferred.resolve(delegate);
    await vi.waitFor(() => expect(delegate.validate).toHaveBeenCalledTimes(2));

    controller.validate();
    await vi.waitFor(() => expect(delegate.validate).toHaveBeenCalledTimes(3));
    expect(loadDelegate).toHaveBeenCalledTimes(1);
  });

  it('warns, clears a rejected load, and retries on the next validation', async () => {
    const Controller = await loadController();
    const failure = new Error('load failed');
    const delegate = { validate: vi.fn() };
    const loadDelegate = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(delegate);
    const warn = vi.fn();
    const controller = new Controller({ loadDelegate, warn });

    controller.validate();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '关键安全开关 lazy-load delegate 加载失败，已跳过本次启动校验',
      failure,
    ));

    controller.validate();
    await vi.waitFor(() => expect(delegate.validate).toHaveBeenCalledTimes(1));
    expect(loadDelegate).toHaveBeenCalledTimes(2);
  });

  it('converts synchronous load failures to the retry path', async () => {
    const Controller = await loadController();
    const failure = new Error('load threw');
    const delegate = { validate: vi.fn() };
    const loadDelegate = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValueOnce(delegate);
    const warn = vi.fn();
    const controller = new Controller({ loadDelegate, warn });

    expect(() => controller.validate()).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '关键安全开关 lazy-load delegate 加载失败，已跳过本次启动校验',
      failure,
    ));

    controller.validate();
    await vi.waitFor(() => expect(delegate.validate).toHaveBeenCalledTimes(1));
  });

  it('isolates warning sink failures without blocking a later retry', async () => {
    const Controller = await loadController();
    const delegate = { validate: vi.fn() };
    const loadDelegate = vi.fn()
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValueOnce(delegate);
    const controller = new Controller({
      loadDelegate,
      warn: () => {
        throw new Error('warning sink failed');
      },
    });

    controller.validate();
    await vi.waitFor(() => expect(loadDelegate).toHaveBeenCalledTimes(1));

    controller.validate();
    await vi.waitFor(() => expect(delegate.validate).toHaveBeenCalledTimes(1));
  });

  it('isolates delegate validation failures and keeps the loaded delegate', async () => {
    const Controller = await loadController();
    const delegate = {
      validate: vi.fn(() => {
        throw new Error('validation failed');
      }),
    };
    const loadDelegate = vi.fn().mockResolvedValue(delegate);
    const controller = new Controller({ loadDelegate, warn: vi.fn() });

    controller.validate();
    await vi.waitFor(() => expect(delegate.validate).toHaveBeenCalledTimes(1));

    controller.validate();
    await vi.waitFor(() => expect(delegate.validate).toHaveBeenCalledTimes(2));
    expect(loadDelegate).toHaveBeenCalledTimes(1);
  });
});
