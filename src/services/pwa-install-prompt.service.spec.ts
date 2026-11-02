import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaInstallPromptService } from './pwa-install-prompt.service';
import { LoggerService } from './logger.service';
import { FEATURE_FLAGS } from '../config/feature-flags.config';

const DISMISSED_KEY = 'nanoflow.pwa-install.dismissed';

interface MockBeforeInstallPromptEvent {
  preventDefault: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

describe('PwaInstallPromptService', () => {
  let service: PwaInstallPromptService;
  const destroyCallbacks: Array<() => void> = [];
  const originalFlag = FEATURE_FLAGS.PWA_INSTALL_PROMPT_V1;
  const originalNativeFlag = FEATURE_FLAGS.PWA_NATIVE_INSTALL_PROMPT_V1;
  let matchMediaMatches: boolean;
  let matchMediaList: MediaQueryList;

  const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
    onDestroy: (cb: () => void) => {
      destroyCallbacks.push(cb);
      return () => {
        const index = destroyCallbacks.indexOf(cb);
        if (index >= 0) {
          destroyCallbacks.splice(index, 1);
        }
      };
    },
  };

  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };

  function createService(
    loggerProvider: Pick<LoggerService, 'category'> = mockLogger as unknown as Pick<LoggerService, 'category'>,
  ): PwaInstallPromptService {
    const injector = Injector.create({
      providers: [
        { provide: PwaInstallPromptService, useClass: PwaInstallPromptService },
        { provide: LoggerService, useValue: loggerProvider },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });
    return runInInjectionContext(injector, () => injector.get(PwaInstallPromptService));
  }

  function cleanupService(target = service): void {
    (target as unknown as { cleanup: () => void }).cleanup();
  }

  function emitBeforeInstallPrompt(
    overrides: Partial<MockBeforeInstallPromptEvent> = {},
  ): MockBeforeInstallPromptEvent {
    const addSpy = vi.spyOn(window, 'addEventListener');
    service.initialize();

    const handler = addSpy.mock.calls.find((call) => call[0] === 'beforeinstallprompt')?.[1] as
      | ((event: Event) => void)
      | undefined;
    if (!handler) {
      throw new Error('beforeinstallprompt listener not registered');
    }

    const event: MockBeforeInstallPromptEvent = {
      preventDefault: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
      ...overrides,
    };

    handler(event as unknown as Event);
    return event;
  }

  beforeEach(() => {
    destroyCallbacks.length = 0;
    localStorage.removeItem(DISMISSED_KEY);
    matchMediaMatches = false;
    matchMediaList = {
      get matches() { return matchMediaMatches; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;

    // 模拟 matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation(
      () => matchMediaList,
    );

    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_INSTALL_PROMPT_V1 = true;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_NATIVE_INSTALL_PROMPT_V1 = false;
    service = createService();
  });

  afterEach(() => {
    // 先触发清理回调（移除事件监听器），避免 PollutionGuard 警告
    cleanupService();
    destroyCallbacks.forEach((cb) => cb());
    destroyCallbacks.length = 0;
    localStorage.removeItem(DISMISSED_KEY);
    vi.restoreAllMocks();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_INSTALL_PROMPT_V1 = originalFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_NATIVE_INSTALL_PROMPT_V1 = originalNativeFlag;
  });

  // --- 初始化 ---

  it('initialize 应设置 beforeinstallprompt 和 appinstalled 监听器', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    service.initialize();

    expect(addSpy).toHaveBeenCalledWith('beforeinstallprompt', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('appinstalled', expect.any(Function));
  });

  it('重复调用 initialize 应幂等', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    service.initialize();
    service.initialize();

    const beforeInstallCalls = addSpy.mock.calls.filter((c) => c[0] === 'beforeinstallprompt');
    expect(beforeInstallCalls.length).toBe(1);
  });

  it('display-mode 监听注册失败时应回滚窗口监听并允许重试初始化', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    vi.mocked(matchMediaList.addEventListener)
      .mockImplementationOnce(() => {
        throw new Error('display mode listener registration failed');
      })
      .mockImplementationOnce(() => undefined);

    expect(() => service.initialize()).toThrow('display mode listener registration failed');

    expect(removeSpy).toHaveBeenCalledWith('beforeinstallprompt', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('appinstalled', expect.any(Function));
    expect((service as unknown as { beforeInstallPromptHandler: unknown }).beforeInstallPromptHandler).toBeNull();
    expect((service as unknown as { appInstalledHandler: unknown }).appInstalledHandler).toBeNull();
    expect((service as unknown as { displayModeHandler: unknown }).displayModeHandler).toBeNull();
    expect((service as unknown as { initialized: boolean }).initialized).toBe(false);

    expect(() => service.initialize()).not.toThrow();
    expect(addSpy.mock.calls.filter(call => call[0] === 'beforeinstallprompt')).toHaveLength(2);
    expect(addSpy.mock.calls.filter(call => call[0] === 'appinstalled')).toHaveLength(2);
  });

  // --- beforeinstallprompt 事件 ---

  it('捕获 beforeinstallprompt 事件后 canInstall 应为 true', () => {
    emitBeforeInstallPrompt();

    expect(service.canInstall()).toBe(true);
  });

  it('原生提示模式下 beforeinstallprompt 不应被拦截，也不应暴露自定义安装入口', () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_NATIVE_INSTALL_PROMPT_V1 = true;
    service = createService();

    const event = emitBeforeInstallPrompt();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(service.canInstall()).toBe(false);
    expect(service.canShowInstallPrompt()).toBe(true);
    expect(service.installHint()).toContain('浏览器地址栏');
  });

