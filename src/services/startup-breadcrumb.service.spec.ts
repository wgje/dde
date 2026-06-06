import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StartupBreadcrumbService } from './startup-breadcrumb.service';

type StartupBreadcrumbPrivate = {
  initialize: () => void;
  sentryLazyLoader: { addBreadcrumb: ReturnType<typeof vi.fn> };
};

function createContext(): StartupBreadcrumbPrivate {
  const context = Object.create(StartupBreadcrumbService.prototype) as StartupBreadcrumbPrivate;
  context.sentryLazyLoader = { addBreadcrumb: vi.fn() };
  return context;
}

describe('StartupBreadcrumbService', () => {
  beforeEach(() => {
    delete (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__;
  });

  afterEach(() => {
    delete (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__;
  });

  it('initialize 应记录预加载与 modulepreload 模式的启动 breadcrumb', () => {
    const context = createContext();

    context.initialize();

    const messages = context.sentryLazyLoader.addBreadcrumb.mock.calls.map(
      ([crumb]: [{ message: string }]) => crumb.message,
    );
    expect(messages).toContain('startup.preload.disabled');
    expect(messages.some((m: string) => m.startsWith('startup.modulepreload.'))).toBe(true);
  });

  it('preload 显式启用时应记录 enabled breadcrumb', () => {
    const context = createContext();
    (window as { __NANOFLOW_PRELOAD_DISABLED__?: boolean }).__NANOFLOW_PRELOAD_DISABLED__ = false;

    context.initialize();

    const messages = context.sentryLazyLoader.addBreadcrumb.mock.calls.map(
      ([crumb]: [{ message: string }]) => crumb.message,
    );
    expect(messages).toContain('startup.preload.enabled');
  });
});
