import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Injector } from '@angular/core';
import { StartupBreadcrumbService } from './startup-breadcrumb.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

type StartupBreadcrumbPrivate = {
  initialize: () => void;
  teardown: () => void;
  sentryLazyLoader: { addBreadcrumb: ReturnType<typeof vi.fn> };
  listenersAttached: boolean;
};

const contexts: StartupBreadcrumbPrivate[] = [];

function createContext(): StartupBreadcrumbPrivate {
  const sentryLazyLoader = { addBreadcrumb: vi.fn() };
  const injector = Injector.create({
    providers: [
      StartupBreadcrumbService,
      { provide: SentryLazyLoaderService, useValue: sentryLazyLoader },
    ],
  });
  const context = injector.get(StartupBreadcrumbService) as unknown as StartupBreadcrumbPrivate;
  contexts.push(context);
  return context;
}

describe('StartupBreadcrumbService', () => {
  beforeEach(() => {
    delete (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__;
  });

  afterEach(() => {
    for (const context of contexts.splice(0)) {
      context.teardown();
    }
    delete (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__;
  });

  it('initialize 应记录预加载与 modulepreload 模式的启动 breadcrumb', () => {
    const context = createContext();

    context.initialize();

    const messages = context.sentryLazyLoader.addBreadcrumb.mock.calls.map(
      (call) => (call[0] as { message: string }).message,
    );
    expect(messages).toContain('startup.preload.disabled');
    expect(messages.some((m: string) => m.startsWith('startup.modulepreload.'))).toBe(true);
  });

  it('无 window 环境时初始化和销毁应安全退化', () => {
    const context = createContext();
    const originalWindow = globalThis.window;

    try {
      Reflect.deleteProperty(globalThis, 'window');

      expect(() => context.initialize()).not.toThrow();
      expect(() => context.teardown()).not.toThrow();
      expect(context.sentryLazyLoader.addBreadcrumb).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    }
  });

  it('preload 显式启用时应记录 enabled breadcrumb', () => {
    const context = createContext();
    (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__ = false;

    context.initialize();

    const messages = context.sentryLazyLoader.addBreadcrumb.mock.calls.map(
      (call) => (call[0] as { message: string }).message,
    );
    expect(messages).toContain('startup.preload.enabled');
  });

  it('重复 initialize 不应重复记录启动 breadcrumb 或重复注册事件监听', () => {
    const context = createContext();

    context.initialize();
    context.initialize();
    window.dispatchEvent(new CustomEvent('nanoflow:sync-pulse', {
      detail: { status: 'success', reason: 'focus' },
    }));

    const messages = context.sentryLazyLoader.addBreadcrumb.mock.calls.map(
      (call) => (call[0] as { message: string }).message,
    );
    expect(messages.filter((message) => message === 'startup.preload.disabled')).toHaveLength(1);
    expect(messages.filter((message) => message.startsWith('startup.modulepreload.'))).toHaveLength(1);
    expect(messages.filter((message) => message === 'sync.pulse.reason')).toHaveLength(1);
  });

  it('teardown 后再次 initialize 应能重新注册事件监听但不重复启动 breadcrumb', () => {
    const context = createContext();

    context.initialize();
    context.teardown();
    context.initialize();
    window.dispatchEvent(new CustomEvent('nanoflow:flow-restore-status', {
      detail: { mode: 'applied', projectId: 'project-1' },
    }));

    const messages = context.sentryLazyLoader.addBreadcrumb.mock.calls.map(
      (call) => (call[0] as { message: string }).message,
    );
    expect(messages.filter((message) => message === 'startup.preload.disabled')).toHaveLength(1);
    expect(messages.filter((message) => message.startsWith('startup.modulepreload.'))).toHaveLength(1);
    expect(messages.filter((message) => message === 'flow.restore.applied')).toHaveLength(1);
  });

  it('teardown 在 window 消失后仍应重置 listener attached 状态', () => {
    const context = createContext();
    const originalWindow = globalThis.window;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const fakeWindow = {
      addEventListener,
      removeEventListener,
    } as unknown as Window & typeof globalThis;

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: fakeWindow,
      });
      context.initialize();
      expect(context.listenersAttached).toBe(true);
      expect(addEventListener).toHaveBeenCalledTimes(2);

      Reflect.deleteProperty(globalThis, 'window');
      context.teardown();

      expect(context.listenersAttached).toBe(false);
      expect(removeEventListener).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    }
  });

  it('事件 breadcrumb 记录失败不应让全局事件派发抛错', () => {
    const context = createContext();
    context.initialize();
    context.sentryLazyLoader.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('breadcrumb failed');
    });

    expect(() => window.dispatchEvent(new CustomEvent('nanoflow:sync-pulse', {
      detail: { status: 'success', reason: 'focus' },
    }))).not.toThrow();
  });
});
