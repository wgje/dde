import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SpeechToTextService } from './speech-to-text.service';
import { SpeechToTextStaleAuthorityError } from './speech-to-text-transcriber';
import { registerSpeechToTextOfflineReplaySpecs } from './speech-to-text-offline-replay.spec-helpers';
import { registerSpeechToTextRecordingStartSpecs } from './speech-to-text-recording-start.spec-helpers';
import { registerSpeechToTextTranscribeSpecs } from './speech-to-text-transcribe.spec-helpers';
import { isRecording, isTranscribing, remainingQuota } from '../state/focus-stores';
import {
  cleanupSpeechToTextServiceSpecContext,
  createSpeechToTextServiceSpecContext,
  expectDeferredCallback,
  type SpeechToTextServiceSpecContext,
} from './speech-to-text.service.spec-helpers';
type OfflineCacheSaveResult = {
  id: string;
  state: 'owned' | 'quarantined';
};
type TranscriberProbe = {
  transcribe: (blob: Blob, ownerUserId: string | null) => Promise<string>;
};
type CanonicalTestSession = {
  access_token: string;
  expires_at: number;
  user: { id: string };
};
type RefreshResult = { refreshed: boolean; reason?: string; session?: CanonicalTestSession | null };

const getTranscriber = (service: SpeechToTextService): TranscriberProbe =>
  (service as unknown as { transcriber: TranscriberProbe }).transcriber;

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
    let canonicalSession: CanonicalTestSession = {
      access_token: 'test-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'local-user' },
    };
    const sdkGetSession = mockAuthApi.getSession;
    const enqueueSession = sdkGetSession.mockImplementationOnce.bind(sdkGetSession);
    const setSessionDefault = sdkGetSession.mockImplementation.bind(sdkGetSession);
    const resolveSession = async (result: { data: { session: CanonicalTestSession | null }; error: unknown }) => {
      if (result.data.session) canonicalSession = result.data.session;
      const currentUserId = mockAuthService.currentUserId();
      if (!result.data.session && currentUserId && canonicalSession.user.id !== currentUserId) {
        canonicalSession = { ...canonicalSession, user: { id: currentUserId } };
      }
      return result;
    };
    sdkGetSession.mockResolvedValueOnce = ((result: Parameters<typeof resolveSession>[0]) => {
      void resolveSession(result);
      return enqueueSession(() => resolveSession(result));
    }) as typeof sdkGetSession.mockResolvedValueOnce;
    sdkGetSession.mockResolvedValue = ((result: Parameters<typeof resolveSession>[0]) => {
      void resolveSession(result);
      return setSessionDefault(() => resolveSession(result));
    }) as typeof sdkGetSession.mockResolvedValue;
    Object.assign(mockSupabaseClient, {
      getStorageKey: vi.fn(() => 'sb-project-auth-token'),
    });
    const refresh = mockSessionManager.tryRefreshSessionWithSession;
    const enqueueRefresh = refresh.mockImplementationOnce.bind(refresh);
    refresh.mockResolvedValueOnce = ((result: RefreshResult) => enqueueRefresh(async () => {
      if (result.refreshed && result.session) canonicalSession = result.session;
      return result;
    })) as typeof refresh.mockResolvedValueOnce;
    Object.defineProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__', {
      configurable: true,
      value: {
        compareAndSwap: vi.fn(),
        createGeneration: vi.fn(),
        readBundle: vi.fn(),
        startSessionPrewarm: vi.fn(),
        peekBundle: vi.fn(() => ({
          session: JSON.stringify(canonicalSession),
          codeVerifier: 'service-spec-verifier',
          user: JSON.stringify(canonicalSession.user),
        })),
      },
    });
    const transcriber = getTranscriber(service);
    const directTranscribe = transcriber.transcribe.bind(transcriber);
    Object.defineProperty(service, 'transcribeBlob', {
      configurable: true,
      value: (blob: Blob, owner = mockAuthService.currentUserId()) => directTranscribe(blob, owner),
    });
    transcriber.transcribe = (blob, owner) =>
      (service as unknown as { transcribeBlob: TranscriberProbe['transcribe'] }).transcribeBlob(blob, owner);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__');
    cleanupSpeechToTextServiceSpecContext(context);
  });

  registerSpeechToTextRecordingStartSpecs(() => context);

  describe('transcribing state coordination', () => {
    it('取消录音不应清空其他任务持有的转写状态', () => {
      const transcribingState = (service as unknown as {
        transcribingState: { begin: () => () => void };
      }).transcribingState;
      const releaseTranscribing = transcribingState.begin();
      service.cancelRecording();
      expect(service.isTranscribing()).toBe(true);
      releaseTranscribing();
      expect(service.isTranscribing()).toBe(false);
    });

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
      vi.spyOn(getTranscriber(service), 'transcribe')
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

    it('同一 recorder 重复停止转写时应复用单一操作且仅调用一次 stop', async () => {
      const recorder = {
        state: 'recording',
        mimeType: 'audio/webm',
        ondataavailable: null as ((event: BlobEvent) => void) | null,
        onstop: null as (() => void | Promise<void>) | null,
        stop: vi.fn(),
        stream: {
          getTracks: () => [] as MediaStreamTrack[],
        },
      };
      const recorderState = service as unknown as {
        mediaRecorder: typeof recorder;
        audioChunks: Blob[];
        recordingOwnerUserId: string | null;
      };
      recorderState.mediaRecorder = recorder;
      recorderState.audioChunks = [new Blob([new Uint8Array(1600)], { type: 'audio/webm' })];
      recorderState.recordingOwnerUserId = 'local-user';
      const transcribeSpy = vi.spyOn(
        service as unknown as {
          transcribeOrCacheRecording: (blob: Blob, ownerUserId: string | null) => Promise<string>;
        },
        'transcribeOrCacheRecording',
      ).mockResolvedValueOnce('single stop result');
      const first = service.stopAndTranscribe();
      const second = service.stopAndTranscribe();
      expect(recorder.stop).toHaveBeenCalledTimes(1);
      await recorder.onstop?.();
      await expect(first).resolves.toBe('single stop result');
      await expect(second).resolves.toBe('single stop result');
      expect(transcribeSpy).toHaveBeenCalledTimes(1);
    });

    it('stop 事件未开始处理前取消应结算等待中操作且不重复 stop', async () => {
      const stopTrack = vi.fn();
      const recorder = {
        state: 'recording',
        mimeType: 'audio/webm',
        ondataavailable: null as ((event: BlobEvent) => void) | null,
        onstop: null as (() => void | Promise<void>) | null,
        stop: vi.fn(),
        stream: {
          getTracks: () => [{ stop: stopTrack }] as unknown as MediaStreamTrack[],
        },
      };
      const recorderState = service as unknown as {
        mediaRecorder: typeof recorder;
        audioChunks: Blob[];
        recordingOwnerUserId: string | null;
      };
      recorderState.mediaRecorder = recorder;
      recorderState.audioChunks = [new Blob([new Uint8Array(1600)], { type: 'audio/webm' })];
      recorderState.recordingOwnerUserId = 'local-user';
      const transcribeSpy = vi.spyOn(
        service as unknown as {
          transcribeOrCacheRecording: (blob: Blob, ownerUserId: string | null) => Promise<string>;
        },
        'transcribeOrCacheRecording',
      );
      const result = service.stopAndTranscribe();
      service.cancelRecording();
      expect(recorder.stop).toHaveBeenCalledTimes(1);
      await expect(result).resolves.toBe('');
      expect(transcribeSpy).not.toHaveBeenCalled();
      expect(stopTrack).toHaveBeenCalledTimes(1);
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

    it('旧 recorder 的 stop 回调晚到时应使用旧会话快照且不得释放新会话流', async () => {
      const oldStopTrack = vi.fn();
      const newStopTrack = vi.fn();
      const oldRecorder = {
        state: 'recording',
        mimeType: 'audio/webm',
        ondataavailable: null as ((event: BlobEvent) => void) | null,
        onstop: null as (() => void | Promise<void>) | null,
        stop: vi.fn(),
        stream: {
          getTracks: () => [{ stop: oldStopTrack }] as unknown as MediaStreamTrack[],
        },
      };
      const newRecorder = {
        state: 'recording',
        mimeType: 'audio/mp4',
        ondataavailable: null as ((event: BlobEvent) => void) | null,
        onstop: null as (() => void | Promise<void>) | null,
        stop: vi.fn(),
        stream: {
          getTracks: () => [{ stop: newStopTrack }] as unknown as MediaStreamTrack[],
        },
      };
      const oldChunks = [new Blob([new Uint8Array(1600)], { type: 'audio/webm' })];
      const newChunks = [new Blob([new Uint8Array(3200)], { type: 'audio/mp4' })];
      const recorderState = service as unknown as {
        mediaRecorder: typeof oldRecorder | typeof newRecorder | null;
        audioChunks: Blob[];
        recordingOwnerUserId: string | null;
      };
      recorderState.mediaRecorder = oldRecorder;
      recorderState.audioChunks = oldChunks;
      recorderState.recordingOwnerUserId = 'user-a';
      isRecording.set(true);
      let resolveOldTranscription!: (text: string) => void;
      const transcribeSpy = vi.spyOn(
        service as unknown as {
          transcribeOrCacheRecording: (blob: Blob, ownerUserId: string | null) => Promise<string>;
        },
        'transcribeOrCacheRecording',
      ).mockImplementationOnce(() => new Promise(resolve => {
        resolveOldTranscription = resolve;
      }));
      const oldResult = service.stopAndTranscribe();
      recorderState.mediaRecorder = newRecorder;
      recorderState.audioChunks = newChunks;
      recorderState.recordingOwnerUserId = 'user-b';
      isRecording.set(true);
      const oldStopHandling = oldRecorder.onstop?.();
      expect(transcribeSpy).toHaveBeenCalledTimes(1);
      const [capturedBlob, capturedOwner] = transcribeSpy.mock.calls[0];
      expect(capturedBlob.size).toBe(1600);
      expect(capturedBlob.type).toBe('audio/webm');
      expect(capturedOwner).toBe('user-a');
      expect(service.isRecording()).toBe(true);
      resolveOldTranscription('old session text');
      await expect(oldResult).resolves.toBe('old session text');
      await oldStopHandling;
      expect(oldStopTrack).toHaveBeenCalledTimes(1);
      expect(newStopTrack).not.toHaveBeenCalled();
      expect(recorderState.mediaRecorder).toBe(newRecorder);
      expect(recorderState.recordingOwnerUserId).toBe('user-b');
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
      const transcribeSpy = vi.spyOn(getTranscriber(service), 'transcribe')
        .mockImplementationOnce(async () => {
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
      vi.spyOn(getTranscriber(service), 'transcribe')
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

      vi.spyOn(getTranscriber(service), 'transcribe')
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

    it('stale authority 应静默保留写前缓存且不安排即时重放', async () => {
      vi.useFakeTimers();
      attachRecordedAudio();
      mockAuthService.currentUserId.set('user-a');
      (service as unknown as { recordingOwnerUserId: string | null }).recordingOwnerUserId = 'user-a';
      const staleError = new SpeechToTextStaleAuthorityError('SESSION_TEMPORARILY_UNAVAILABLE');
      vi.spyOn(getTranscriber(service), 'transcribe')
        .mockRejectedValueOnce(staleError);
      const cacheSpy = vi.spyOn(service as unknown as { saveToOfflineCache: (blob: Blob, owner?: string | null) => Promise<OfflineCacheSaveResult> }, 'saveToOfflineCache')
        .mockResolvedValueOnce({ id: 'owner-switch-cache-entry', state: 'owned' });
      const deleteSpy = vi.spyOn(service as unknown as { deleteFromCache: (id: string) => Promise<void> }, 'deleteFromCache');
      const replaySpy = vi.spyOn(service as unknown as { processOfflineCacheAndCreateEntries: () => Promise<void> }, 'processOfflineCacheAndCreateEntries');
      await expect(service.stopAndTranscribe()).rejects.toBe(staleError);
      await vi.advanceTimersByTimeAsync(1500);
      expect((service as unknown as { isRetryableTranscribeError(error: unknown): boolean })
        .isRetryableTranscribeError(staleError)).toBe(true);
      expect(cacheSpy).toHaveBeenCalledWith(expect.any(Blob), 'user-a');
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(replaySpy).not.toHaveBeenCalled();
      expect(mockLoggerService.error).not.toHaveBeenCalled();
      expect(mockToastService.warning).not.toHaveBeenCalled();
    });

    it('在线重试缓存成功后应安排延迟重放', async () => {
      vi.useFakeTimers();
      attachRecordedAudio();

      vi.spyOn(getTranscriber(service), 'transcribe')
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

      vi.spyOn(getTranscriber(service), 'transcribe')
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
      const handler = (service as unknown as { onlineHandler: (() => void) | null }).onlineHandler;
      expect(handler).not.toBeNull();
      expect(typeof handler).toBe('function');
    });

    it('手动清理 onlineHandler 后应安全', () => {
      const svc = service as unknown as { onlineHandler: (() => void) | null };
      const handler = svc.onlineHandler;

      if (handler) {
        window.removeEventListener('online', handler);
        svc.onlineHandler = null;
      }

      expect(svc.onlineHandler).toBeNull();
    });

    it('清理后重复移除不应抛出错误（幂等）', () => {
      const svc = service as unknown as { onlineHandler: (() => void) | null };

      if (svc.onlineHandler) {
        window.removeEventListener('online', svc.onlineHandler);
        svc.onlineHandler = null;
      }
      expect(() => {
        if (svc.onlineHandler) {
          window.removeEventListener('online', svc.onlineHandler);
          svc.onlineHandler = null;
        }
      }).not.toThrow();
    });
  });
});