  it('缺少 prompt/userChoice 的事件应被忽略', () => {
    service.initialize();

    const event = new Event('beforeinstallprompt');
    window.dispatchEvent(event);

    expect(service.canInstall()).toBe(false);
  });

  // --- promptInstall ---

  it('无 deferredPrompt 时 promptInstall 应返回 false', async () => {
    service.initialize();
    const result = await service.promptInstall();
    expect(result).toBe(false);
  });

  it('用户接受安装后 promptInstall 应返回 true 并清除 canInstall', async () => {
    const promptFn = vi.fn().mockResolvedValue(undefined);
    emitBeforeInstallPrompt({
      prompt: promptFn,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });

    const result = await service.promptInstall();
    expect(result).toBe(true);
    expect(promptFn).toHaveBeenCalled();
    expect(service.canInstall()).toBe(false);
  });

  it('用户拒绝安装后 promptInstall 应返回 false 且保留 canInstall', async () => {
    emitBeforeInstallPrompt({
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
    });

    const result = await service.promptInstall();
    expect(result).toBe(false);
    expect(service.canInstall()).toBe(true);
  });

  it('prompt 抛出异常时 promptInstall 应返回 false', async () => {
    emitBeforeInstallPrompt({
      prompt: vi.fn().mockRejectedValue(new Error('test')),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });

    const result = await service.promptInstall();
    expect(result).toBe(false);
  });

  it('prompt 抛出且 warn 日志失败时 promptInstall 仍应返回 false', async () => {
    cleanupService();
    const loggerMethods = {
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
      error: vi.fn(),
      debug: vi.fn(),
    };
    service = createService({ category: () => loggerMethods } as unknown as Pick<LoggerService, 'category'>);
    emitBeforeInstallPrompt({
      prompt: vi.fn().mockRejectedValue(new Error('prompt failed')),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });

    await expect(service.promptInstall()).resolves.toBe(false);
    expect(loggerMethods.warn).toHaveBeenCalledWith('安装提示调用失败', expect.any(Error));
  });

  it('promptInstall 过程中 appinstalled 清空全局 deferredPrompt 时仍应按当前事件结果完成', async () => {
    let resolvePrompt!: () => void;
    const promptPromise = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    const promptFn = vi.fn().mockReturnValue(promptPromise);
    emitBeforeInstallPrompt({
      prompt: promptFn,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });

    const resultPromise = service.promptInstall();
    window.dispatchEvent(new Event('appinstalled'));
    resolvePrompt();

    await expect(resultPromise).resolves.toBe(true);
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(service.canInstall()).toBe(false);
  });

  // --- dismissPrompt / resetDismissedPrompt ---

  it('dismissPrompt 应写入 localStorage 并更新 dismissedSignal', () => {
    service.dismissPrompt();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('true');
  });

  it('resetDismissedPrompt 应清除 localStorage 标记', () => {
    service.dismissPrompt();
    service.resetDismissedPrompt();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('false');
  });

  // --- canShowInstallPrompt ---

