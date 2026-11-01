/**
 * 语音转文字服务
 * 
 * 使用 Supabase Edge Function 调用 Groq API 进行语音转写
 * 支持离线缓存和自动重试
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
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
import { SessionManagerService } from '../core-bridge';
import { SpeechToTextDurationTickerController } from './speech-to-text-duration-ticker.controller';
import {
  SpeechToTextOfflineCacheStore,
  SpeechToTextOfflineCacheWriteFailureTracker,
  type OfflineAudioCacheSaveResult,
} from './speech-to-text-offline-cache.store';
import { SpeechToTextOfflineReplayController } from './speech-to-text-offline-replay.controller';
import { SpeechToTextOwnerSettlementController } from './speech-to-text-owner-settlement.controller';
import { SpeechToTextRecoveryController } from './speech-to-text-recovery.controller';
import {
  checkSpeechMicrophoneAvailability,
  isSpeechRecordingSupported,
  releaseSpeechMediaStream,
  releaseSpeechRecorderStream,
  resolveSpeechRecordingFallbackMessage,
  resolveSupportedSpeechAudioMimeType,
  type RecordingSessionContext,
  type RecordingStopOperation,
} from './speech-to-text-recording-support';
import { SpeechToTextTranscribingStateController } from './speech-to-text-transcribing-state.controller';
import { createSpeechToTextTranscriber } from './speech-to-text-transcriber-options.factory';
import { isSpeechToTextStaleAuthorityError } from './speech-to-text-transcriber';
import {
  buildMediaRecorderOptions,
  isRetryableTranscribeError,
  resolveOfflineCacheRecordingFeedback,
  resolveRecordedAudioSizeFeedback,
  resolveRecordedAudioSizeIssue,
  resolveRecordingUnavailableFeedback,
  resolveRetryableStopTranscribeFeedback,
  resolveStartRecordingFailureFeedback,
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
  private readonly destroyRef = inject(DestroyRef);
  private startRecordingPromise: Promise<boolean> | null = null;
  private recordingSessionGeneration = 0;
  private pendingRecordingOwnerToken: symbol | null = null;
  private activeRecordingOwnerToken: symbol | null = null;
  private readonly stopOperations = new Map<MediaRecorder, RecordingStopOperation>();
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
    setControlledRetryDelayMs: value => this.recovery.setControlledRetryDelayMs(value),
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
  private readonly recovery = new SpeechToTextRecoveryController({
    currentUserId: () => this.auth.currentUserId(),
    defaultUpstreamRetryDelayMs: this.DEFAULT_UPSTREAM_RETRY_DELAY_MS,
    deferUntilSettled: (isSettled, onSettled, reason) =>
      this.ownerSettlement.deferUntilSettled(isSettled, onSettled, reason),
    isDestroyed: () => this.destroyed,
    isOnline: () => this.network.isOnline(),
    logger: this.logger,
    networkErrorCode: ErrorCodes.FOCUS_NETWORK_ERROR,
    notifyReplaySuccess: count =>
      this.toast.success('离线录音已处理', `已转写 ${count} 条离线录音`),
    offlineReplayRetryDelayMs: this.OFFLINE_REPLAY_RETRY_DELAY_MS,
    processOfflineCache: () => this.processOfflineCache(),
    processReplay: () => this.processOfflineCacheAndCreateEntries(),
    refreshPendingCount: () => this.updateOfflinePendingCount(),
    scheduleReplay: (reason, delayMs) => this.scheduleOfflineCacheReplay(reason, delayMs),
    sessionInvalidated$: this.eventBus.onSessionInvalidated$,
    sessionRestored$: this.eventBus.onSessionRestored$,
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
      this.transcriber.transcribe(blob, expectedOwnerUserId),
    unknownOwnerUserId: this.UNKNOWN_OFFLINE_AUDIO_OWNER,
    updatePendingCount: () => this.updateOfflinePendingCount(),
    deleteFromCache: id => this.deleteFromCache(id),
  });
  private readonly offlineCacheWriteFailures = new SpeechToTextOfflineCacheWriteFailureTracker();
  
  constructor() {
    // 初始化 IndexedDB
    void this.initIndexedDB().catch(error => {
      this.logger.warn('SpeechToText', 'Initial IndexedDB setup deferred', error instanceof Error ? error.message : String(error));
    });
    
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.cancelRecording();
      this.recovery.destroy();
      this.ownerSettlement.destroy();
    });
  }

  private get onlineHandler(): (() => void) | null {
    return this.recovery.onlineHandler;
  }

  private set onlineHandler(value: (() => void) | null) {
    this.recovery.onlineHandler = value;
  }

  private get recoveryReplayTimeout(): ReturnType<typeof setTimeout> | null {
    return this.recovery.replayTimeout;
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

  private processOfflineCacheAndCreateEntries(): Promise<void> {
    return this.recovery.processReplayAndNotify();
  }

  isSupported(): boolean {
    return isSpeechRecordingSupported(
      navigator.mediaDevices,
      typeof MediaRecorder !== 'undefined',
    );
  }
  
  /**
   * 获取不支持时的降级方案提示
   */
  getFallbackMessage(): string {
    return resolveSpeechRecordingFallbackMessage(
      this.isSupported(),
      ErrorMessages[ErrorCodes.FOCUS_RECORDING_NOT_SUPPORTED],
    );
  }
  
  /**
   * 获取浏览器支持的音频格式
   * iOS Safari 不支持 webm，需要使用 mp4
   */
  private getSupportedMimeType(): string {
    return resolveSupportedSpeechAudioMimeType(
      this.config.AUDIO_MIME_TYPES,
      type => MediaRecorder.isTypeSupported(type),
    );
  }
  
  /**
   * 检查麦克风设备是否可用
   * 在测试环境或无麦克风设备时返回 false
   */
  async checkMicrophoneAvailability(): Promise<boolean> {
    return checkSpeechMicrophoneAvailability({
      debug: (message, detail) => this.logger.debug('SpeechToText', message, detail),
      mediaDevices: navigator.mediaDevices,
    });
  }
  
  /**
   * 开始录音
   * ⚠️ iOS Safari 兼容性：需要在用户手势内调用
   */
  async startRecording(ownerToken?: symbol): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.isRecording()) return false;
    if (this.startRecordingPromise) return false;

    const startGeneration = ++this.recordingSessionGeneration;
    const normalizedOwnerToken = ownerToken ?? null;
    this.pendingRecordingOwnerToken = normalizedOwnerToken;
    const trackedStart = this.doStartRecording(startGeneration, normalizedOwnerToken).finally(() => {
      if (this.startRecordingPromise === trackedStart) {
        this.startRecordingPromise = null;
        if (this.pendingRecordingOwnerToken === normalizedOwnerToken) {
          this.pendingRecordingOwnerToken = null;
        }
      }
    });
    this.startRecordingPromise = trackedStart;

    return this.startRecordingPromise;
  }

  private async doStartRecording(
    startGeneration: number,
    ownerToken: symbol | null,
  ): Promise<boolean> {
    const isAvailable = await this.checkMicrophoneAvailability();
    if (!this.isRecordingStartCurrent(startGeneration)) return false;
    if (!isAvailable) {
      const feedback = resolveRecordingUnavailableFeedback();
      this.logger.warn('SpeechToText', feedback.message);
      this.toast.warning(feedback.title, feedback.message);
      return false;
    }

    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    try {
      const mimeType = this.getSupportedMimeType();

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: this.config.SAMPLE_RATE
        }
      });
      if (!this.isRecordingStartCurrent(startGeneration)) {
        releaseSpeechMediaStream(stream);
        return false;
      }

      recorder = this.createMediaRecorder(stream, mimeType);
      this.activateRecorderSession(recorder, startGeneration, ownerToken);

      this.logger.debug('SpeechToText', `Recording started with mimeType: ${mimeType}`);
      return true;
    } catch (err) {
      this.handleStartRecordingFailure({ err, recorder, startGeneration, stream });
      return false;
    }
  }

  private activateRecorderSession(
    recorder: MediaRecorder,
    startGeneration: number,
    ownerToken: symbol | null,
  ): void {
    const audioChunks: Blob[] = [];
    this.mediaRecorder = recorder;
    this.audioChunks = audioChunks;
    this.recordingStartTime = Date.now();
    this.recordingOwnerUserId = this.auth.currentUserId();
    this.activeRecordingOwnerToken = ownerToken;

    recorder.ondataavailable = (event) => {
      if (!this.isRecorderSessionCurrent(recorder, startGeneration)) return;
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    recorder.start(1000);
    isRecording.set(true);
    this.durationTicker.start();
  }

  private handleStartRecordingFailure(options: {
    err: unknown;
    recorder: MediaRecorder | null;
    startGeneration: number;
    stream: MediaStream | null;
  }): void {
    const { err, recorder, startGeneration, stream } = options;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      releaseSpeechRecorderStream(recorder);
    } else if (stream) {
      releaseSpeechMediaStream(stream);
    }
    if (!this.isRecordingStartCurrent(startGeneration)) return;
    if (!recorder || this.mediaRecorder === recorder) {
      this.mediaRecorder = null;
      this.audioChunks = [];
      this.recordingStartTime = 0;
      this.recordingOwnerUserId = null;
      this.activeRecordingOwnerToken = null;
      isRecording.set(false);
      this.durationTicker.stop();
    }
    this.logger.error('SpeechToText', 'Failed to start recording', err instanceof Error ? err.message : String(err));
    this.showStartRecordingError(err);
  }

  private isRecordingStartCurrent(startGeneration: number): boolean {
    return !this.destroyed && this.recordingSessionGeneration === startGeneration;
  }

  private isRecorderSessionCurrent(recorder: MediaRecorder, generation: number): boolean {
    return this.mediaRecorder === recorder && this.isRecordingStartCurrent(generation);
  }

  private createMediaRecorder(stream: MediaStream, mimeType: string): MediaRecorder {
    return new MediaRecorder(
      stream,
      buildMediaRecorderOptions(mimeType, this.config.AUDIO_BITS_PER_SECOND)
    );
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
  cancelRecording(ownerToken?: symbol): boolean {
    if (
      ownerToken !== undefined &&
      this.pendingRecordingOwnerToken !== ownerToken &&
      this.activeRecordingOwnerToken !== ownerToken
    ) {
      return false;
    }
    const hadOwnedSession =
      this.startRecordingPromise !== null ||
      this.mediaRecorder !== null ||
      this.isRecording();
    this.recordingSessionGeneration += 1;
    this.startRecordingPromise = null;
    this.pendingRecordingOwnerToken = null;
    this.activeRecordingOwnerToken = null;
    const recorder = this.mediaRecorder;
    const stopOperation = recorder ? this.stopOperations.get(recorder) : undefined;
    if (recorder) {
      // 清除会话回调，防止排队中的最终数据与 stop 事件污染后续会话。
      if (!stopOperation?.handlingStarted) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
      }
      if (stopOperation && !stopOperation.handlingStarted) {
        stopOperation.resolve('');
      } else if (!stopOperation && recorder.state !== 'inactive') {
        recorder.stop();
      }
      releaseSpeechRecorderStream(recorder);
    }
    // 丢弃所有已收集的音频数据
    this.audioChunks = [];
    this.recordingStartTime = 0;
    this.recordingOwnerUserId = null;
    // 【修复 P2-06】清空 mediaRecorder 引用，防止后续误触发
    this.mediaRecorder = null;
    isRecording.set(false);
    this.durationTicker.stop();
    this.logger.debug('SpeechToText', 'Recording cancelled, all data discarded');
    return hadOwnedSession;
  }
  
  /**
   * 停止录音并转写
   */
  stopAndTranscribe(ownerToken?: symbol): Promise<string> {
    const recorder = this.mediaRecorder;
    if (!recorder) {
      return Promise.reject(new Error('未开始录音'));
    }
    if (
      ownerToken !== undefined &&
      this.activeRecordingOwnerToken !== ownerToken
    ) {
      return Promise.reject(new Error('录音会话不属于当前调用方'));
    }

    const existingOperation = this.stopOperations.get(recorder);
    if (existingOperation) {
      return existingOperation.promise;
    }

    const session: RecordingSessionContext = {
      recorder,
      audioChunks: this.audioChunks,
      ownerUserId: this.recordingOwnerUserId,
      generation: this.recordingSessionGeneration,
    };

    let resolveOperation!: (value: string | PromiseLike<string>) => void;
    let rejectOperation!: (reason?: unknown) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    const operation: RecordingStopOperation = {
      recorder,
      promise,
      resolve: resolveOperation,
      handlingStarted: false,
    };
    this.stopOperations.set(recorder, operation);
    void promise.then(
      () => this.clearStopOperation(operation),
      () => this.clearStopOperation(operation),
    );

    recorder.onstop = async () => {
      if (operation.handlingStarted) return;
      operation.handlingStarted = true;
      await this.handleRecorderStop(session, resolveOperation, rejectOperation);
    };

    try {
      recorder.stop();
    } catch (error) {
      rejectOperation(error);
    }

    return promise;
  }

  private clearStopOperation(operation: RecordingStopOperation): void {
    if (this.stopOperations.get(operation.recorder) === operation) {
      this.stopOperations.delete(operation.recorder);
    }
  }

  private async handleRecorderStop(
    session: RecordingSessionContext,
    resolve: (value: string | PromiseLike<string>) => void,
    reject: (reason?: unknown) => void
  ): Promise<void> {
    if (this.isRecorderSessionCurrent(session.recorder, session.generation)) {
      isRecording.set(false);
      this.durationTicker.stop();
    }
    const releaseTranscribing = this.transcribingState.begin();

    const expectedOwnerUserId = session.ownerUserId;
    const audioBlob = this.createRecordedAudioBlob(session);

    try {
      const sizeValidationResult = this.resolveRecordedAudioSize(audioBlob);
      if (sizeValidationResult !== null) {
        resolve(sizeValidationResult);
        return;
      }

      resolve(await this.transcribeOrCacheRecording(audioBlob, expectedOwnerUserId));
    } catch (error) {
      if (!isSpeechToTextStaleAuthorityError(error)) {
        this.logger.error('SpeechToText', 'Transcription failed', error instanceof Error ? error.message : String(error));
      }
      await this.handleRetryableStopTranscribeError(error, audioBlob, expectedOwnerUserId, resolve, reject);
    } finally {
      releaseTranscribing();
      if (this.isRecorderSessionCurrent(session.recorder, session.generation)) {
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.recordingStartTime = 0;
        this.recordingOwnerUserId = null;
        this.activeRecordingOwnerToken = null;
      }
      releaseSpeechRecorderStream(session.recorder);
    }
  }

  private createRecordedAudioBlob(session: RecordingSessionContext): Blob {
    const mimeType = session.recorder.mimeType || 'audio/webm';
    return new Blob(session.audioChunks, { type: mimeType });
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
      this.offlineCacheWriteFailures.mark(cacheErr);
      throw cacheErr;
    }

    try {
      const text = await this.transcriber.transcribe(audioBlob, expectedOwnerUserId);
      if (!expectedOwnerUserId || this.auth.currentUserId() !== expectedOwnerUserId) {
        throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
      }

      await this.deleteFromCache(writeAheadCache.id);
      void this.updateOfflinePendingCount();
      return text;
    } catch (error) {
      if (isSpeechToTextStaleAuthorityError(error)) {
        throw error;
      }
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
      this.offlineCacheWriteFailures.mark(cacheErr);
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
    if (isSpeechToTextStaleAuthorityError(error)) {
      reject(error);
      return;
    }
    if (this.offlineCacheWriteFailures.has(error)) {
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

  private scheduleOfflineCacheReplay(reason: string, delayMs = this.OFFLINE_REPLAY_RETRY_DELAY_MS): void {
    this.recovery.schedule(reason, delayMs);
  }

  private runOfflineCacheReplay(reason: string): Promise<void> {
    return this.recovery.run(reason);
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
    this.recovery.scheduleRetryableReplay(error, reason);
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
