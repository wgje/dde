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
import { FOCUS_CONFIG } from '../config/focus.config';
import { ErrorCodes, ErrorMessages } from '../utils/result';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';
import { environment } from '../environments/environment';
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
  
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private recordingStartTime: number = 0;
  private db: IDBDatabase | null = null;
  private initIndexedDBPromise: Promise<void> | null = null;
  private onlineHandler: (() => void) | null = null;
  private readonly destroyRef = inject(DestroyRef);
  
  // 使用 Signal 管理状态，组件直接读取
  readonly isRecording = isRecording;
  readonly isTranscribing = isTranscribing;
  readonly offlinePendingCount = offlinePendingCount;
  readonly remainingQuota = remainingQuota;
  
  private readonly config = FOCUS_CONFIG.SPEECH_TO_TEXT;
  private readonly IDB_NAME = FOCUS_CONFIG.SYNC.IDB_NAME;
  private readonly CACHE_STORE = FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE;
  
  constructor() {
    // 初始化 IndexedDB
    void this.initIndexedDB().catch(error => {
      this.logger.warn('SpeechToText', 'Initial IndexedDB setup deferred', error instanceof Error ? error.message : String(error));
    });
    
    // 监听网络恢复
    this.setupNetworkListener();
  }
  
  /**
   * 初始化 IndexedDB
   */
  private async initIndexedDB(): Promise<void> {
    if (this.db) return;
    if (this.initIndexedDBPromise) return this.initIndexedDBPromise;

    this.initIndexedDBPromise = (async () => {
      this.db = await this.openFocusModeDB();
      this.updateOfflinePendingCount();
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
    this.onlineHandler = () => {
      this.logger.info('SpeechToText', 'Network restored, processing offline audio cache');
      this.processOfflineCacheAndCreateEntries();
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

  /**
   * 处理离线缓存并创建黑匣子条目
   */
  private async processOfflineCacheAndCreateEntries(): Promise<void> {
    try {
      const results = await this.processOfflineCache();
      for (const { text } of results) {
        if (text.trim()) {
          this.blackBoxService.create({ content: text });
          this.logger.debug('SpeechToText', `Created BlackBox entry from offline audio: "${text.slice(0, 50)}..."`);
        }
      }
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
      
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        audioBitsPerSecond: this.config.AUDIO_BITS_PER_SECOND
      });
      this.audioChunks = [];
      this.recordingStartTime = Date.now();

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
            await this.saveToOfflineCache(audioBlob);
            this.toast.info('录音已保存', '已保存，联网后自动转写');
            resolve('[离线录音，稍后转写]');
            return;
          }
          
          // 在线：直接转写
          const text = await this.transcribeBlob(audioBlob);
          resolve(text);
        } catch (error) {
          this.logger.error('SpeechToText', 'Transcription failed', error instanceof Error ? error.message : String(error));
          
          // 网络错误时也暂存
          if (error instanceof TypeError && error.message.includes('fetch')) {
            await this.saveToOfflineCache(audioBlob);
            this.toast.warning('转写失败', ErrorMessages[ErrorCodes.FOCUS_NETWORK_ERROR]);
            resolve('[转写失败，稍后重试]');
          } else {
            reject(error);
          }
        } finally {
          isTranscribing.set(false);
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
   * 🔧 2026-01-25 修复：直接使用 fetch 调用，绕过 SDK 的 JWT 验证问题
   *    Supabase 使用 ES256 签名的 JWT，但 Edge Functions 网关可能不支持
   */
  private async transcribeBlob(audioBlob: Blob): Promise<string> {
    // 🔐 认证检查：确保用户已登录
    const userId = this.auth.currentUserId();
    if (!userId) {
      this.logger.error('SpeechToText', 'Transcription aborted: user not authenticated');
      this.toast.error('认证失败', '请先登录后再使用语音转写功能');
      throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
    }
    
    // 📊 详细日志：帮助调试生产环境问题
    this.logger.info('SpeechToText', `Starting transcription: size=${audioBlob.size}, type=${audioBlob.type}, userId=${userId.slice(0, 8)}...`);
    
    const formData = new FormData();
    // 根据 mimeType 设置正确的文件扩展名
    const ext = audioBlob.type.includes('mp4') ? 'mp4' : 
                audioBlob.type.includes('ogg') ? 'ogg' : 
                audioBlob.type.includes('wav') ? 'wav' : 'webm';
    formData.append('file', audioBlob, `recording.${ext}`);

    this.logger.debug('SpeechToText', `Invoking Edge Function: ${this.config.EDGE_FUNCTION_NAME}`);
    
    // 🔧 获取当前 session 的 access_token
    const { data: sessionData } = await this.supabaseClient.client().auth.getSession();
    const accessToken = sessionData.session?.access_token;
    
    if (!accessToken) {
      this.logger.error('SpeechToText', 'No access token available');
      this.toast.error('认证失败', '请重新登录后再试');
      throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
    }
    
    // 🔧 直接使用 fetch 调用 Edge Function
    // 同时发送 Authorization header 和 apikey header
    const functionUrl = `${environment.supabaseUrl}/functions/v1/${this.config.EDGE_FUNCTION_NAME}`;
    
    this.logger.debug('SpeechToText', `Calling: ${functionUrl}`);
    
    const response = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'apikey': environment.supabaseAnonKey,
      },
      body: formData
    });
    
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
      
      // 处理服务配置错误
      if (errorData.code === 'SERVICE_NOT_CONFIGURED') {
        this.toast.error('服务未配置', '语音转写服务未正确配置，请联系管理员');
        throw new Error(ErrorCodes.FOCUS_SERVICE_UNAVAILABLE);
      }
      
      throw new Error(errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = JSON.parse(responseText);
    
    // ✅ 成功日志
    this.logger.info('SpeechToText', `Transcription successful: ${data.text?.length || 0} chars, duration=${data.duration}s`);
    
    return data.text;
  }
  
  /**
   * 离线时暂存录音到 IndexedDB
   */
  private async saveToOfflineCache(blob: Blob): Promise<void> {
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
      
      const entry: OfflineAudioCacheEntry = {
        id: crypto.randomUUID(),
        blob: blob,
        createdAt: new Date().toISOString(),
        mimeType: blob.type
      };
      
      const request = store.add(entry);
      
      request.onsuccess = () => {
        offlinePendingCount.update(c => c + 1);
        this.logger.debug('SpeechToText', 'Audio cached for offline processing');
        resolve();
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
          try {
            isTranscribing.set(true);
            const text = await this.transcribeBlob(item.blob);
            results.push({ id: item.id, text });
            
            // 删除已处理的缓存
            await this.deleteFromCache(item.id);
            offlinePendingCount.update(c => Math.max(0, c - 1));
            
            this.logger.debug('SpeechToText', `Processed offline audio: ${item.id}`);
          } catch (e) {
            this.logger.error('SpeechToText', 'Failed to process offline item', e instanceof Error ? e.message : String(e));
          }
        }
        
        isTranscribing.set(false);
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
  
  /**
   * 更新离线待处理数量
   */
  private async updateOfflinePendingCount(): Promise<void> {
    if (!this.db) return;
    
    return new Promise((resolve) => {
      const tx = this.db!.transaction(this.CACHE_STORE, 'readonly');
      const store = tx.objectStore(this.CACHE_STORE);
      const request = store.count();
      
      request.onsuccess = () => {
        offlinePendingCount.set(request.result);
        resolve();
      };
      
      request.onerror = () => {
        resolve();
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