  it('功能开关关闭时 canShowInstallPrompt 应为 false', () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_INSTALL_PROMPT_V1 = false;
    emitBeforeInstallPrompt();

    expect(service.canShowInstallPrompt()).toBe(false);
  });

  it('已关闭提示后 canShowInstallPrompt 应为 false', () => {
    emitBeforeInstallPrompt();

    service.dismissPrompt();
    expect(service.canShowInstallPrompt()).toBe(false);
  });

  it('已在 standalone 模式下 canShowInstallPrompt 应为 false', () => {
    matchMediaMatches = true;
    // 重新创建服务以读取新的 standalone 状态
    service = createService();
    service.initialize();

    expect(service.canShowInstallPrompt()).toBe(false);
  });

  // --- installHint ---

  it('canInstall 时 installHint 应提示一键安装', () => {
    emitBeforeInstallPrompt();

    expect(service.installHint()).toContain('一键安装');
  });

  it('默认 installHint 应提示桌面/主屏安装', () => {
    expect(service.installHint()).toContain('桌面');
  });

  // --- appinstalled 事件 ---

  it('appinstalled 事件应清除 canInstall 并标记 standalone', () => {
    emitBeforeInstallPrompt();
    expect(service.canInstall()).toBe(true);

    // 触发 appinstalled
    window.dispatchEvent(new Event('appinstalled'));

    expect(service.canInstall()).toBe(false);
    expect(service.isStandaloneMode()).toBe(true);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('true');
  });

  it('appinstalled 日志失败时仍应清除安装状态并写入 dismissed 标记', () => {
    cleanupService();
    const loggerMethods = {
      info: vi.fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error('logger unavailable');
        }),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    service = createService({ category: () => loggerMethods } as unknown as Pick<LoggerService, 'category'>);
    emitBeforeInstallPrompt();
    expect(service.canInstall()).toBe(true);

    expect(() => window.dispatchEvent(new Event('appinstalled'))).not.toThrow();

    expect(loggerMethods.info).toHaveBeenCalledWith('PWA 安装完成');
    expect(service.canInstall()).toBe(false);
    expect(service.isStandaloneMode()).toBe(true);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('true');
  });

  // --- cleanup ---

  it('cleanup 后应可安全再次 initialize', () => {
    service.initialize();

    cleanupService();

    // 重新初始化应不抛异常，说明清理已正确重置状态
    expect(() => service.initialize()).not.toThrow();
  });

  it('cleanup 后 beforeinstallprompt 事件不应影响已清理的服务', () => {
    emitBeforeInstallPrompt();
    expect(service.canInstall()).toBe(true);

    // 清理
    cleanupService();

    // 旧服务状态不影响新行为
    expect(() => service.initialize()).not.toThrow();
  });

  it('cleanup 应移除窗口和 display-mode 监听器，后续事件不再更新状态', () => {
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
    service.initialize();

    cleanupService();

    expect(windowRemoveSpy).toHaveBeenCalledWith('beforeinstallprompt', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('appinstalled', expect.any(Function));
    expect(matchMediaList.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    const event = new Event('beforeinstallprompt');
    Object.assign(event, {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
    });
    window.dispatchEvent(event);
    window.dispatchEvent(new Event('appinstalled'));

    expect(service.canInstall()).toBe(false);
    expect(service.isStandaloneMode()).toBe(false);
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it('cleanup 移除单个监听失败时仍应移除其余监听并允许重新初始化', () => {
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('remove listener failed');
      })
      .mockImplementation((...args: Parameters<typeof window.removeEventListener>) => {
        originalRemoveEventListener(...args);
      });
    service.initialize();

    expect(() => cleanupService()).not.toThrow();

    expect(windowRemoveSpy).toHaveBeenCalledWith('beforeinstallprompt', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('appinstalled', expect.any(Function));
    expect(matchMediaList.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect((service as unknown as { beforeInstallPromptHandler: unknown }).beforeInstallPromptHandler).toBeNull();
    expect((service as unknown as { appInstalledHandler: unknown }).appInstalledHandler).toBeNull();
    expect((service as unknown as { displayModeHandler: unknown }).displayModeHandler).toBeNull();

    const event = new Event('beforeinstallprompt');
    Object.assign(event, {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
    });
    window.dispatchEvent(event);
    window.dispatchEvent(new Event('appinstalled'));

    expect(service.canInstall()).toBe(false);
    expect(service.isStandaloneMode()).toBe(false);
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
    expect(() => service.initialize()).not.toThrow();
  });

  // --- localStorage 持久化 ---

  it('构造时应从 localStorage 恢复 dismissed 状态', () => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    const svc = createService();

    // 即使有 canInstall，dismissed 应阻止显示
    expect(svc.canShowInstallPrompt()).toBe(false);
  });
});
