/**
 * SpeechToText 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SpeechToTextService } from './speech-to-text.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { AuthService } from './auth.service';
import { BlackBoxService } from './black-box.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { EventBusService } from './event-bus.service';
import { signal } from '@angular/core';
import { isRecording, isTranscribing } from '../state/focus-stores';
import { Subject } from 'rxjs';

const expectDeferredCallback = <TArgs extends unknown[], TResult = void>(
  callback: ((...args: TArgs) => TResult) | null | undefined,
  label: string
): ((...args: TArgs) => TResult) => {
  if (!callback) {
    throw new Error(`${label} should be assigned before invocation`);
  }

  return callback;
};

describe('SpeechToTextService', () => {
  let service: SpeechToTextService;
  let originalMediaDevices: MediaDevices | undefined;
  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    category: ReturnType<typeof vi.fn>;
  };
  let mockToastService: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  let mockSupabaseClient: {
    client: ReturnType<typeof vi.fn>;
    clientAsync: ReturnType<typeof vi.fn>;
  };
  let mockAuthService: {
    currentUserId: ReturnType<typeof signal<string | null>>;
    isConfigured: boolean;
    ensureRuntimeAuthReady: ReturnType<typeof vi.fn>;
  };
  let mockBlackBoxService: {
    create: ReturnType<typeof vi.fn>;
  };
  let mockSessionManager: {
    tryRefreshSessionWithReason: ReturnType<typeof vi.fn>;
    tryRefreshSessionWithSession: ReturnType<typeof vi.fn>;
  };
  let mockEventBus: {
    onSessionRestored$: Subject<{ type: 'session-restored'; userId: string; source: string }>;
    onSessionInvalidated$: Subject<{ type: 'session-invalidated'; userId: string | null; source: string }>;
  };
  let mockNetworkAwareness: {
    isOnline: ReturnType<typeof signal<boolean>>;
    networkQuality: ReturnType<typeof signal<string>>;
  };
  let mockAuthApi: {
    getSession: ReturnType<typeof vi.fn>;
  };

  const setMediaDevices = (value: MediaDevices | undefined) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value,
      configurable: true,
      writable: true
    });
  };

  const attachRecordedAudio = () => {
    const recorder = {
      state: 'recording',
      mimeType: 'audio/webm',
      onstop: null as null | (() => void | Promise<void>),
      stop: vi.fn(function(this: { onstop: null | (() => void | Promise<void>) }) {
        void this.onstop?.();
      }),
      stream: {
        getTracks: () => [] as MediaStreamTrack[]
      }
    };

    (service as unknown as {
      mediaRecorder: typeof recorder;
      audioChunks: Blob[];
    }).mediaRecorder = recorder;
    (service as unknown as {
      mediaRecorder: typeof recorder;
      audioChunks: Blob[];
    }).audioChunks = [new Blob([new Uint8Array(1600)], { type: 'audio/webm' })];

    return recorder;
  };

  beforeEach(() => {
    vi.useRealTimers();
    originalMediaDevices = navigator.mediaDevices;

    // 重置 signals
    isRecording.set(false);
    isTranscribing.set(false);
    
    // 创建子 logger mock
    const categoryLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    };

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      category: vi.fn().mockReturnValue(categoryLogger)
    };

    mockToastService = {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    };

    mockAuthApi = {
      getSession: vi.fn().mockResolvedValue({
        data: {
          session: {
            access_token: 'test-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'local-user' }
          }
        },
        error: null,
      })
    };

    const client = {
      auth: mockAuthApi,
    };

    mockSupabaseClient = {
      client: vi.fn().mockReturnValue(client),
      clientAsync: vi.fn().mockResolvedValue(client)
    };

    mockAuthService = {
      currentUserId: signal('local-user'),
      isConfigured: false,
      ensureRuntimeAuthReady: vi.fn().mockResolvedValue(undefined),
    };

    mockBlackBoxService = {
      create: vi.fn().mockReturnValue({ ok: true, value: { id: 'bb-1' } }),
    };

    mockSessionManager = {
      tryRefreshSessionWithReason: vi.fn().mockResolvedValue({ refreshed: true }),
      tryRefreshSessionWithSession: vi.fn().mockResolvedValue({
        refreshed: true,
        session: {
          access_token: 'fresh-session-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'local-user' }
        }
      }),
    };

    mockEventBus = {
      onSessionRestored$: new Subject(),
      onSessionInvalidated$: new Subject(),
    };

    mockNetworkAwareness = {
      isOnline: signal(true),
      networkQuality: signal('high')
    };

    TestBed.configureTestingModule({
      providers: [
        SpeechToTextService,
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SupabaseClientService, useValue: mockSupabaseClient },
        { provide: AuthService, useValue: mockAuthService },
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: EventBusService, useValue: mockEventBus },
        { provide: NetworkAwarenessService, useValue: mockNetworkAwareness },
      ]
    });

    service = TestBed.inject(SpeechToTextService);
  });

  afterEach(() => {
    if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
      vi.useRealTimers();
    }
    vi.restoreAllMocks();
    mockEventBus.onSessionRestored$.complete();
    mockEventBus.onSessionInvalidated$.complete();
    setMediaDevices(originalMediaDevices);
  });

  describe('isRecording', () => {
    it('初始状态应该不在录音', () => {
      expect(service.isRecording()).toBe(false);
    });
  });

  describe('isTranscribing', () => {
    it('初始状态应该不在转录', () => {
      expect(service.isTranscribing()).toBe(false);
    });
  });

  describe('getRecordingDuration', () => {
    it('未录音时应该返回 0', () => {
      expect(service.getRecordingDuration()).toBe(0);
    });
  });

  describe('isSupported', () => {
    it('应该检测浏览器是否支持录音', () => {
      const result = service.isSupported();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getFallbackMessage', () => {
    it('应该返回提示消息', () => {
      const message = service.getFallbackMessage();
      expect(typeof message).toBe('string');
    });
  });

  describe('checkMicrophoneAvailability', () => {
    it('当没有音频输入设备时应该返回 false', async () => {
      const mockEnumerateDevices = vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'test1' }
      ]);
      
      setMediaDevices({
        enumerateDevices: mockEnumerateDevices,
        getUserMedia: vi.fn()
      } as unknown as MediaDevices);

      const result = await service.checkMicrophoneAvailability();
      expect(result).toBe(false);
    });

    it('当有音频输入设备时应该返回 true', async () => {
      const mockEnumerateDevices = vi.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'test1' },
        { kind: 'videoinput', deviceId: 'test2' }
      ]);
      
      setMediaDevices({
        enumerateDevices: mockEnumerateDevices,
        getUserMedia: vi.fn()
      } as unknown as MediaDevices);

      const result = await service.checkMicrophoneAvailability();
      expect(result).toBe(true);
    });

    it('当 mediaDevices API 不可用时应该返回 false', async () => {
      setMediaDevices(undefined);

      const result = await service.checkMicrophoneAvailability();
      expect(result).toBe(false);
    });
  });

  describe('startRecording', () => {
    it('设备不可用时应该优雅返回而不抛出错误', async () => {
      // Mock checkMicrophoneAvailability 返回 false
      vi.spyOn(service, 'checkMicrophoneAvailability').mockResolvedValue(false);

      // 不应该抛出错误
      await expect(service.startRecording()).resolves.toBeUndefined();
    });

    it('浏览器不支持时应该优雅返回', async () => {
      setMediaDevices(undefined);

      // 不应该抛出错误
      await expect(service.startRecording()).resolves.toBeUndefined();
    });
  });

  describe('stopRecording', () => {
    it('未录音时调用不应该抛出错误', () => {
      expect(() => service.stopRecording()).not.toThrow();
    });
  });

  describe('stopAndTranscribe', () => {
    it('未录音时应该 reject', async () => {
      await expect(service.stopAndTranscribe()).rejects.toThrow('未开始录音');
    });
  });

  describe('transcribeBlob', () => {
    it('应在 access token 临近过期时先刷新再请求', async () => {
      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession
        .mockResolvedValueOnce({
          data: {
            session: {
              access_token: 'stale-token',
              expires_at: Math.floor(Date.now() / 1000) + 5,
              user: { id: 'cloud-user' }
            }
          },
          error: null,
        });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: true,
        session: {
          access_token: 'fresh-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'cloud-user' }
        }
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ text: '转写成功', duration: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      const result = await (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
        .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }));

      expect(result).toBe('转写成功');
      expect(mockSessionManager.tryRefreshSessionWithSession).toHaveBeenCalledWith('SpeechToText.transcribe.getSession');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer fresh-token'
        })
      });
    });

    it('首次收到 401 时应刷新会话并仅重试一次', async () => {
      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValueOnce({
        data: {
          session: {
            access_token: 'first-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'cloud-user' }
          }
        },
        error: null,
      });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: true,
        session: {
          access_token: 'second-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'cloud-user' }
        }
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ text: '重试成功', duration: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));

      const result = await (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
        .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }));

      expect(result).toBe('重试成功');
      expect(mockSessionManager.tryRefreshSessionWithSession).toHaveBeenCalledWith('SpeechToText.transcribe.retry401');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer first-token'
        })
      });
      expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer second-token'
        })
      });
    });

    it('401 重试时应直接使用 refresh 返回的新 session，避免再次读到旧 token', async () => {
      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'stale-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: 'cloud-user' }
          }
        },
        error: null,
      });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: true,
        session: {
          access_token: 'refreshed-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'cloud-user' }
        }
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ code: 401, message: 'Invalid JWT' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ text: '刷新后成功', duration: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));

      const result = await (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
        .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }));

      expect(result).toBe('刷新后成功');
      expect(mockAuthApi.getSession).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          Authorization: 'Bearer refreshed-token'
        })
      });
    });

    it('刷新失败且原因是 no-session 时应抛出 SYNC_AUTH_EXPIRED', async () => {
      mockAuthService.currentUserId.set('cloud-user');
      mockAuthApi.getSession.mockResolvedValueOnce({
        data: { session: null },
        error: null,
      });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: false,
        reason: 'no-session'
      });

      await expect(
        (service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> })
          .transcribeBlob(new Blob(['audio'], { type: 'audio/webm' }))
      ).rejects.toThrow('SYNC_AUTH_EXPIRED');
    });
  });

  describe('stopAndTranscribe 会话恢复兜底', () => {
    it('会话临时不可用时应缓存录音并稍后重试', async () => {
      attachRecordedAudio();

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<'owned' | 'quarantined'> }, 'saveToOfflineCache')
        .mockResolvedValueOnce('owned');

      const result = await service.stopAndTranscribe();

      expect(result).toBe('[转写失败，稍后重试]');
      expect(cacheSpy).toHaveBeenCalledTimes(1);
      expect(mockToastService.warning).toHaveBeenCalledWith('转写失败', expect.any(String));
    });

    it('会话临时不可用且缓存失败时应显式 reject', async () => {
      attachRecordedAudio();

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<'owned' | 'quarantined'> }, 'saveToOfflineCache')
        .mockRejectedValueOnce(new Error('cache failed'));

      await expect(service.stopAndTranscribe()).rejects.toThrow('cache failed');
      expect(mockToastService.error).toHaveBeenCalledWith('保存失败', '无法保存录音，请重试');
    });

    it('Supabase client 暂不可用时应缓存录音并稍后重试', async () => {
      mockAuthService.currentUserId.set('cloud-user');
      attachRecordedAudio();
      (service as unknown as { recordingOwnerUserId: string | null }).recordingOwnerUserId = 'cloud-user';
      mockSupabaseClient.clientAsync.mockResolvedValueOnce(null);
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<'owned' | 'quarantined'> }, 'saveToOfflineCache')
        .mockResolvedValueOnce('owned');

      const result = await service.stopAndTranscribe();

      expect(result).toBe('[转写失败，稍后重试]');
      expect(cacheSpy).toHaveBeenCalledTimes(1);
    });

    it('SessionManager 返回 client-unready 时应缓存录音并稍后重试', async () => {
      mockAuthService.currentUserId.set('cloud-user');
      attachRecordedAudio();
      (service as unknown as { recordingOwnerUserId: string | null }).recordingOwnerUserId = 'cloud-user';
      mockAuthApi.getSession.mockResolvedValueOnce({
        data: { session: null },
        error: null,
      });
      mockSessionManager.tryRefreshSessionWithSession.mockResolvedValueOnce({
        refreshed: false,
        reason: 'client-unready'
      });
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<'owned' | 'quarantined'> }, 'saveToOfflineCache')
        .mockResolvedValueOnce('owned');

      const result = await service.stopAndTranscribe();

      expect(result).toBe('[转写失败，稍后重试]');
      expect(cacheSpy).toHaveBeenCalledTimes(1);
    });

    it('live 转写期间 owner 切换时应按原 owner 缓存录音', async () => {
      attachRecordedAudio();
      mockAuthService.currentUserId.set('user-a');
      (service as unknown as { recordingOwnerUserId: string | null }).recordingOwnerUserId = 'user-a';

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob, owner?: string | null) => Promise<string> }, 'transcribeBlob')
        .mockImplementationOnce(async () => {
          mockAuthService.currentUserId.set('user-b');
          return 'owner switched';
        });
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob, owner?: string | null) => Promise<'owned' | 'quarantined'> }, 'saveToOfflineCache')
        .mockResolvedValueOnce('owned');

      const result = await service.stopAndTranscribe();

      expect(result).toBe('[转写失败，稍后重试]');
      expect(cacheSpy).toHaveBeenCalledWith(expect.any(Blob), 'user-a');
    });

    it('在线重试缓存成功后应安排延迟重放', async () => {
      vi.useFakeTimers();
      attachRecordedAudio();

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<'owned' | 'quarantined'> }, 'saveToOfflineCache')
        .mockResolvedValueOnce('owned');
      const replaySpy = vi.spyOn(service as unknown as { processOfflineCacheAndCreateEntries: () => Promise<void> }, 'processOfflineCacheAndCreateEntries')
        .mockResolvedValueOnce();

      await service.stopAndTranscribe();
      await vi.advanceTimersByTimeAsync(1500);

      expect(replaySpy).toHaveBeenCalledTimes(1);
    });

    it('无稳定 owner 时缓存应直接进入隔离态', async () => {
      mockAuthService.currentUserId.set(null);

      const request: {
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const add = vi.fn(() => request);
      const store = {
        add,
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const saving = (service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<'owned' | 'quarantined'> })
        .saveToOfflineCache(new Blob(['audio'], { type: 'audio/webm' }));
      request.onsuccess?.();

      await expect(saving).resolves.toBe('quarantined');
      expect(add).toHaveBeenCalledWith(expect.objectContaining({
        ownerUserId: '__legacy_unknown_owner__'
      }));
    });
  });

  describe('session restored replay', () => {
    it('会话恢复事件应触发离线缓存重放', () => {
      mockAuthService.currentUserId.set('user-1');
      const replaySpy = vi.spyOn(service as unknown as { processOfflineCacheAndCreateEntries: () => Promise<void> }, 'processOfflineCacheAndCreateEntries')
        .mockResolvedValueOnce();

      mockEventBus.onSessionRestored$.next({
        type: 'session-restored',
        userId: 'user-1',
        source: 'test'
      });

      expect(replaySpy).toHaveBeenCalledTimes(1);
    });

    it('跨标签页会话恢复应等待 owner handoff 完成后再重放', async () => {
      vi.useFakeTimers();
      mockAuthService.currentUserId.set('old-user');
      const replaySpy = vi.spyOn(service as unknown as { processOfflineCacheAndCreateEntries: () => Promise<void> }, 'processOfflineCacheAndCreateEntries')
        .mockResolvedValueOnce();

      mockEventBus.onSessionRestored$.next({
        type: 'session-restored',
        userId: 'new-user',
        source: 'AuthService.storageBridge'
      });

      expect(replaySpy).not.toHaveBeenCalled();

      mockAuthService.currentUserId.set('new-user');
      await vi.advanceTimersByTimeAsync(50);

      expect(replaySpy).toHaveBeenCalledTimes(1);
    });

    it('多个重放触发并发到来时应只执行一次缓存重放', async () => {
      let resolveReplay: (() => void) | null = null;
      const replaySpy = vi.spyOn(service as unknown as { processOfflineCacheAndCreateEntries: () => Promise<void> }, 'processOfflineCacheAndCreateEntries')
        .mockImplementationOnce(() => new Promise<void>(resolve => {
          resolveReplay = resolve;
        }));

      mockEventBus.onSessionRestored$.next({
        type: 'session-restored',
        userId: 'user-1',
        source: 'test'
      });
      ((service as unknown as { onlineHandler: (() => void) | null }).onlineHandler)?.();

      expect(replaySpy).toHaveBeenCalledTimes(1);

      expectDeferredCallback(resolveReplay, 'resolveReplay')();
      await Promise.resolve();
    });
  });

  describe('offlinePendingCount', () => {
    it('应该返回离线待处理数量', () => {
      expect(typeof service.offlinePendingCount()).toBe('number');
    });

    it('应只统计当前用户的离线录音数量', async () => {
      mockAuthService.currentUserId.set('user-b');

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: [
          { id: 'a', ownerUserId: 'user-b', blob: new Blob(['1']), createdAt: '2026-01-01', mimeType: 'audio/webm' },
          { id: 'b', ownerUserId: 'user-a', blob: new Blob(['2']), createdAt: '2026-01-01', mimeType: 'audio/webm' },
          { id: 'c', ownerUserId: '__legacy_unknown_owner__', blob: new Blob(['3']), createdAt: '2026-01-01', mimeType: 'audio/webm' },
        ],
        onsuccess: null,
        onerror: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const updating = (service as unknown as { updateOfflinePendingCount: () => Promise<void> }).updateOfflinePendingCount();
      request.onsuccess?.();
      await updating;

      expect(service.offlinePendingCount()).toBe(1);
    });
  });

  describe('remainingQuota', () => {
    it('应该返回剩余配额', () => {
      expect(typeof service.remainingQuota()).toBe('number');
    });
  });

  describe('processOfflineCache', () => {
    it('应该处理离线缓存', async () => {
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
    });

    it('应跳过属于其他用户的离线音频缓存', async () => {
      mockAuthService.currentUserId.set('user-b');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-1',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const transcribeSpy = vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob');

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
      expect(transcribeSpy).not.toHaveBeenCalled();
    });

    it('回放期间若账号切换则不应创建条目也不应删除缓存', async () => {
      mockAuthService.currentUserId.set('user-a');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-2',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockImplementationOnce(async () => {
          mockAuthService.currentUserId.set('user-b');
          return '切号后的转写';
        });
      const deleteSpy = vi.spyOn(service as unknown as { deleteFromCache: (id: string) => Promise<void> }, 'deleteFromCache');

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
      expect(mockBlackBoxService.create).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('离线回放遇到瞬时认证错误时应重新安排重试', async () => {
      mockAuthService.currentUserId.set('user-a');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-3',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      const scheduleSpy = vi.spyOn(service as unknown as { scheduleOfflineCacheReplay: (reason: string) => void }, 'scheduleOfflineCacheReplay')
        .mockImplementation(() => undefined);

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
      expect(scheduleSpy).toHaveBeenCalledWith('offline-replay-retryable-error');
    });

    it('应隔离缺少 ownerUserId 的旧版离线缓存', async () => {
      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: [
          {
            id: 'legacy-audio',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
      };
      const put = vi.fn();
      const store = {
        getAll: vi.fn(() => request),
        put,
      };
      const tx: {
        objectStore: ReturnType<typeof vi.fn>;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        objectStore: vi.fn(() => store),
        oncomplete: null,
        onerror: null,
        error: null,
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const migrating = (service as unknown as { migrateLegacyOfflineAudioOwners: () => Promise<void> }).migrateLegacyOfflineAudioOwners();
      request.onsuccess?.();
      tx.oncomplete?.();
      await migrating;

      expect(put).toHaveBeenCalledWith(expect.objectContaining({
        id: 'legacy-audio',
        ownerUserId: '__legacy_unknown_owner__'
      }));
      expect(mockToastService.warning).toHaveBeenCalledWith(
        '发现旧版离线录音',
        '为避免转入错误账号，旧缓存录音已被隔离，不会自动转写'
      );
    });
  });

  describe('全局事件监听器清理', () => {
    it('服务应保存 onlineHandler 引用以便清理', () => {
      // 验证 onlineHandler 在构造后不为 null（意味着可以被移除）
      const handler = (service as unknown as { onlineHandler: (() => void) | null }).onlineHandler;
      expect(handler).not.toBeNull();
      expect(typeof handler).toBe('function');
    });

    it('手动清理 onlineHandler 后应安全', () => {
      const svc = service as unknown as { onlineHandler: (() => void) | null };
      const handler = svc.onlineHandler;

      // 模拟 destroy 行为：移除监听器并置空
      if (handler) {
        window.removeEventListener('online', handler);
        svc.onlineHandler = null;
      }

      expect(svc.onlineHandler).toBeNull();
    });

    it('清理后重复移除不应抛出错误（幂等）', () => {
      const svc = service as unknown as { onlineHandler: (() => void) | null };

      // 第一次清理
      if (svc.onlineHandler) {
        window.removeEventListener('online', svc.onlineHandler);
        svc.onlineHandler = null;
      }
      // 第二次清理（幂等）
      expect(() => {
        if (svc.onlineHandler) {
          window.removeEventListener('online', svc.onlineHandler);
          svc.onlineHandler = null;
        }
      }).not.toThrow();
    });
  });
});
