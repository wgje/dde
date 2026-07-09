/**
 * 语音转文字服务
 * 
 * 使用 Supabase Edge Function 调用 Groq API 进行语音转写
 * 支持离线缓存和自动重试
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SupabaseClientService } from './supabase-client.service';
import { AuthService } from './auth.service';
import { BlackBoxService } from './black-box.service';
import { ToastService } from './toast.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { EventBusService } from './event-bus.service';
import { FOCUS_CONFIG } from '../config/focus.config';
import { ErrorCodes, ErrorMessages } from '../utils/result';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';
// eslint-disable-next-line no-restricted-imports -- SessionManagerService 尚未迁移到 src/services/，语音转写恢复需复用其会话校验能力
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { SpeechToTextDurationTickerController } from './speech-to-text-duration-ticker.controller';
import { SpeechToTextOfflineCacheStore, type OfflineAudioCacheSaveResult } from './speech-to-text-offline-cache.store';
import { SpeechToTextOfflineReplayController } from './speech-to-text-offline-replay.controller';
import { SpeechToTextOwnerSettlementController } from './speech-to-text-owner-settlement.controller';
import { SpeechToTextTranscribingStateController } from './speech-to-text-transcribing-state.controller';
import { createSpeechToTextTranscriber } from './speech-to-text-transcriber-options.factory';
import {
  buildMediaRecorderOptions,
  hasAudioInputDevice,
  isControlledUpstreamRetryableTranscribeError,
  isRetryableTranscribeError,
  resolveFirstSupportedAudioMimeType,
  resolveOfflineCacheRecordingFeedback,
  resolveRecordedAudioSizeFeedback,
  resolveRecordedAudioSizeIssue,
  resolveRecordingUnavailableFeedback,
  resolveRetryableStopTranscribeFeedback,
  resolveRetryableTranscribeReplayDelayMs,
  resolveStartRecordingFailureFeedback,
  shouldScheduleOfflineCacheReplay,
} from './speech-to-text.helpers';
import { 
  isRecording, 
  isTranscribing, 
  offlinePendingCount,
  remainingQuota,
  recordingDurationSec
} from '../state/focus-stores';

@Injectable({
  providedIn: 'root'
})
export class SpeechToTextService {
  private supabaseClient = inject(SupabaseClientService);
  private auth = inject(AuthService);
  private blackBoxService = inject(BlackBoxService);
  private toast = inject(ToastService);
  private network = inject(NetworkAwarenessService);
  private logger = inject(LoggerService);
  private eventBus = inject(EventBusService);
  private sessionManager = inject(SessionManagerService);
  
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private recordingStartTime: number = 0;
  private recordingOwnerUserId: string | null = null;
  private db: IDBDatabase | null = null;
  private initIndexedDBPromise: Promise<void> | null = null;
  private onlineHandler: (() => void) | null = null;
  private readonly destroyRef = inject(DestroyRef);
  private recoveryReplayTimeout: ReturnType<typeof setTimeout> | null = null;
  private replayOfflineCachePromise: Promise<void> | null = null;
  private startRecordingPromise: Promise<void> | null = null;
  private destroyed = false;
  // 使用 Signal 管理状态，组件直接读取
  readonly isRecording = isRecording;
  readonly isTranscribing = isTranscribing;
  readonly offlinePendingCount = offlinePendingCount;
  readonly remainingQuota = remainingQuota;
  /**
   * 【根因修复 2026-04-20】录音时长秒数（由服务单一来源驱动，取代组件内各自维护的 timer）。
   */
  readonly recordingDurationSec = recordingDurationSec;

  private readonly config = FOCUS_CONFIG.SPEECH_TO_TEXT;
  private readonly IDB_NAME = FOCUS_CONFIG.SYNC.IDB_NAME;
  private readonly CACHE_STORE = FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE;
  private readonly RETRYABLE_SESSION_RECOVERY_ERROR = 'SESSION_TEMPORARILY_UNAVAILABLE';
  private readonly UNKNOWN_OFFLINE_AUDIO_OWNER = '__legacy_unknown_owner__';
  private readonly OFFLINE_REPLAY_BATCH_SIZE = 2;
  private readonly OFFLINE_REPLAY_RETRY_DELAY_MS = 1500;
  private readonly OFFLINE_REPLAY_CONTINUATION_DELAY_MS = 15_000;
  private readonly DEFAULT_UPSTREAM_RETRY_DELAY_MS = 30_000;
  private readonly offlineCacheStore = new SpeechToTextOfflineCacheStore({
    dbProvider: () => this.db,
    storeName: this.CACHE_STORE,
    unknownOwnerUserId: this.UNKNOWN_OFFLINE_AUDIO_OWNER,
  });
  private readonly transcriber = createSpeechToTextTranscriber({
    auth: this.auth,
    sessionManager: this.sessionManager,
    supabaseClient: this.supabaseClient,
    toast: this.toast,
    logger: this.logger,
    retryableSessionRecoveryError: this.RETRYABLE_SESSION_RECOVERY_ERROR,
    defaultUpstreamRetryDelayMs: this.DEFAULT_UPSTREAM_RETRY_DELAY_MS,
    maxUpstreamRetryDelayMs: this.OFFLINE_REPLAY_CONTINUATION_DELAY_MS,
    getCurrentUserId: () => this.auth.currentUserId(),
    setControlledRetryDelayMs: value => { this.controlledUpstreamRetryDelayMs = value; },
  });
  private readonly durationTicker = new SpeechToTextDurationTickerController({
    getRecordingStartTime: () => this.recordingStartTime,
    setDuration: value => recordingDurationSec.set(value),
  });
  private readonly ownerSettlement = new SpeechToTextOwnerSettlementController({
    isDestroyed: () => this.destroyed,
    onTimeout: reason => {
      this.logger.warn(
        'SpeechToText',
        'Timed out waiting for auth owner handoff before replay/count refresh',
        { reason }
      );
    },
  });
  private readonly transcribingState = new SpeechToTextTranscribingStateController(
    value => isTranscribing.set(value)
  );
  private readonly offlineReplay = new SpeechToTextOfflineReplayController({
    batchSize: this.OFFLINE_REPLAY_BATCH_SIZE,
    cacheStore: this.offlineCacheStore,
    continuationDelayMs: this.OFFLINE_REPLAY_CONTINUATION_DELAY_MS,
    createBlackBoxEntry: (content, userId, clientOperationId) =>
      this.blackBoxService.createDurably({ content, userId, clientOperationId }),
    currentUserId: () => this.auth.currentUserId(),
    ensureReady: () => {
      if (!this.db) {
        return this.initIndexedDB();
      }
      return undefined;
    },
    isOnline: () => this.network.isOnline(),
    isRetryableTranscribeError: error => this.isRetryableTranscribeError(error),
    logger: this.logger,
    runTranscribing: operation => this.transcribingState.run(operation),
    scheduleContinuation: (reason, delayMs) => this.scheduleOfflineCacheReplay(reason, delayMs),
    scheduleRetryableTranscribeReplay: (error, reason) =>
      this.scheduleRetryableTranscribeReplay(error, reason),
    toastWarning: (title, message) => this.toast.warning(title, message),
    transcribeBlob: (blob, expectedOwnerUserId) =>
      this.transcribeBlob(blob, expectedOwnerUserId),
    unknownOwnerUserId: this.UNKNOWN_OFFLINE_AUDIO_OWNER,
    updatePendingCount: () => this.updateOfflinePendingCount(),
    deleteFromCache: id => this.deleteFromCache(id),
  });
  private readonly offlineCacheWriteFailures = new WeakSet<object>();
  private controlledUpstreamRetryDelayMs: number | null = null;
  
  constructor() {
    // 初始化 IndexedDB
    void this.initIndexedDB().catch(error => {
      this.logger.warn('SpeechToText', 'Initial IndexedDB setup deferred', error instanceof Error ? error.message : String(error));
    });
    
    // 监听网络恢复
    this.setupNetworkListener();
    this.setupSessionRecoveryListener();

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.cancelRecording();

      if (this.recoveryReplayTimeout) {
        clearTimeout(this.recoveryReplayTimeout);
        this.recoveryReplayTimeout = null;
      }

      this.ownerSettlement.destroy();
    });
  }
  
  /**
   * 初始化 IndexedDB
   */
  private async initIndexedDB(): Promise<void> {
    if (this.db) return;
    if (this.initIndexedDBPromise) return this.initIndexedDBPromise;

    this.initIndexedDBPromise = (async () => {
      this.db = await this.openFocusModeDB();
      await this.migrateLegacyOfflineAudioOwners();
      await this.updateOfflinePendingCount();
    })().finally(() => {
      this.initIndexedDBPromise = null;
    });

    return this.initIndexedDBPromise;
  }

  private openFocusModeDB(): Promise<IDBDatabase> {
    return openIndexedDBAdaptive({
      dbName: this.IDB_NAME,
      targetVersion: FOCUS_CONFIG.SYNC.IDB_VERSION,
      requiredStores: [this.CACHE_STORE],
      ensureStores: db => {
        if (!db.objectStoreNames.contains(this.CACHE_STORE)) {
          db.createObjectStore(this.CACHE_STORE, { keyPath: 'id' });
        }
      }
    });
  }

  /**
   * 设置网络恢复监听
   * 保存 handler 引用以便在销毁时解绑，避免测试污染
   */
  private setupNetworkListener(): void {
    if (typeof window === 'undefined') return;
    this.onlineHandler = () => {
      this.logger.info('SpeechToText', 'Network restored, processing offline audio cache');
      void this.runOfflineCacheReplay('network-restored');
    };
    window.addEventListener('online', this.onlineHandler);

    // 在服务销毁时清理监听器
    this.destroyRef.onDestroy(() => {
      if (this.onlineHandler) {
        window.removeEventListener('online', this.onlineHandler);
        this.onlineHandler = null;
      }
    });
  }

  private setupSessionRecoveryListener(): void {
    this.eventBus.onSessionRestored$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        this.ownerSettlement.deferUntilSettled(
          () => this.auth.currentUserId() === event.userId,
          () => {
            void this.updateOfflinePendingCount();

            if (!this.network.isOnline()) {
              return;
            }

            this.logger.info('SpeechToText', 'Session restored, replaying offline audio cache');
            void this.runOfflineCacheReplay('session-restored');
          },
          `session-restored:${event.source}`
        );
      });

    this.eventBus.onSessionInvalidated$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        this.ownerSettlement.deferUntilSettled(
          () => event.userId == null || this.auth.currentUserId() !== event.userId,
          () => {
            void this.updateOfflinePendingCount();
          },
          `session-invalidated:${event.source}`
        );
      });
  }

  /**
   * 处理离线缓存并创建黑匣子条目
   */
  private async processOfflineCacheAndCreateEntries(): Promise<void> {
    try {
      const results = await this.processOfflineCache();
      if (this.destroyed) {
        return;
      }
      if (results.length > 0) {
        this.toast.success('离线录音已处理', `已转写 ${results.length} 条离线录音`);
      }
    } catch (e) {
      if (this.destroyed) {
        return;
      }
      this.logger.error('SpeechToText', 'Failed to process offline cache',
        e instanceof Error ? e.message : String(e));
    }
  }
  
  /**
   * 检查浏览器是否支持录音
   */
  isSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia) && 
           typeof MediaRecorder !== 'undefined';
  }
  
  /**
   * 获取不支持时的降级方案提示
   */
  getFallbackMessage(): string {
    if (!this.isSupported()) {
      return ErrorMessages[ErrorCodes.FOCUS_RECORDING_NOT_SUPPORTED];
    }
    return '';
  }
  
  /**
   * 获取浏览器支持的音频格式
   * iOS Safari 不支持 webm，需要使用 mp4
   */
  private getSupportedMimeType(): string {
    return resolveFirstSupportedAudioMimeType(
      this.config.AUDIO_MIME_TYPES,
      type => MediaRecorder.isTypeSupported(type)
    );
  }
  
  /**
   * 检查麦克风设备是否可用
   * 在测试环境或无麦克风设备时返回 false
   */
  async checkMicrophoneAvailability(): Promise<boolean> {
    try {
      // 检查是否支持 mediaDevices API
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !navigator.mediaDevices.enumerateDevices) {
        this.logger.debug('SpeechToText', 'MediaDevices API not supported');
        return false;
      }

      // 检查是否有音频输入设备
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasAudioInput = hasAudioInputDevice(devices);
      
      if (!hasAudioInput) {
        this.logger.debug('SpeechToText', 'No audio input devices found');
        return false;
      }

      return true;
    } catch (err) {
      this.logger.debug('SpeechToText', 'Failed to check microphone availability', err instanceof Error ? err.message : String(err));
      return false;
    }
  }
  
  /**
   * 开始录音
   * ⚠️ iOS Safari 兼容性：需要在用户手势内调用
   */
  async startRecording(): Promise<void> {
    if (this.isRecording()) return;
    if (this.startRecordingPromise) return this.startRecordingPromise;

    this.startRecordingPromise = this.doStartRecording().finally(() => {
      this.startRecordingPromise = null;
    });

    return this.startRecordingPromise;
  }

  private async doStartRecording(): Promise<void> {
    const isAvailable = await this.checkMicrophoneAvailability();
    if (!isAvailable) {
      const feedback = resolveRecordingUnavailableFeedback();
      this.logger.warn('SpeechToText', feedback.message);
      this.toast.warning(feedback.title, feedback.message);
      return;
    }

    try {
      const mimeType = this.getSupportedMimeType();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: this.config.SAMPLE_RATE
        }
      });

      this.mediaRecorder = this.createMediaRecorder(stream, mimeType);
      this.audioChunks = [];
      this.recordingStartTime = Date.now();
      this.recordingOwnerUserId = this.auth.currentUserId();

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.start(1000);
      isRecording.set(true);
      this.durationTicker.start();

      this.logger.debug('SpeechToText', `Recording started with mimeType: ${mimeType}`);
    } catch (err) {
      this.logger.error('SpeechToText', 'Failed to start recording', err instanceof Error ? err.message : String(err));
      this.showStartRecordingError(err);
    }
  }

  private createMediaRecorder(stream: MediaStream, mimeType: string): MediaRecorder {
    try {
      return new MediaRecorder(
        stream,
        buildMediaRecorderOptions(mimeType, this.config.AUDIO_BITS_PER_SECOND)
      );
    } catch (recorderErr) {
      stream.getTracks().forEach(track => track.stop());
      throw recorderErr;
    }
  }

  private showStartRecordingError(err: unknown): void {
    const feedback = resolveStartRecordingFailureFeedback(
      err,
      ErrorMessages[ErrorCodes.FOCUS_RECORDING_PERMISSION_DENIED]
    );
    this.toast.error(feedback.title, feedback.message);
  }
  
  /**
   * 停止录音（不转写）
   */
  stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
      isRecording.set(false);
      this.durationTicker.stop();
      this.recordingOwnerUserId = null;
    }
  }
  
  /**
   * 取消录音（丢弃所有数据，不转写）
   * 用于用户手指/鼠标超出录音区域时的取消操作
   */
  cancelRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // 清除 onstop 回调，防止触发转写
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    // 丢弃所有已收集的音频数据
    this.audioChunks = [];
    this.recordingStartTime = 0;
    this.recordingOwnerUserId = null;
    // 【修复 P2-06】清空 mediaRecorder 引用，防止后续误触发
    this.mediaRecorder = null;
    isRecording.set(false);
    this.transcribingState.reset();
    this.durationTicker.stop();
    this.logger.debug('SpeechToText', 'Recording cancelled, all data discarded');
  }
  
  /**
   * 停止录音并转写
   */
  async stopAndTranscribe(): Promise<string> {
    const recorder = this.mediaRecorder;
    if (!recorder) {
      throw new Error('未开始录音');
    }

    return new Promise((resolve, reject) => {
      recorder.onstop = async () => {
        await this.handleRecorderStop(resolve, reject);
      };

      recorder.stop();
    });
  }

  private async handleRecorderStop(
    resolve: (value: string | PromiseLike<string>) => void,
    reject: (reason?: unknown) => void
  ): Promise<void> {
    isRecording.set(false);
    const releaseTranscribing = this.transcribingState.begin();
    this.durationTicker.stop();

    const expectedOwnerUserId = this.recordingOwnerUserId;
    const audioBlob = this.createRecordedAudioBlob();

    try {
      const sizeValidationResult = this.resolveRecordedAudioSize(audioBlob);
      if (sizeValidationResult !== null) {
        resolve(sizeValidationResult);
        return;
      }

      resolve(await this.transcribeOrCacheRecording(audioBlob, expectedOwnerUserId));
    } catch (error) {
      this.logger.error('SpeechToText', 'Transcription failed', error instanceof Error ? error.message : String(error));
      await this.handleRetryableStopTranscribeError(error, audioBlob, expectedOwnerUserId, resolve, reject);
    } finally {
      releaseTranscribing();
      this.recordingOwnerUserId = null;
      this.releaseCurrentRecorderStream();
    }
  }

  private createRecordedAudioBlob(): Blob {
    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    return new Blob(this.audioChunks, { type: mimeType });
  }

  private resolveRecordedAudioSize(audioBlob: Blob): string | null {
    const sizeIssue = resolveRecordedAudioSizeIssue(
      audioBlob.size,
      this.config.MIN_FILE_SIZE,
      this.config.MAX_FILE_SIZE
    );
    const feedback = resolveRecordedAudioSizeFeedback(sizeIssue, {
      tooShortMessage: ErrorMessages[ErrorCodes.FOCUS_RECORDING_TOO_SHORT],
      tooLongMessage: ErrorMessages[ErrorCodes.FOCUS_RECORDING_TOO_LONG],
    });

    if (feedback) {
      this.toast.warning(feedback.title, feedback.message);
      return feedback.result;
    }

    return null;
  }

  private async transcribeOrCacheRecording(audioBlob: Blob, expectedOwnerUserId: string | null): Promise<string> {
    if (!this.network.isOnline()) {
      return this.cacheOfflineRecording(audioBlob, expectedOwnerUserId);
    }

    let writeAheadCache: OfflineAudioCacheSaveResult;
    try {
      writeAheadCache = await this.saveToOfflineCache(audioBlob, expectedOwnerUserId);
    } catch (cacheErr) {
      this.toast.error('保存失败', '无法保存录音，请重试');
      this.markOfflineCacheWriteFailure(cacheErr);
      throw cacheErr;
    }

    try {
      const text = await this.transcribeBlob(audioBlob, expectedOwnerUserId);
      if (!this.isRecordingOwnerActive(expectedOwnerUserId)) {
        throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
      }

      await this.deleteFromCache(writeAheadCache.id);
      void this.updateOfflinePendingCount();
      return text;
    } catch (error) {
      if (!this.isRetryableTranscribeError(error)) {
        throw error;
      }

      return this.resolveRetryableCachedTranscribeFailure(error, writeAheadCache);
    }
  }

  private async cacheOfflineRecording(audioBlob: Blob, expectedOwnerUserId: string | null): Promise<string> {
    try {
      const cacheResult = await this.saveToOfflineCache(audioBlob, expectedOwnerUserId);
      const feedback = resolveOfflineCacheRecordingFeedback(cacheResult.state);
      if (feedback.level === 'warning') {
        this.toast.warning(feedback.title, feedback.message);
      } else {
        this.toast.info(feedback.title, feedback.message);
      }
    } catch (cacheErr) {
      this.logger.error('SpeechToText', '离线缓存失败', cacheErr instanceof Error ? cacheErr.message : String(cacheErr));
      this.toast.error('保存失败', '无法保存录音，请重试');
      this.markOfflineCacheWriteFailure(cacheErr);
      throw cacheErr;
    }

    return '[离线录音，稍后转写]';
  }

  private async handleRetryableStopTranscribeError(
    error: unknown,
    audioBlob: Blob,
    expectedOwnerUserId: string | null,
    resolve: (value: string | PromiseLike<string>) => void,
    reject: (reason?: unknown) => void
  ): Promise<void> {
    if (this.isOfflineCacheWriteFailure(error)) {
      reject(error);
      return;
    }

    // 使用 TypeError + 离线状态双重判断，避免依赖浏览器特定 error.message。
    if (!this.isRetryableTranscribeError(error)) {
      reject(error);
      return;
    }

    try {
      const cacheResult = await this.saveToOfflineCache(audioBlob, expectedOwnerUserId);
      resolve(this.resolveRetryableCachedTranscribeFailure(error, cacheResult));
    } catch (cacheErr) {
      this.logger.error('SpeechToText', 'Failed to cache audio after retryable transcribe error', cacheErr instanceof Error ? cacheErr.message : String(cacheErr));
      this.toast.error('保存失败', '无法保存录音，请重试');
      reject(cacheErr);
    }
  }

  private resolveRetryableCachedTranscribeFailure(
    error: unknown,
    cacheResult: OfflineAudioCacheSaveResult
  ): string {
    const feedback = resolveRetryableStopTranscribeFeedback(
      cacheResult.state,
      ErrorMessages[ErrorCodes.FOCUS_NETWORK_ERROR]
    );
    if (feedback.shouldScheduleReplay) {
      this.scheduleRetryableTranscribeReplay(error, 'retryable-transcribe-error');
    }
    this.toast.warning(feedback.toast.title, feedback.toast.message);
    return feedback.result;
  }

  private markOfflineCacheWriteFailure(error: unknown): void {
    if (typeof error === 'object' && error !== null) {
      this.offlineCacheWriteFailures.add(error);
    }
  }

  private isOfflineCacheWriteFailure(error: unknown): boolean {
    return typeof error === 'object' && error !== null && this.offlineCacheWriteFailures.has(error);
  }

  private releaseCurrentRecorderStream(): void {
    this.mediaRecorder?.stream.getTracks().forEach(track => track.stop());
  }

  /**
   * 实际调用 Edge Function 进行转写
   *
   * ⚠️ 注意：调用前需确保用户已登录，否则请求会被 Supabase 网关拦截
   *
   * 使用 fetch 而非 functions.invoke，以保留 multipart/form-data 和超时控制。
   * token 获取统一走 SessionManager 刷新链路，避免把临期 JWT 直接发送到网关。
   */
  private async transcribeBlob(audioBlob: Blob, expectedOwnerUserId: string | null = this.auth.currentUserId()): Promise<string> {
    return this.transcriber.transcribe(audioBlob, expectedOwnerUserId);
  }

  private scheduleOfflineCacheReplay(reason: string, delayMs = this.OFFLINE_REPLAY_RETRY_DELAY_MS): void {
    if (!shouldScheduleOfflineCacheReplay(this.destroyed, this.network.isOnline(), !!this.recoveryReplayTimeout)) {
      return;
    }

    this.logger.info('SpeechToText', 'Scheduling offline audio replay after transient failure', { reason });
    this.recoveryReplayTimeout = setTimeout(() => {
      this.recoveryReplayTimeout = null;
      void this.runOfflineCacheReplay('delayed-retry');
    }, delayMs);
  }

  private runOfflineCacheReplay(reason: string): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve();
    }

    if (this.replayOfflineCachePromise) {
      this.logger.debug('SpeechToText', 'Offline audio replay already in progress, reusing existing run', { reason });
      return this.replayOfflineCachePromise;
    }

    if (this.recoveryReplayTimeout) {
      clearTimeout(this.recoveryReplayTimeout);
      this.recoveryReplayTimeout = null;
    }

    this.replayOfflineCachePromise = this.processOfflineCacheAndCreateEntries()
      .finally(() => {
        this.replayOfflineCachePromise = null;
      });

    return this.replayOfflineCachePromise;
  }

  private isRetryableTranscribeError(error: unknown): boolean {
    return isRetryableTranscribeError({
      error,
      isOnline: this.network.isOnline(),
      retryableSessionRecoveryError: this.RETRYABLE_SESSION_RECOVERY_ERROR,
      networkErrorCode: ErrorCodes.FOCUS_NETWORK_ERROR,
    });
  }

  private scheduleRetryableTranscribeReplay(error: unknown, reason: string): void {
    const controlledDelayMs = this.controlledUpstreamRetryDelayMs;
    this.controlledUpstreamRetryDelayMs = null;
    const delayMs = resolveRetryableTranscribeReplayDelayMs({
      isControlledUpstreamRetryableError: isControlledUpstreamRetryableTranscribeError(
        error,
        this.network.isOnline(),
        ErrorCodes.FOCUS_NETWORK_ERROR
      ),
      controlledDelayMs,
      defaultUpstreamRetryDelayMs: this.DEFAULT_UPSTREAM_RETRY_DELAY_MS,
      offlineReplayRetryDelayMs: this.OFFLINE_REPLAY_RETRY_DELAY_MS,
    });
    this.scheduleOfflineCacheReplay(reason, delayMs);
  }

  /**
   * 离线时暂存录音到 IndexedDB
   */
  private async saveToOfflineCache(blob: Blob, ownerUserId = this.auth.currentUserId()): Promise<OfflineAudioCacheSaveResult> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    try {
      const cacheResult = await this.offlineCacheStore.save(blob, ownerUserId);
      void this.updateOfflinePendingCount();
      if (cacheResult.state === 'quarantined') {
        this.logger.warn('SpeechToText', 'Cached offline audio without a confirmed owner; quarantined for manual review');
      }
      this.logger.debug('SpeechToText', 'Audio cached for offline processing');
      return cacheResult;
    } catch (error) {
      this.logger.error('SpeechToText', 'Failed to cache audio offline', error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }
  
  /**
   * 网络恢复后处理离线缓存
   */
  async processOfflineCache(): Promise<{ id: string; text: string }[]> {
    return this.offlineReplay.processOfflineCache();
  }

  /**
   * 从缓存中删除条目
   */
  private async deleteFromCache(id: string): Promise<void> {
    await this.offlineReplay.deleteFromCache(id);
  }

  private isRecordingOwnerActive(ownerUserId: string | null): boolean {
    return !!ownerUserId && this.auth.currentUserId() === ownerUserId;
  }
  
  /**
   * 更新离线待处理数量
   */
  private async updateOfflinePendingCount(): Promise<void> {
    await this.offlineReplay.updateOfflinePendingCount();
  }

  private async migrateLegacyOfflineAudioOwners(): Promise<void> {
    await this.offlineReplay.migrateLegacyOfflineAudioOwners();
  }
  
  /**
   * 获取录音时长（秒）
   */
  getRecordingDuration(): number {
    if (!this.isRecording()) return 0;
    return Math.round((Date.now() - this.recordingStartTime) / 1000);
  }

}
