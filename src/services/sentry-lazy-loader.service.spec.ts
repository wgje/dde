import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { environment } from '../environments/environment';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';

type MutableService = {
  pendingEvents: Array<Record<string, unknown>>;
  pendingUser: { id: string } | null;
  sentryModule: { set: (value: unknown) => void };
  flushPendingEvents: () => void;
  cleanupPendingFlushResume: () => void;
  buildRelease: () => string;
};

/** 绕过 private 访问限制的测试辅助 */
const mut = (s: SentryLazyLoaderService): MutableService => s as unknown as MutableService;
const createdServices: SentryLazyLoaderService[] = [];
const createService = (): SentryLazyLoaderService => {
  const service = new SentryLazyLoaderService();
  createdServices.push(service);
  return service;
};

type SentryLazyLoaderStatic = {
  sanitizeUrlForTelemetry: (rawUrl: string) => string;
  sanitizeTelemetryString: (value: string) => string;
  shouldDropNonActionableSentryEvent: (event: {
    message?: string | null;
    environment?: string | null;
    tags?: Record<string, string | number | boolean | null | undefined> | null;
    extra?: Record<string, unknown> | null;
    request?: { url?: string | null } | null;
    exception?: {
      values?: Array<{
        type?: string | null;
        value?: string | null;
        stacktrace?: { frames?: Array<{ filename?: string | null; absPath?: string | null }> } | null;
      }>;
    } | null;
  }) => boolean;
  redactTelemetryRecord: <T extends Record<string, unknown> | undefined>(record: T) => T;
  sanitizeSentryEventUser: (user: unknown) => unknown;
};

/** 绕过 private static 访问限制，验证 Sentry 隐私清洗合同 */
const sentryStatic = SentryLazyLoaderService as unknown as SentryLazyLoaderStatic;

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

afterEach(() => {
  for (const createdService of createdServices.splice(0)) {
    mut(createdService).cleanupPendingFlushResume();
  }
});

