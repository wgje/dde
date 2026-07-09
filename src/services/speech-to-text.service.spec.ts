/**
 * SpeechToText 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SpeechToTextService } from './speech-to-text.service';
import { registerSpeechToTextOfflineReplaySpecs } from './speech-to-text-offline-replay.spec-helpers';
import { registerSpeechToTextTranscribeSpecs } from './speech-to-text-transcribe.spec-helpers';
import { isRecording, isTranscribing, remainingQuota } from '../state/focus-stores';
import {
  cleanupSpeechToTextServiceSpecContext,
  createSpeechToTextServiceSpecContext,
  expectDeferredCallback,
  setMediaDevices,
  type SpeechToTextServiceSpecContext,
} from './speech-to-text.service.spec-helpers';

type OfflineCacheSaveResult = {
  id: string;
  state: 'owned' | 'quarantined';
};

describe('SpeechToTextService', () => {
  let service: SpeechToTextService;
  let context: SpeechToTextServiceSpecContext;
  let mockLoggerService: SpeechToTextServiceSpecContext['mockLoggerService'];
  let mockToastService: SpeechToTextServiceSpecContext['mockToastService'];
  let mockSupabaseClient: SpeechToTextServiceSpecContext['mockSupabaseClient'];
  let mockAuthService: SpeechToTextServiceSpecContext['mockAuthService'];
  let mockBlackBoxService: SpeechToTextServiceSpecContext['mockBlackBoxService'];
  let mockSessionManager: SpeechToTextServiceSpecContext['mockSessionManager'];
  let mockEventBus: SpeechToTextServiceSpecContext['mockEventBus'];
  let mockNetworkAwareness: SpeechToTextServiceSpecContext['mockNetworkAwareness'];
  let mockAuthApi: SpeechToTextServiceSpecContext['mockAuthApi'];
  let attachRecordedAudio: SpeechToTextServiceSpecContext['attachRecordedAudio'];
  let attachRecordedAudioWithTracks:
    SpeechToTextServiceSpecContext['attachRecordedAudioWithTracks'];

  beforeEach(() => {
    context = createSpeechToTextServiceSpecContext();
    ({
      attachRecordedAudio,
      attachRecordedAudioWithTracks,
      mockAuthApi,
      mockAuthService,
      mockBlackBoxService,
      mockEventBus,
      mockLoggerService,
      mockNetworkAwareness,
      mockSessionManager,
      mockSupabaseClient,
      mockToastService,
      service,
    } = context);
  });

  afterEach(() => {
    cleanupSpeechToTextServiceSpecContext(context);
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

    it('并发触发开始录音时只创建一个 MediaRecorder', async () => {
      const getUserMedia = vi.fn().mockResolvedValue({
        getTracks: () => [] as MediaStreamTrack[],
      });
      const enumerateDevices = vi.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'test1' },
      ]);
      const start = vi.fn();
      const mediaRecorderInstances: unknown[] = [];
      class MockMediaRecorder {
        static isTypeSupported = vi.fn(() => true);
        state = 'recording';
        mimeType = 'audio/webm';
        ondataavailable: null = null;
        onstop: null = null;

        constructor(readonly stream: MediaStream) {
          mediaRecorderInstances.push(this);
        }

        start = start;
        stop = vi.fn();
      }
      vi.stubGlobal('MediaRecorder', MockMediaRecorder);
      setMediaDevices({
        enumerateDevices,
        getUserMedia,
      } as unknown as MediaDevices);

      await Promise.all([
        service.startRecording(),
        service.startRecording(),
      ]);

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(mediaRecorderInstances).toHaveLength(1);
      expect(start).toHaveBeenCalledTimes(1);
      service.cancelRecording();
    });
  });

  describe('stopRecording', () => {
    it('未录音时调用不应该抛出错误', () => {
      expect(() => service.stopRecording()).not.toThrow();
    });
  });

  describe('destroy cleanup', () => {
    it('销毁录音中服务时应释放录音资源并停止时长 ticker', () => {
      vi.useFakeTimers();
      const { recorder, stopTrack } = attachRecordedAudioWithTracks([
        new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
      ]);
      isRecording.set(true);
      (service as unknown as { recordingStartTime: number }).recordingStartTime = Date.now();
      const durationTicker = (service as unknown as { durationTicker: { start: () => void } }).durationTicker;
      durationTicker.start();

      TestBed.resetTestingModule();
      vi.advanceTimersByTime(500);

      expect(recorder.stop).toHaveBeenCalledTimes(1);
      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(service.isRecording()).toBe(false);
      expect((service as unknown as { mediaRecorder: unknown | null }).mediaRecorder).toBeNull();
      expect(service.recordingDurationSec()).toBe(0);
    });
  });

  describe('transcribing state coordination', () => {
    it('后台离线回放未接管转写时不应清除已有转写状态', async () => {
      mockAuthService.currentUserId.set('local-user');
      isTranscribing.set(true);
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

      await processing;
      expect(service.isTranscribing()).toBe(true);
    });

    it('后台离线回放完成时不应清除仍在进行的手动转写状态', async () => {
      mockAuthService.currentUserId.set('local-user');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValue(undefined);

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'offline-active',
            ownerUserId: 'local-user',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm',
          },
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      let deleteTx!: {
        objectStore: ReturnType<typeof vi.fn>;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        error: unknown;
      };
      const store = {
        getAll: vi.fn(() => request),
        delete: vi.fn(() => {
          const deleteRequest: {
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            error: unknown;
          } = {
            onsuccess: null,
            onerror: null,
            error: null,
          };
          queueMicrotask(() => {
            deleteRequest.onsuccess?.();
            deleteTx.oncomplete?.();
          });
          return deleteRequest;
        }),
      };
      const readTx = {
        objectStore: vi.fn(() => store),
      };
      deleteTx = {
        objectStore: vi.fn(() => store),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
      };
      (service as unknown as { db: { transaction: ReturnType<typeof vi.fn> } }).db = {
        transaction: vi.fn()
          .mockReturnValueOnce(readTx)
          .mockReturnValueOnce(deleteTx),
      };

      let resolveOfflineTranscribe!: (text: string) => void;
      let resolveManualTranscribe!: (text: string) => void;
      vi.spyOn(
        service as unknown as { transcribeBlob: (blob: Blob, owner?: string | null) => Promise<string> },
        'transcribeBlob',
      )
        .mockImplementationOnce(() => new Promise(resolve => {
          resolveOfflineTranscribe = resolve;
        }))
        .mockImplementationOnce(() => new Promise(resolve => {
          resolveManualTranscribe = resolve;
        }));
      vi.spyOn(
        service as unknown as { saveToOfflineCache: (blob: Blob, owner?: string | null) => Promise<OfflineCacheSaveResult> },
        'saveToOfflineCache',
      ).mockResolvedValueOnce({ id: 'manual-write-ahead', state: 'owned' });
      vi.spyOn(
        service as unknown as { deleteFromCache: (id: string) => Promise<void> },
        'deleteFromCache',
      ).mockResolvedValueOnce();

      const offlineReplay = service.processOfflineCache();
      request.onsuccess?.();
      await Promise.resolve();

      attachRecordedAudioWithTracks([
        new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
      ]);
      const manualTranscribe = service.stopAndTranscribe();
      await Promise.resolve();

      resolveOfflineTranscribe('offline done');
      await offlineReplay;

      expect(service.isTranscribing()).toBe(true);

      resolveManualTranscribe('manual done');
      await expect(manualTranscribe).resolves.toBe('manual done');
      expect(service.isTranscribing()).toBe(false);
    });
  });

  describe('stopAndTranscribe', () => {
    it('未录音时应该 reject', async () => {
      await expect(service.stopAndTranscribe()).rejects.toThrow('未开始录音');
    });

    it('离线缓存写入失败时应显式 reject，避免提示录音已可靠排队', async () => {
      mockNetworkAwareness.isOnline.set(false);
      attachRecordedAudio();
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockRejectedValueOnce(new Error('cache failed'));

      await expect(service.stopAndTranscribe()).rejects.toThrow('cache failed');
      expect(cacheSpy).toHaveBeenCalledTimes(1);
      expect(mockToastService.error).toHaveBeenCalledWith('保存失败', '无法保存录音，请重试');
    });

    it('录音太短早退时也应释放麦克风并清理录音 owner', async () => {
      const { stopTrack } = attachRecordedAudioWithTracks([new Blob(['x'], { type: 'audio/webm' })]);

      await expect(service.stopAndTranscribe()).resolves.toBe('');

      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect((service as unknown as { recordingOwnerUserId: string | null }).recordingOwnerUserId).toBeNull();
      expect(service.isTranscribing()).toBe(false);
    });

    it('在线转写前应先完成本地写前缓存，转写成功后清理缓存条目', async () => {
      attachRecordedAudio();
      (service as unknown as { recordingOwnerUserId: string | null }).recordingOwnerUserId = 'local-user';
      const order: string[] = [];
      const cacheResult: OfflineCacheSaveResult = { id: 'write-ahead-audio', state: 'owned' };
      const cacheSpy = vi.spyOn(
        service as unknown as {
          saveToOfflineCache: (blob: Blob, owner?: string | null) => Promise<OfflineCacheSaveResult>;
        },
        'saveToOfflineCache'
      ).mockImplementationOnce(async () => {
        order.push('save');
        return cacheResult;
      });
      const transcribeSpy = vi.spyOn(
        service as unknown as { transcribeBlob: (blob: Blob, owner?: string | null) => Promise<string> },
        'transcribeBlob'
      ).mockImplementationOnce(async () => {
        order.push('transcribe');
        return 'online text';
      });
      const deleteSpy = vi.spyOn(
        service as unknown as { deleteFromCache: (id: string) => Promise<void> },
        'deleteFromCache'
      ).mockImplementationOnce(async id => {
        order.push(`delete:${id}`);
      });

      await expect(service.stopAndTranscribe()).resolves.toBe('online text');

      expect(cacheSpy).toHaveBeenCalledWith(expect.any(Blob), 'local-user');
      expect(transcribeSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith('write-ahead-audio');
      expect(order).toEqual(['save', 'transcribe', 'delete:write-ahead-audio']);
    });
  });

  registerSpeechToTextTranscribeSpecs({
    service: () => service,
    mockAuthService: () => mockAuthService,
    mockAuthApi: () => mockAuthApi,
    mockSessionManager: () => mockSessionManager,
    mockToastService: () => mockToastService,
  });

  describe('stopAndTranscribe 会话恢复兜底', () => {
    it('会话临时不可用时应缓存录音并稍后重试', async () => {
      attachRecordedAudio();

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockResolvedValueOnce({ id: 'retry-cache-entry', state: 'owned' });

      const result = await service.stopAndTranscribe();

      expect(result).toBe('[转写失败，稍后重试]');
      expect(cacheSpy).toHaveBeenCalledTimes(1);
      expect(mockToastService.warning).toHaveBeenCalledWith('转写失败', expect.any(String));
    });

    it('会话临时不可用且缓存失败时应显式 reject', async () => {
      attachRecordedAudio();

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockRejectedValueOnce(new Error('cache failed'));

      await expect(service.stopAndTranscribe()).rejects.toThrow('cache failed');
      expect(mockToastService.error).toHaveBeenCalledWith('保存失败', '无法保存录音，请重试');
    });

    it('Supabase client 暂不可用时应缓存录音并稍后重试', async () => {
      mockAuthService.currentUserId.set('cloud-user');
      attachRecordedAudio();
      (service as unknown as { recordingOwnerUserId: string | null }).recordingOwnerUserId = 'cloud-user';
      mockSupabaseClient.clientAsync.mockResolvedValueOnce(null);
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockResolvedValueOnce({ id: 'supabase-client-cache-entry', state: 'owned' });

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
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockResolvedValueOnce({ id: 'session-manager-cache-entry', state: 'owned' });

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
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob, owner?: string | null) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockResolvedValueOnce({ id: 'owner-switch-cache-entry', state: 'owned' });

      const result = await service.stopAndTranscribe();

      expect(result).toBe('[转写失败，稍后重试]');
      expect(cacheSpy).toHaveBeenCalledWith(expect.any(Blob), 'user-a');
    });

    it('在线重试缓存成功后应安排延迟重放', async () => {
      vi.useFakeTimers();
      attachRecordedAudio();

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockResolvedValueOnce({ id: 'delayed-replay-cache-entry', state: 'owned' });
      const replaySpy = vi.spyOn(service as unknown as { processOfflineCacheAndCreateEntries: () => Promise<void> }, 'processOfflineCacheAndCreateEntries')
        .mockResolvedValueOnce();

      await service.stopAndTranscribe();
      await vi.advanceTimersByTimeAsync(1500);

      expect(replaySpy).toHaveBeenCalledTimes(1);
    });

    it('受控上游超时时应缓存但不立即重放，避免请求放大', async () => {
      vi.useFakeTimers();
      attachRecordedAudio();

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('FOCUS_NETWORK_ERROR'));
      vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockResolvedValueOnce({ id: 'controlled-timeout-cache-entry', state: 'owned' });
      const replaySpy = vi.spyOn(service as unknown as { processOfflineCacheAndCreateEntries: () => Promise<void> }, 'processOfflineCacheAndCreateEntries')
        .mockResolvedValueOnce();

      await service.stopAndTranscribe();
      await vi.advanceTimersByTimeAsync(1500);

      expect(replaySpy).not.toHaveBeenCalled();
      expect(mockToastService.warning).toHaveBeenCalledWith('转写失败', expect.any(String));
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
      const tx: {
        objectStore: ReturnType<typeof vi.fn>;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        error: unknown;
      } = {
        objectStore: vi.fn(() => store),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const saving = (service as unknown as { saveToOfflineCache: (blob: Blob) => Promise<OfflineCacheSaveResult> })
        .saveToOfflineCache(new Blob(['audio'], { type: 'audio/webm' }));
      request.onsuccess?.();
      tx.oncomplete?.();

      await expect(saving).resolves.toEqual({
        id: expect.any(String),
        state: 'quarantined',
      });
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

    it('服务销毁后不应继续发布已完成的离线重放结果', async () => {
      let resolveReplay: ((value: { id: string; text: string }[]) => void) | null = null;
      vi.spyOn(service, 'processOfflineCache')
        .mockImplementationOnce(() => new Promise(resolve => {
          resolveReplay = resolve;
        }));

      mockEventBus.onSessionRestored$.next({
        type: 'session-restored',
        userId: 'local-user',
        source: 'test'
      });

      TestBed.resetTestingModule();
      expectDeferredCallback(resolveReplay, 'resolveReplay')([{ id: 'offline-audio', text: 'done' }]);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockToastService.success).not.toHaveBeenCalled();
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

  registerSpeechToTextOfflineReplaySpecs({
    service: () => service,
    mockAuthService: () => mockAuthService,
    mockBlackBoxService: () => mockBlackBoxService,
    mockToastService: () => mockToastService,
    mockNetworkAwareness: () => mockNetworkAwareness,
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
