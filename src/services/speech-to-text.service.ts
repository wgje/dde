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
import { environment } from '../environments/environment';
// eslint-disable-next-line no-restricted-imports -- SessionManagerService 尚未迁移到 src/services/，语音转写恢复需复用其会话校验能力
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import type { Session } from '@supabase/supabase-js';
import { 
  isRecording, 
  isTranscribing, 
  offlinePendingCount,
  remainingQuota 
} from '../state/focus-stores';
import { OfflineAudioCacheEntry } from '../models/focus';

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
  private ownerSettlementTimeout: ReturnType<typeof setTimeout> | null = null;
  
  // 使用 Signal 管理状态，组件直接读取
  readonly isRecording = isRecording;
  readonly isTranscribing = isTranscribing;
  readonly offlinePendingCount = offlinePendingCount;
  readonly remainingQuota = remainingQuota;
  
  private readonly config = FOCUS_CONFIG.SPEECH_TO_TEXT;
  private readonly IDB_NAME = FOCUS_CONFIG.SYNC.IDB_NAME;
  private readonly CACHE_STORE = FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE;
  private readonly ACCESS_TOKEN_EXPIRY_BUFFER_SECONDS = 60;
  private readonly RETRYABLE_SESSION_RECOVERY_ERROR = 'SESSION_TEMPORARILY_UNAVAILABLE';
  private readonly UNKNOWN_OFFLINE_AUDIO_OWNER = '__legacy_unknown_owner__';
  
  constructor() {
    // 初始化 IndexedDB
    void this.initIndexedDB().catch(error => {
      this.logger.warn('SpeechToText', 'Initial IndexedDB setup deferred', error instanceof Error ? error.message : String(error));
    });
    
    // 监听网络恢复
    this.setupNetworkListener();
    this.setupSessionRecoveryListener();

    this.destroyRef.onDestroy(() => {
      if (this.recoveryReplayTimeout) {
        clearTimeout(this.recoveryReplayTimeout);
        this.recoveryReplayTimeout = null;
      }

      if (this.ownerSettlementTimeout) {
        clearTimeout(this.ownerSettlementTimeout);
        this.ownerSettlementTimeout = null;
      }
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
        this.deferUntilOwnerSettled(
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
        this.deferUntilOwnerSettled(
          () => event.userId == null || this.auth.currentUserId() !== event.userId,
          () => {
            void this.updateOfflinePendingCount();
          },
          `session-invalidated:${event.source}`
        );
      });
  }

  private deferUntilOwnerSettled(
    isSettled: () => boolean,
    onSettled: () => void,
    reason: string,
    attemptsRemaining = 20
  ): void {
    if (this.ownerSettlementTimeout) {
      clearTimeout(this.ownerSettlementTimeout);
      this.ownerSettlementTimeout = null;
    }

    if (isSettled()) {
      onSettled();
      return;
    }

    if (attemptsRemaining <= 0) {
      this.logger.warn('SpeechToText', 'Timed out waiting for auth owner handoff before replay/count refresh', { reason });
      return;
    }

    this.ownerSettlementTimeout = setTimeout(() => {
      this.ownerSettlementTimeout = null;
      this.deferUntilOwnerSettled(isSettled, onSettled, reason, attemptsRemaining - 1);
    }, 50);
  }

  /**
   * 处理离线缓存并创建黑匣子条目
   */
  private async processOfflineCacheAndCreateEntries(): Promise<void> {
    try {
      const results = await this.processOfflineCache();
      if (results.length > 0) {
        this.toast.success('离线录音已处理', `已转写 ${results.length} 条离线录音`);
      }
    } catch (e) {
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
    for (const type of this.config.AUDIO_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    // 默认不指定，让浏览器选择
    return '';
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
      const hasAudioInput = devices.some(device => device.kind === 'audioinput');
      
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
    if (this.isRecording()) {
      return;
    }
    
    // 预检查设备可用性
    const isAvailable = await this.checkMicrophoneAvailability();
    if (!isAvailable) {
      const errorMsg = '未找到麦克风设备或不支持录音功能';
      this.logger.warn('SpeechToText', errorMsg);
      this.toast.warning('录音不可用', errorMsg);
      return; // 优雅返回，不抛出异常
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
      
      // 【修复 P2-03】MediaRecorder 构造失败时关闭 stream，防止麦克风泄漏
      try {
        this.mediaRecorder = new MediaRecorder(stream, {
          mimeType: mimeType || undefined,
          audioBitsPerSecond: this.config.AUDIO_BITS_PER_SECOND
        });
      } catch (recorderErr) {
        stream.getTracks().forEach(track => track.stop());
        throw recorderErr;
      }
      this.audioChunks = [];
      this.recordingStartTime = Date.now();
      this.recordingOwnerUserId = this.auth.currentUserId();

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      // 每秒收集一次数据，避免丢失
      this.mediaRecorder.start(1000);
      isRecording.set(true);
      
      this.logger.debug('SpeechToText', `Recording started with mimeType: ${mimeType}`);
      
      // 个人使用，不设时长限制（MediaRecorder 自身无硬性时长上限）
      // 注意：浏览器在极长录音时可能因内存问题自行中断
      // 每 1000ms ondataavailable 已确保数据分片收集，不会因单次 Blob 过大而丢失
      
    } catch (err) {
      this.logger.error('SpeechToText', 'Failed to start recording', err instanceof Error ? err.message : String(err));
      
      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError') {
          this.toast.error('录音失败', ErrorMessages[ErrorCodes.FOCUS_RECORDING_PERMISSION_DENIED]);
        } else if (err.name === 'NotFoundError') {
          this.toast.error('录音失败', '未找到麦克风设备');
        } else {
          this.toast.error('录音失败', `设备错误: ${err.message}`);
        }
      } else {
        this.toast.error('录音失败', '无法启动录音');
      }
      
      // 不抛出异常，避免中断应用流程
      // throw err;
    }
  }
  
  /**
   * 停止录音（不转写）
   */
  stopRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
      isRecording.set(false);
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
    isTranscribing.set(false);
    this.logger.debug('SpeechToText', 'Recording cancelled, all data discarded');
  }
  
  /**
   * 停止录音并转写
   */
  async stopAndTranscribe(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('未开始录音'));
        return;
      }

      this.mediaRecorder.onstop = async () => {
        isRecording.set(false);
        isTranscribing.set(true);
        const expectedOwnerUserId = this.recordingOwnerUserId;

        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const audioBlob = new Blob(this.audioChunks, { type: mimeType });
        
        // 检查录音是否太短
        if (audioBlob.size < this.config.MIN_FILE_SIZE) {
          isTranscribing.set(false);
          this.toast.warning('录音太短', ErrorMessages[ErrorCodes.FOCUS_RECORDING_TOO_SHORT]);
          resolve('');
          return;
        }
        
        // 检查录音是否太大
        if (audioBlob.size > this.config.MAX_FILE_SIZE) {
          isTranscribing.set(false);
          this.toast.warning('录音太长', ErrorMessages[ErrorCodes.FOCUS_RECORDING_TOO_LONG]);
          resolve('');
          return;
        }

        try {
          // 检查网络状态
          if (!this.network.isOnline()) {
            // 离线：暂存到 IndexedDB，稍后重试
            // 【修复 P2-04】try/catch 包裹离线缓存，确保 promise 不会永远挂起
            try {
              const cacheState = await this.saveToOfflineCache(audioBlob, expectedOwnerUserId);
              if (cacheState === 'quarantined') {
                this.toast.warning('录音已隔离', '当前账号未稳定，这条录音不会自动转写');
              } else {
                this.toast.info('录音已保存', '已保存，联网后自动转写');
              }
            } catch (cacheErr) {
              this.logger.error('SpeechToText', '离线缓存失败', cacheErr instanceof Error ? cacheErr.message : String(cacheErr));
              this.toast.error('保存失败', '无法保存录音，请重试');
            }
            resolve('[离线录音，稍后转写]');
            return;
          }
          
          // 在线：直接转写
          const text = await this.transcribeBlob(audioBlob, expectedOwnerUserId);

          if (!this.isRecordingOwnerActive(expectedOwnerUserId)) {
            throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
          }

          resolve(text);
        } catch (error) {
          this.logger.error('SpeechToText', 'Transcription failed', error instanceof Error ? error.message : String(error));
          
          // 【修复 P5-12】使用 TypeError + 离线状态双重判断，避免依赖浏览器特定 error.message
          if (error instanceof TypeError || this.isRetryableSessionRecoveryError(error) || !this.network.isOnline()) {
            try {
              const cacheState = await this.saveToOfflineCache(audioBlob, expectedOwnerUserId);
              if (cacheState === 'owned') {
                this.scheduleOfflineCacheReplay('retryable-transcribe-error');
                this.toast.warning('转写失败', ErrorMessages[ErrorCodes.FOCUS_NETWORK_ERROR]);
              } else {
                this.toast.warning('录音已隔离', '当前账号未稳定，这条录音不会自动转写');
              }
              resolve('[转写失败，稍后重试]');
            } catch (cacheErr) {
              this.logger.error('SpeechToText', 'Failed to cache audio after retryable transcribe error', cacheErr instanceof Error ? cacheErr.message : String(cacheErr));
              this.toast.error('保存失败', '无法保存录音，请重试');
              reject(cacheErr);
            }
          } else {
            reject(error);
          }
        } finally {
          isTranscribing.set(false);
          this.recordingOwnerUserId = null;
          // 清理流，释放麦克风
          this.mediaRecorder?.stream.getTracks().forEach(track => track.stop());
        }
      };

      this.mediaRecorder.stop();
    });
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
    // 🔐 认证检查：确保用户已登录
    const userId = expectedOwnerUserId;
    if (!userId) {
      this.logger.error('SpeechToText', 'Transcription aborted: user not authenticated');
      this.toast.error('认证失败', '请先登录后再使用语音转写功能');
      throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
    }

    if (!this.isRecordingOwnerActive(userId)) {
      this.logger.warn('SpeechToText', 'Recording owner changed before transcription started', { expectedOwnerUserId: userId });
      throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
    }
    
    // 📊 详细日志：帮助调试生产环境问题
    this.logger.info('SpeechToText', `Starting transcription: size=${audioBlob.size}, type=${audioBlob.type}, userId=[REDACTED]`);

    this.logger.debug('SpeechToText', `Invoking Edge Function: ${this.config.EDGE_FUNCTION_NAME}`);

    const functionUrl = `${environment.supabaseUrl}/functions/v1/${this.config.EDGE_FUNCTION_NAME}`;
    this.logger.debug('SpeechToText', `Calling: ${functionUrl}`);

    let response = await this.invokeTranscribe(functionUrl, audioBlob, await this.resolveAccessToken('SpeechToText.transcribe', userId));
    if (response.status === 401) {
      this.logger.warn('SpeechToText', 'Edge Function rejected JWT, attempting one session refresh before failing');
      const refreshedSession = await this.refreshSessionForTranscribe('SpeechToText.transcribe.retry401');
      response = await this.invokeTranscribe(
        functionUrl,
        audioBlob,
        await this.resolveAccessToken('SpeechToText.transcribe.retry', userId, refreshedSession)
      );
    }
    
    const responseText = await response.text();
    
    if (!response.ok) {
      // 详细记录错误信息
      this.logger.error('SpeechToText', 'Transcription failed', JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        body: responseText
      }));
      
      let errorData: { error?: string; code?: string; message?: string } = {};
      try {
        errorData = JSON.parse(responseText);
      } catch (e) {
        // 降级处理：响应不是 JSON，使用空对象
        this.logger.debug('transcribe', '响应非 JSON 格式', { error: e, responseText });
      }
      
      // 处理特定错误
      if (errorData.code === 'QUOTA_EXCEEDED' || responseText.includes('QUOTA_EXCEEDED')) {
        this.toast.warning('配额已用完', ErrorMessages[ErrorCodes.FOCUS_QUOTA_EXCEEDED]);
        remainingQuota.set(0);
        throw new Error(ErrorCodes.FOCUS_QUOTA_EXCEEDED);
      }
      
      // 处理认证错误
      if (response.status === 401 || errorData.code === 'AUTH_INVALID') {
        this.toast.error('认证失败', '请重新登录后再试');
        throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
      }
      
      // 处理 Groq 超时（Edge Function 主动返回的 504，带 CORS 头）
      if (errorData.code === 'GROQ_TIMEOUT' || errorData.code === 'GROQ_UNREACHABLE') {
        this.toast.error('转写超时', errorData.error || '转写服务响应超时，请缩短录音后重试');
        throw new Error(ErrorCodes.FOCUS_TRANSCRIBE_FAILED);
      }
      
      // 处理服务配置错误
      if (errorData.code === 'SERVICE_NOT_CONFIGURED') {
        this.toast.error('服务未配置', '语音转写服务未正确配置，请联系管理员');
        throw new Error(ErrorCodes.FOCUS_SERVICE_UNAVAILABLE);
      }
      
      throw new Error(errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }
    
    // 【修复 P2-05】安全解析 JSON，防止 Edge Function 返回 HTML 时崩溃
    let data: { text?: string; duration?: number };
    try {
      data = JSON.parse(responseText);
    } catch {
      this.logger.error('SpeechToText', '响应非 JSON 格式', { responseText: responseText.slice(0, 200) });
      throw new Error('服务响应格式错误');
    }
    
    // ✅ 成功日志
    this.logger.info('SpeechToText', `Transcription successful: ${data.text?.length || 0} chars, duration=${data.duration}s`);
    
    return data.text ?? '';
  }

  private scheduleOfflineCacheReplay(reason: string): void {
    if (!this.network.isOnline()) {
      return;
    }

    if (this.recoveryReplayTimeout) {
      return;
    }

    this.logger.info('SpeechToText', 'Scheduling offline audio replay after transient failure', { reason });
    this.recoveryReplayTimeout = setTimeout(() => {
      this.recoveryReplayTimeout = null;
      void this.runOfflineCacheReplay('delayed-retry');
    }, 1500);
  }

  private runOfflineCacheReplay(reason: string): Promise<void> {
    if (this.recoveryReplayTimeout) {
      clearTimeout(this.recoveryReplayTimeout);
      this.recoveryReplayTimeout = null;
    }

    if (this.replayOfflineCachePromise) {
      this.logger.debug('SpeechToText', 'Offline audio replay already in progress, reusing existing run', { reason });
      return this.replayOfflineCachePromise;
    }

    this.replayOfflineCachePromise = this.processOfflineCacheAndCreateEntries()
      .finally(() => {
        this.replayOfflineCachePromise = null;
      });

    return this.replayOfflineCachePromise;
  }

  private async resolveAccessToken(
    context: string,
    expectedOwnerUserId: string,
    prefetchedSession: Session | null = null
  ): Promise<string> {
    await this.auth.ensureRuntimeAuthReady();

    if (!this.isRecordingOwnerActive(expectedOwnerUserId)) {
      this.logger.warn('SpeechToText', 'Recording owner changed before access token resolution completed', {
        context,
        expectedOwnerUserId,
      });
      throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
    }

    let session = prefetchedSession;
    let sessionError: { message?: string } | null = null;

    if (!session) {
      const client = await this.supabaseClient.clientAsync();
      if (!client) {
        this.logger.warn('SpeechToText', 'Supabase client temporarily unavailable while resolving access token', { context });
        throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
      }

      const sessionResult = await client.auth.getSession();
      session = sessionResult.data.session;
      sessionError = sessionResult.error;
    }

    if (session?.user?.id && session.user.id !== expectedOwnerUserId) {
      this.logger.warn('SpeechToText', 'Resolved session belongs to a different owner than the recording', {
        context,
        expectedOwnerUserId,
        sessionUserId: session.user.id,
      });
      throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
    }

    if (sessionError || !session?.access_token || !session.user?.id || this.isAccessTokenExpiringSoon(session.expires_at)) {
      this.logger.warn('SpeechToText', 'Session missing or expiring before transcribe, attempting refresh', {
        context,
        hasSession: !!session,
        hasAccessToken: !!session?.access_token,
        expiresAt: session?.expires_at ?? null,
        sessionError: sessionError?.message,
      });

      session = await this.refreshSessionForTranscribe(`${context}.getSession`);
      sessionError = null;
    }

    if (session?.user?.id && session.user.id !== expectedOwnerUserId) {
      this.logger.warn('SpeechToText', 'Refreshed session no longer matches the recording owner', {
        context,
        expectedOwnerUserId,
        sessionUserId: session.user.id,
      });
      throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
    }

    if (sessionError || !session?.access_token || !session.user?.id) {
      this.logger.error('SpeechToText', 'No access token available after refresh', sessionError?.message);
      this.toast.error('认证失败', '请重新登录后再试');
      throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
    }

    return session.access_token;
  }

  private async refreshSessionForTranscribe(context: string): Promise<Session> {
    const result = await this.sessionManager.tryRefreshSessionWithSession(context);
    if (result.refreshed && result.session?.access_token && result.session.user?.id) {
      return result.session;
    }

    if (result.reason === 'client-unready') {
      this.logger.warn('SpeechToText', 'Session refresh deferred because client is temporarily unavailable', { context });
      throw new Error(this.RETRYABLE_SESSION_RECOVERY_ERROR);
    }

    if (result.refreshed) {
      this.logger.error('SpeechToText', 'Session refresh reported success but returned no usable session', { context });
    }

    this.logger.error('SpeechToText', 'Failed to refresh session before transcribe', { context, reason: result.reason ?? 'unknown' });
    this.toast.error('认证失败', '请重新登录后再试');
    throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
  }

  private isAccessTokenExpiringSoon(expiresAt: number | null | undefined): boolean {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
      return false;
    }

    const expiresAtSec = expiresAt > 1e12 ? Math.floor(expiresAt / 1000) : expiresAt;
    const nowSec = Math.floor(Date.now() / 1000);
    return expiresAtSec <= nowSec + this.ACCESS_TOKEN_EXPIRY_BUFFER_SECONDS;
  }

  private isRetryableSessionRecoveryError(error: unknown): boolean {
    return error instanceof Error && error.message === this.RETRYABLE_SESSION_RECOVERY_ERROR;
  }

  private async invokeTranscribe(functionUrl: string, audioBlob: Blob, accessToken: string): Promise<Response> {
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), FOCUS_CONFIG.BLACK_BOX.TRANSCRIBE_TIMEOUT);

    try {
      return await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': environment.supabaseAnonKey,
        },
        body: this.createAudioFormData(audioBlob),
        signal: abortCtrl.signal
      });
    } catch (fetchErr) {
      if (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') {
        this.logger.error('SpeechToText', `Transcription timed out after ${FOCUS_CONFIG.BLACK_BOX.TRANSCRIBE_TIMEOUT}ms`);
        this.toast.error('转写超时', '服务响应超慢，请缩短录音后重试');
        throw new Error(ErrorCodes.FOCUS_TRANSCRIBE_FAILED);
      }

      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private createAudioFormData(audioBlob: Blob): FormData {
    const formData = new FormData();
    const ext = audioBlob.type.includes('mp4') ? 'mp4' :
      audioBlob.type.includes('ogg') ? 'ogg' :
        audioBlob.type.includes('wav') ? 'wav' : 'webm';
    formData.append('file', audioBlob, `recording.${ext}`);
    return formData;
  }
  
  /**
   * 离线时暂存录音到 IndexedDB
   */
  private async saveToOfflineCache(blob: Blob, ownerUserId = this.auth.currentUserId()): Promise<'owned' | 'quarantined'> {
    if (!this.db) {
      await this.initIndexedDB();
    }
    
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }
      
      const tx = this.db.transaction(this.CACHE_STORE, 'readwrite');
      const store = tx.objectStore(this.CACHE_STORE);
      const normalizedOwnerUserId = ownerUserId ?? this.UNKNOWN_OFFLINE_AUDIO_OWNER;
      const cacheState = normalizedOwnerUserId === this.UNKNOWN_OFFLINE_AUDIO_OWNER ? 'quarantined' : 'owned';
      
      const entry: OfflineAudioCacheEntry = {
        id: crypto.randomUUID(),
        ownerUserId: normalizedOwnerUserId,
        blob: blob,
        createdAt: new Date().toISOString(),
        mimeType: blob.type
      };
      
      const request = store.add(entry);
      
      request.onsuccess = () => {
        void this.updateOfflinePendingCount();
        if (cacheState === 'quarantined') {
          this.logger.warn('SpeechToText', 'Cached offline audio without a confirmed owner; quarantined for manual review');
        }
        this.logger.debug('SpeechToText', 'Audio cached for offline processing');
        resolve(cacheState);
      };
      
      request.onerror = () => {
        this.logger.error('SpeechToText', 'Failed to cache audio offline', request.error?.message || 'Unknown error');
        reject(request.error);
      };
    });
  }
  
  /**
   * 网络恢复后处理离线缓存
   */
  async processOfflineCache(): Promise<{ id: string; text: string }[]> {
    if (!this.network.isOnline()) return [];
    if (!this.db) {
      await this.initIndexedDB();
    }

    const currentUserId = this.auth.currentUserId();
    if (!currentUserId) {
      this.logger.warn('SpeechToText', 'Skipping offline audio replay because no authenticated user is available');
      offlinePendingCount.set(0);
      return [];
    }

    const replayOwnerUserId = currentUserId;
    
    const results: { id: string; text: string }[] = [];
    
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve([]);
        return;
      }
      
      const tx = this.db.transaction(this.CACHE_STORE, 'readonly');
      const store = tx.objectStore(this.CACHE_STORE);
      const request = store.getAll();
      
      request.onsuccess = async () => {
        const items = request.result as OfflineAudioCacheEntry[];
        
        for (const item of items) {
          if (!this.isReplayOwnerActive(replayOwnerUserId)) {
            this.logger.warn('SpeechToText', 'Aborting offline audio replay because session owner changed mid-run', {
              replayOwnerUserId,
            });
            break;
          }

          if (item.ownerUserId === this.UNKNOWN_OFFLINE_AUDIO_OWNER) {
            this.logger.warn('SpeechToText', 'Skipping quarantined legacy offline audio with unknown owner', {
              itemId: item.id,
            });
            continue;
          }

          if (!item.ownerUserId || item.ownerUserId !== currentUserId) {
            this.logger.warn('SpeechToText', 'Skipping offline audio owned by a different session', {
              itemId: item.id,
              hasOwnerUserId: !!item.ownerUserId,
            });
            continue;
          }

          try {
            isTranscribing.set(true);
            const text = await this.transcribeBlob(item.blob);

            if (!this.isReplayOwnerActive(replayOwnerUserId)) {
              this.logger.warn('SpeechToText', 'Discarding transcribed offline audio because session owner changed before persistence', {
                itemId: item.id,
                replayOwnerUserId,
              });
              break;
            }

            if (text.trim()) {
              const created = this.blackBoxService.create({
                content: text,
                userId: replayOwnerUserId,
              });

              if (!created.ok) {
                this.logger.warn('SpeechToText', 'Failed to persist transcribed offline audio, keeping cache entry for retry', {
                  itemId: item.id,
                  error: created.error.message,
                });
                break;
              }

              this.logger.debug('SpeechToText', `Created BlackBox entry from offline audio: "${text.slice(0, 50)}..."`);
            }

            await this.deleteFromCache(item.id);
            results.push({ id: item.id, text });
            this.logger.debug('SpeechToText', `Processed offline audio: ${item.id}`);
          } catch (e) {
            this.logger.error('SpeechToText', 'Failed to process offline item', e instanceof Error ? e.message : String(e));

            if ((e instanceof TypeError || this.isRetryableSessionRecoveryError(e)) && this.network.isOnline()) {
              this.scheduleOfflineCacheReplay('offline-replay-retryable-error');
              break;
            }
          }
        }
        
        isTranscribing.set(false);
        await this.updateOfflinePendingCount();
        resolve(results);
      };
      
      request.onerror = () => {
        this.logger.error('SpeechToText', 'Failed to read offline cache', request.error?.message || 'Unknown error');
        reject(request.error);
      };
    });
  }
  
  /**
   * 从缓存中删除条目
   */
  private async deleteFromCache(id: string): Promise<void> {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.CACHE_STORE, 'readwrite');
      const store = tx.objectStore(this.CACHE_STORE);
      const request = store.delete(id);
      
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private isReplayOwnerActive(ownerUserId: string): boolean {
    return this.auth.currentUserId() === ownerUserId;
  }

  private isRecordingOwnerActive(ownerUserId: string | null): boolean {
    return !!ownerUserId && this.auth.currentUserId() === ownerUserId;
  }
  
  /**
   * 更新离线待处理数量
   */
  private async updateOfflinePendingCount(): Promise<void> {
    if (!this.db) {
      offlinePendingCount.set(0);
      return;
    }

    const currentUserId = this.auth.currentUserId();
    if (!currentUserId) {
      offlinePendingCount.set(0);
      return;
    }
    
    return new Promise((resolve) => {
      const tx = this.db!.transaction(this.CACHE_STORE, 'readonly');
      const store = tx.objectStore(this.CACHE_STORE);
      const request = store.getAll();
      
      request.onsuccess = () => {
        const items = request.result as OfflineAudioCacheEntry[];
        offlinePendingCount.set(items.filter(item => item.ownerUserId === currentUserId).length);
        resolve();
      };
      
      request.onerror = () => {
        resolve();
      };
    });
  }

  private async migrateLegacyOfflineAudioOwners(): Promise<void> {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(this.CACHE_STORE, 'readwrite');
      const store = tx.objectStore(this.CACHE_STORE);
      const request = store.getAll();
      let migratedCount = 0;

      request.onsuccess = () => {
        const items = request.result as OfflineAudioCacheEntry[];
        for (const item of items) {
          if (item.ownerUserId) {
            continue;
          }

          store.put({
            ...item,
            ownerUserId: this.UNKNOWN_OFFLINE_AUDIO_OWNER,
          });
          migratedCount += 1;
        }
      };

      request.onerror = () => {
        reject(request.error);
      };

      tx.oncomplete = () => {
        if (migratedCount > 0) {
          this.logger.warn('SpeechToText', 'Quarantined legacy offline audio without owner metadata', {
            migratedCount,
          });
          this.toast.warning('发现旧版离线录音', '为避免转入错误账号，旧缓存录音已被隔离，不会自动转写');
        }
        resolve();
      };

      tx.onerror = () => {
        reject(tx.error);
      };
    });
  }
  
  /**
   * 获取录音时长（秒）
   */
  getRecordingDuration(): number {
    if (!this.isRecording()) return 0;
    return Math.round((Date.now() - this.recordingStartTime) / 1000);
  }
}

