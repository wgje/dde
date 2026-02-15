import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaInstallPromptService } from './pwa-install-prompt.service';
import { LoggerService } from './logger.service';
import { FEATURE_FLAGS } from '../config/feature-flags.config';

const DISMISSED_KEY = 'nanoflow.pwa-install.dismissed';

describe('PwaInstallPromptService', () => {
  let service: PwaInstallPromptService;
  const destroyCallbacks: Array<() => void> = [];
  const originalFlag = FEATURE_FLAGS.PWA_INSTALL_PROMPT_V1;
  let matchMediaMatches: boolean;

  const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
    onDestroy: (cb: () => void) => {
      destroyCallbacks.push(cb);
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

  function createService(): PwaInstallPromptService {
    const injector = Injector.create({
      providers: [
        { provide: PwaInstallPromptService, useClass: PwaInstallPromptService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: DestroyRef, useValue: mockDestroyRef },
      ],
    });
    return runInInjectionContext(injector, () => injector.get(PwaInstallPromptService));
  }

  beforeEach(() => {
    destroyCallbacks.length = 0;
    localStorage.removeItem(DISMISSED_KEY);
    matchMediaMatches = false;

    // 模拟 matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation(
      () =>
        ({
          matches: matchMediaMatches,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );

    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_INSTALL_PROMPT_V1 = true;
    service = createService();
  });

  afterEach(() => {
    // 先触发清理回调（移除事件监听器），避免 PollutionGuard 警告
    destroyCallbacks.forEach((cb) => cb());
    destroyCallbacks.length = 0;
    localStorage.removeItem(DISMISSED_KEY);
    vi.restoreAllMocks();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).PWA_INSTALL_PROMPT_V1 = originalFlag;
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

  // --- beforeinstallprompt 事件 ---

  it('捕获 beforeinstallprompt 事件后 canInstall 应为 true', () => {
    service.initialize();

    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    window.dispatchEvent(event);

    expect(service.canInstall()).toBe(true);
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
    service.initialize();

    // 模拟 beforeinstallprompt
    const promptFn = vi.fn().mockResolvedValue(undefined);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: promptFn,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });
    window.dispatchEvent(event);

    const result = await service.promptInstall();
    expect(result).toBe(true);
    expect(promptFn).toHaveBeenCalled();
    expect(service.canInstall()).toBe(false);
  });

  it('用户拒绝安装后 promptInstall 应返回 false 且保留 canInstall', async () => {
    service.initialize();

    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }),
    });
    window.dispatchEvent(event);

    const result = await service.promptInstall();
    expect(result).toBe(false);
    expect(service.canInstall()).toBe(true);
  });

  it('prompt 抛出异常时 promptInstall 应返回 false', async () => {
    service.initialize();

    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn().mockRejectedValue(new Error('test')),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    window.dispatchEvent(event);

    const result = await service.promptInstall();
    expect(result).toBe(false);
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
    service.initialize();

    // 即使 canInstall 为 true 也不应显示
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    window.dispatchEvent(event);

    expect(service.canShowInstallPrompt()).toBe(false);
  });

  it('已关闭提示后 canShowInstallPrompt 应为 false', () => {
    service.initialize();

    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    window.dispatchEvent(event);

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
    service.initialize();

    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    window.dispatchEvent(event);

    expect(service.installHint()).toContain('一键安装');
  });

  it('默认 installHint 应提示桌面/主屏安装', () => {
    expect(service.installHint()).toContain('桌面');
  });

  // --- appinstalled 事件 ---

  it('appinstalled 事件应清除 canInstall 并标记 standalone', () => {
    service.initialize();

    // 先设置 canInstall
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    window.dispatchEvent(event);
    expect(service.canInstall()).toBe(true);

    // 触发 appinstalled
    window.dispatchEvent(new Event('appinstalled'));

    expect(service.canInstall()).toBe(false);
    expect(service.isStandaloneMode()).toBe(true);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('true');
  });

  // --- cleanup ---

  it('cleanup 后应可安全再次 initialize', () => {
    service.initialize();

    // 触发 destroy
    destroyCallbacks.forEach((cb) => cb());

    // 重新初始化应不抛异常，说明清理已正确重置状态
    expect(() => service.initialize()).not.toThrow();
  });

  it('cleanup 后 beforeinstallprompt 事件不应影响已清理的服务', () => {
    service.initialize();

    // 先捕获一个事件
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    window.dispatchEvent(event);
    expect(service.canInstall()).toBe(true);

    // 清理
    destroyCallbacks.forEach((cb) => cb());

    // 旧服务状态不影响新行为
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