describe('SentryLazyLoaderService', () => {
  let service: SentryLazyLoaderService;
  const originalDsn = environment.SENTRY_DSN;

  beforeEach(() => {
    localStorage.clear();
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = 'https://dsn.example.invalid/1';
    service = createService();
    vi.spyOn(service, 'triggerLazyInit').mockImplementation(() => {});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = originalDsn;
  });

  it('captureMessage 在未初始化时应缓存为 message 事件', () => {
    service.captureMessage('性能告警: FCP 超出阈值', { level: 'warning' });

    const pendingEvents = mut(service).pendingEvents;
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
    mut(service).sentryModule.set(sentryMock);

    mut(service).flushPendingEvents();

    expect(sentryMock.captureMessage).toHaveBeenCalledWith('性能告警: FCP 超出阈值');
    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(scope.setExtra).toHaveBeenCalledWith('delayedCapture', true);
    expect(scope.setExtra).toHaveBeenCalledWith('captureDelay', expect.any(Number));
    expect(mut(service).pendingEvents).toHaveLength(0);
  });

  it('flushPendingEvents 应保持异常事件仍走 captureException', () => {
    const error = new Error('sync failed');
    service.captureException(error, { operation: 'sync' });

    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    mut(service).sentryModule.set(sentryMock);

    mut(service).flushPendingEvents();

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
    mut(service).sentryModule.set(sentryMock);

    service.captureMessage('resume warning', { level: 'warning' });

    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    expect(mut(service).pendingEvents).toHaveLength(1);

    vi.useRealTimers();
    setVisibilityState('visible');
  });

  it('恢复可见后应在 grace 窗口结束后冲刷挂起期间的消息', async () => {
    vi.useFakeTimers();
    setVisibilityState('hidden');

    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    mut(service).sentryModule.set(sentryMock);

    service.captureMessage('resume warning', { level: 'warning' });

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1800);

    expect(sentryMock.captureMessage).toHaveBeenCalledWith('resume warning');
    expect(mut(service).pendingEvents).toHaveLength(0);

    vi.useRealTimers();
  });

  it('pending flush timer id 为 0 时不应重复调度且 cleanup 应清理该 timer', () => {
    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    mut(service).sentryModule.set(sentryMock);
    mut(service).pendingEvents.push({
      type: 'message',
      message: 'resume warning',
      timestamp: Date.now(),
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);

    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    mut(service).cleanupPendingFlushResume();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('DestroyRef 销毁时应移除恢复事件监听器', () => {
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener');
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

    TestBed.configureTestingModule({
      providers: [SentryLazyLoaderService],
    });
    TestBed.inject(SentryLazyLoaderService);

    TestBed.resetTestingModule();

    expect(documentRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('pageshow', expect.any(Function));
  });
});

describe('SentryLazyLoaderService triggerLazyInit', () => {
  it('缺少 DSN 时默认静默，不向控制台输出噪音', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    (environment as { SENTRY_DSN: string }).SENTRY_DSN = '';
    const service = createService();

    service.triggerLazyInit();
    service.triggerLazyInit();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('缺少 DSN 时不再缓存待发送事件', () => {
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = '';
    const disabledService = createService();

    disabledService.captureMessage('should be dropped');
    disabledService.captureException(new Error('should also be dropped'));

    expect(mut(disabledService).pendingEvents).toHaveLength(0);
  });

  it('verbose 模式下缺少 DSN 仅输出一次诊断信息', () => {
    localStorage.setItem('nanoflow.verbose', 'true');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    (environment as { SENTRY_DSN: string }).SENTRY_DSN = '';
    const service = createService();

    service.triggerLazyInit();
    service.triggerLazyInit();

    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SentryLazyLoaderService release', () => {
  const mutableEnvironment = environment as typeof environment & {
    sentryRelease?: string;
    deploymentEpoch?: number | string;
  };
  const originalRelease = mutableEnvironment.sentryRelease;
  const originalDeploymentEpoch = mutableEnvironment.deploymentEpoch;

  afterEach(() => {
    mutableEnvironment.sentryRelease = originalRelease;
    mutableEnvironment.deploymentEpoch = originalDeploymentEpoch;
    delete (document as unknown as { currentScript?: unknown }).currentScript;
    delete (document as unknown as { scripts?: unknown }).scripts;
  });

  it('应优先使用显式注入的 release', () => {
    mutableEnvironment.sentryRelease = 'commit-sha-123';

    const service = createService();

    expect(mut(service).buildRelease()).toBe('nanoflow@commit-sha-123');
  });

  it('缺少显式 release 时应优先使用 main 脚本指纹', () => {
    mutableEnvironment.sentryRelease = '';
    mutableEnvironment.deploymentEpoch = 0;

    const lazyChunkScript = document.createElement('script');
    lazyChunkScript.src = 'https://nanoflow.pages.dev/chunk-45V5LS6K.js';
    const mainScript = document.createElement('script');
    mainScript.src = 'https://nanoflow.pages.dev/main-ABC12345.js';
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      value: lazyChunkScript,
    });
    Object.defineProperty(document, 'scripts', {
      configurable: true,
      value: [lazyChunkScript, mainScript],
    });

    const service = createService();

    expect(mut(service).buildRelease()).toBe('nanoflow@main-ABC12345');
  });
});

describe('SentryLazyLoaderService setUser', () => {
  let service: SentryLazyLoaderService;
  const originalDsn = environment.SENTRY_DSN;

  beforeEach(() => {
    localStorage.clear();
    (environment as { SENTRY_DSN: string }).SENTRY_DSN = 'https://dsn.example.invalid/1';
    service = createService();
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
    mut(service).sentryModule.set(sentryMock);

    service.setUser({ id: 'user-123', email: 'test@example.com' });

    expect(sentryMock.setUser).toHaveBeenCalledWith({ id: 'user-123' });
  });

  it('Sentry 未初始化时缓存用户信息', () => {
    service.setUser({ id: 'user-456', email: 'cached@example.com' });

    expect(mut(service).pendingUser).toEqual({ id: 'user-456' });
  });

  it('setUser(null) 清除缓存的用户信息', () => {
    service.setUser({ id: 'user-789' });
    expect(mut(service).pendingUser).not.toBeNull();

    service.setUser(null);
    expect(mut(service).pendingUser).toBeNull();
  });

  it('Sentry 已初始化时 setUser(null) 直接清除', () => {
    const scope = createScopeMock();
    const sentryMock = createSentryMock(scope);
    mut(service).sentryModule.set(sentryMock);

    service.setUser(null);

    expect(sentryMock.setUser).toHaveBeenCalledWith(null);
  });
});

describe('SentryLazyLoaderService telemetry scrubber', () => {
  it('应丢弃可恢复的 chunk/JIT/NG0750 版本偏移事件', () => {
    expect(sentryStatic.shouldDropNonActionableSentryEvent({
      exception: {
        values: [{ value: 'Failed to fetch dynamically imported module: https://dde-eight.vercel.app/chunk-ABC.js' }],
      },
    })).toBe(true);

    expect(sentryStatic.shouldDropNonActionableSentryEvent({
      exception: {
        values: [{ value: 'JIT compiler unavailable' }],
      },
    })).toBe(true);

    expect(sentryStatic.shouldDropNonActionableSentryEvent({ message: 'Error: NG0750' })).toBe(true);
  });

  it('应丢弃本地开发和浏览器网络挂起事件但保留业务异常', () => {
    expect(sentryStatic.shouldDropNonActionableSentryEvent({
      environment: 'development',
      request: { url: 'http://localhost:3000/#/projects' },
      exception: { values: [{ value: 'TypeError: Cannot read properties of undefined' }] },
    })).toBe(true);

    expect(sentryStatic.shouldDropNonActionableSentryEvent({
      exception: {
        values: [{ value: 'BrowserNetworkSuspendedError: Browser network IO suspended' }],
      },
    })).toBe(true);

    expect(sentryStatic.shouldDropNonActionableSentryEvent({
      message: '任务存在性查询失败',
      tags: {
        operation: 'pushConnection',
        errorType: 'BrowserNetworkSuspendedError',
      },
      extra: {
        message: 'BrowserNetworkSuspendedError: Browser network IO suspended',
      },
    })).toBe(true);

    expect(sentryStatic.shouldDropNonActionableSentryEvent({
      exception: {
        values: [{ type: 'SupabaseError', value: 'column tasks.completed_at does not exist' }],
      },
    })).toBe(false);
  });

  it('应移除 hash 并脱敏认证相关 query 参数', () => {
    const sanitized = sentryStatic.sanitizeUrlForTelemetry(
      'https://nanoflow.pages.dev/callback?code=abc123&accessToken=camel&token_hash=secret&apiKey=key&statusCode=200&projectId=project-1#access_token=hidden'
    );

    expect(sanitized).toContain('code=%5BREDACTED%5D');
    expect(sanitized).toContain('accessToken=%5BREDACTED%5D');
    expect(sanitized).toContain('token_hash=%5BREDACTED%5D');
    expect(sanitized).toContain('apiKey=%5BREDACTED%5D');
    expect(sanitized).toContain('statusCode=200');
    expect(sanitized).toContain('projectId=project-1');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('camel');
    expect(sanitized).not.toContain('secret');
    expect(sanitized).not.toContain('key');
    expect(sanitized).not.toContain('hidden');
  });

  it('应递归脱敏 extra/context 中的敏感字段', () => {
    const redacted = sentryStatic.redactTelemetryRecord({
      access_token: 'secret-token',
      safe: 'kept',
      nested: {
        email: 'user@example.com',
        values: [{
          refreshToken: 'refresh-secret',
          apiKey: 'api-secret',
          statusCode: 200,
          url: 'https://nanoflow.pages.dev/callback?code=abc123&token_hash=secret',
          description: 'email=user@example.com access_token=plain-secret',
          count: 1,
        }],
      },
    });

    expect(redacted).toEqual({
      access_token: '[REDACTED]',
      safe: 'kept',
      nested: {
        email: '[REDACTED]',
        values: [{
          refreshToken: '[REDACTED]',
          apiKey: '[REDACTED]',
          statusCode: 200,
          url: 'https://nanoflow.pages.dev/callback?code=[REDACTED]&token_hash=[REDACTED]',
          description: 'email=[REDACTED] access_token=[REDACTED]',
          count: 1,
        }],
      },
    });
  });

  it('应脱敏普通字符串中的 URL、query token 和邮箱', () => {
    const sanitized = sentryStatic.sanitizeTelemetryString(
      'Login failed for user@example.com at https://nanoflow.pages.dev/callback?code=abc123#access_token=hidden accessToken=camel-secret'
    );

    expect(sanitized).toContain('[REDACTED_EMAIL]');
    expect(sanitized).toContain('code=[REDACTED]');
    expect(sanitized).toContain('accessToken=[REDACTED]');
    expect(sanitized).not.toContain('user@example.com');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('hidden');
    expect(sanitized).not.toContain('camel-secret');
  });

  it('应脱敏 JSON/冒号形式的认证字段和 Bearer token', () => {
    const jwt = 'eyJaaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc';
    const sanitized = sentryStatic.sanitizeTelemetryString(
      `{"access_token":"${jwt}","refresh_token":"refresh-secret","email":"user@example.com"} Authorization: Bearer ${jwt}`
    );

    expect(sanitized).toContain('"access_token":"[REDACTED]"');
    expect(sanitized).toContain('"refresh_token":"[REDACTED]"');
    expect(sanitized).toContain('"email":"[REDACTED]"');
    expect(sanitized).toContain('Authorization: Bearer [REDACTED]');
    expect(sanitized).not.toContain(jwt);
    expect(sanitized).not.toContain('refresh-secret');
    expect(sanitized).not.toContain('user@example.com');
  });

  it('应从 Sentry user 事件中移除邮箱、用户名和 IP', () => {
    const sanitized = sentryStatic.sanitizeSentryEventUser({
      id: 'user-1',
      email: 'user@example.com',
      username: 'display-name',
      ip_address: '127.0.0.1',
      plan: 'pro',
    });

    expect(sanitized).toEqual({ id: 'user-1', plan: 'pro' });
  });
});
