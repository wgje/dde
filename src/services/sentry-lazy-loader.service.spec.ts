import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { environment } from '../environments/environment';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';

type MutableService = SentryLazyLoaderService & {
  pendingEvents: Array<Record<string, unknown>>;
  pendingUser: { id: string; email?: string } | null;
  sentryModule: { set: (value: unknown) => void };
  flushPendingEvents: () => void;
};

type ScopeMock = {
  setLevel: ReturnType<typeof vi.fn>;
  setTag: ReturnType<typeof vi.fn>;
  setExtra: ReturnType<typeof vi.fn>;
  setFingerprint: ReturnType<typeof vi.fn>;
};

const createScopeMock = (): ScopeMock => ({
  setLevel: vi.fn(),
  setTag: vi.fn(),
  setExtra: vi.fn(),
  setFingerprint: vi.fn(),
});

const createSentryMock = (scope: ScopeMock) => ({
  init: vi.fn(),
  browserTracingIntegration: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((callback: (mockScope: ScopeMock) => void) => callback(scope)),
  setTag: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
  setExtra: vi.fn(),
  addBreadcrumb: vi.fn(),
  setMeasurement: vi.fn(),
});

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('SentryLazyLoaderService', () => {
  let service: SentryLazyLoaderService;
  const originalDsn = environment.SENTRY_DSN;

  beforeEach(() => {
    localStorage.clear();
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = 'https://dsn.example.invalid/1';
    service = new SentryLazyLoaderService();
    vi.spyOn(service, 'triggerLazyInit').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = originalDsn;
  });

  it('captureMessage 在未初始化时应缓存为 message 事件', () => {
    service.captureMessage('性能告警: FCP 超出阈值', { level: 'warning' });

    const pendingEvents = (service as MutableService).pendingEvents;
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]).toMatchObject({
      type: 'message',
      message: '性能告警: FCP 超出阈值',
    });
    expect('error' in pendingEvents[0]).toBe(false);
  });

  it('flushPendingEvents 应将缓存消息按 message 发送而非 exception', () => {
    service.captureMessage('性能告警: FCP 超出阈值', {
      level: 'warning',
      tags: { 'web-vital': 'FCP' },
    });

    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    (service as MutableService).sentryModule.set(sentryMock);

    (service as MutableService).flushPendingEvents();

    expect(sentryMock.captureMessage).toHaveBeenCalledWith('性能告警: FCP 超出阈值');
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(scope.setExtra).toHaveBeenCalledWith('delayedCapture', true);
    expect(scope.setExtra).toHaveBeenCalledWith('captureDelay', expect.any(Number));
    expect((service as MutableService).pendingEvents).toHaveLength(0);
  });

  it('flushPendingEvents 应保持异常事件仍走 captureException', () => {
    const error = new Error('sync failed');
    service.captureException(error, { operation: 'sync' });

    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    (service as MutableService).sentryModule.set(sentryMock);

    (service as MutableService).flushPendingEvents();

    expect(sentryMock.captureException).toHaveBeenCalledWith(error);
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect(scope.setExtra).toHaveBeenCalledWith('operation', 'sync');
    expect(scope.setExtra).toHaveBeenCalledWith('delayedCapture', true);
  });

  it('挂起窗口内 captureMessage 不应立即发送到 Sentry', () => {
    vi.useFakeTimers();
    setVisibilityState('hidden');

    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    (service as MutableService).sentryModule.set(sentryMock);

    service.captureMessage('resume warning', { level: 'warning' });

    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect((service as MutableService).pendingEvents).toHaveLength(1);

    vi.useRealTimers();
    setVisibilityState('visible');
  });

  it('恢复可见后应在 grace 窗口结束后冲刷挂起期间的消息', async () => {
    vi.useFakeTimers();
    setVisibilityState('hidden');

    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    (service as MutableService).sentryModule.set(sentryMock);

    service.captureMessage('resume warning', { level: 'warning' });

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1800);

    expect(sentryMock.captureMessage).toHaveBeenCalledWith('resume warning');
    expect((service as MutableService).pendingEvents).toHaveLength(0);

    vi.useRealTimers();
  });
});

describe('SentryLazyLoaderService triggerLazyInit', () => {
  it('缺少 DSN 时默认静默，不向控制台输出噪音', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    (environment as { SENTRY_DSN: string }).SENTRY_DSN = '';
    const service = new SentryLazyLoaderService();

    service.triggerLazyInit();
    service.triggerLazyInit();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('缺少 DSN 时不再缓存待发送事件', () => {
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = '';
    const disabledService = new SentryLazyLoaderService();

    disabledService.captureMessage('should be dropped');
    disabledService.captureException(new Error('should also be dropped'));

    expect((disabledService as MutableService).pendingEvents).toHaveLength(0);
  });

  it('verbose 模式下缺少 DSN 仅输出一次诊断信息', () => {
    localStorage.setItem('nanoflow.verbose', 'true');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    (environment as { SENTRY_DSN: string }).SENTRY_DSN = '';
    const service = new SentryLazyLoaderService();

    service.triggerLazyInit();
    service.triggerLazyInit();

    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SentryLazyLoaderService setUser', () => {
  let service: SentryLazyLoaderService;
  const originalDsn = environment.SENTRY_DSN;

  beforeEach(() => {
    localStorage.clear();
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = 'https://dsn.example.invalid/1';
    service = new SentryLazyLoaderService();
    vi.spyOn(service, 'triggerLazyInit').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = originalDsn;
  });

  it('Sentry 已初始化时直接调用 setUser', () => {
    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    (service as MutableService).sentryModule.set(sentryMock);

    service.setUser({ id: 'user-123', email: 'test@example.com' });

    expect(sentryMock.setUser).toHaveBeenCalledWith({ id: 'user-123', email: 'test@example.com' });
  });

  it('Sentry 未初始化时缓存用户信息', () => {
    service.setUser({ id: 'user-456', email: 'cached@example.com' });

    expect((service as MutableService).pendingUser).toEqual({
      id: 'user-456',
      email: 'cached@example.com',
    });
  });

  it('setUser(null) 清除缓存的用户信息', () => {
    service.setUser({ id: 'user-789' });
    expect((service as MutableService).pendingUser).not.toBeNull();

    service.setUser(null);
    expect((service as MutableService).pendingUser).toBeNull();
  });

  it('Sentry 已初始化时 setUser(null) 直接清除', () => {
    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    (service as MutableService).sentryModule.set(sentryMock);

    service.setUser(null);

    expect(sentryMock.setUser).toHaveBeenCalledWith(null);
  });
});
