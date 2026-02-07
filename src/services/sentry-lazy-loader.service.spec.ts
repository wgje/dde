import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';

type MutableService = SentryLazyLoaderService & {
  pendingEvents: Array<Record<string, unknown>>;
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

describe('SentryLazyLoaderService', () => {
  let service: SentryLazyLoaderService;

  beforeEach(() => {
    service = new SentryLazyLoaderService();
    vi.spyOn(service, 'triggerLazyInit').mockImplementation(() => {});
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
});
