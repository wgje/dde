/**
 * 语音转文字服务
 * 
 * 使用 Supabase Edge Function 调用 Groq API 进行语音转写
 * 支持离线缓存和自动重试
 */

import { Injectable, inject, signal } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { FOCUS_CONFIG } from '../config/focus.config';
import { ErrorCodes, ErrorMessages } from '../utils/result';
import { 
  isRecording, 
  isTranscribing, 
  offlinePendingCount,
  remainingQuota 
} from '../app/core/state/focus-stores';
import { OfflineAudioCacheEntry } from '../models/focus';

@Injectable({
  providedIn: 'root'
})
export class SpeechToTextService {
  private supabaseClient = inject(SupabaseClientService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private network = inject(NetworkAwarenessService);
  private logger = inject(LoggerService);
  
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private recordingStartTime: number = 0;
  private db: IDBDatabase | null = null;
  
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
    this.initIndexedDB();
    
    // 监听网络恢复
    this.setupNetworkListener();
  }
  
  /**
   * 初始化 IndexedDB
   */
  private async initIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.IDB_NAME, FOCUS_CONFIG.SYNC.IDB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.updateOfflinePendingCount();
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.CACHE_STORE)) {
          db.createObjectStore(this.CACHE_STORE, { keyPath: 'id' });
        }
      };
    });
  }
  
  /**
   * 设置网络恢复监听
   */
  private setupNetworkListener(): void {
    window.addEventListener('online', () => {
      this.logger.info('SpeechToText', 'Network restored, processing offline audio cache');
      this.processOfflineCache();
    });
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
   * 开始录音
   * ⚠️ iOS Safari 兼容性：需要在用户手势内调用
   */
  async startRecording(): Promise<void> {
    if (this.isRecording()) {
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
      
      // 设置最大录音时长限制
      setTimeout(() => {
        if (this.isRecording()) {
          this.logger.warn('SpeechToText', 'Recording reached max duration, stopping');
          this.stopRecording();
        }
      }, FOCUS_CONFIG.BLACK_BOX.MAX_RECORDING_DURATION * 1000);
      
    } catch (err) {
      this.logger.error('SpeechToText', 'Failed to start recording', err instanceof Error ? err.message : String(err));
      
      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError') {
          this.toast.error('录音失败', ErrorMessages[ErrorCodes.FOCUS_RECORDING_PERMISSION_DENIED]);
        } else if (err.name === 'NotFoundError') {
          this.toast.error('录音失败', '未找到麦克风设备');
        }
      }
      throw err;
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

    // 📝 关键：Supabase Functions SDK 需要特殊配置来处理 multipart/form-data
    // 不设置 Content-Type header，让浏览器自动生成（包含正确的 boundary）
    this.logger.debug('SpeechToText', `Invoking Edge Function: ${this.config.EDGE_FUNCTION_NAME}`);
    
    const { data, error } = await this.supabaseClient.client().functions.invoke(
      this.config.EDGE_FUNCTION_NAME, 
      { 
        body: formData,
        // ⚠️ 重要：不要手动设置 headers，否则会破坏 multipart boundary
      }
    );

    if (error) {
      // 详细记录错误信息，便于生产环境调试
      this.logger.error('SpeechToText', 'Transcription failed', JSON.stringify({
        message: error.message,
        context: error.context,
        status: error.status,
        name: error.name
      }));
      
      // 处理特定错误
      if (error.message?.includes('QUOTA_EXCEEDED')) {
        this.toast.warning('配额已用完', ErrorMessages[ErrorCodes.FOCUS_QUOTA_EXCEEDED]);
        remainingQuota.set(0);
        throw new Error(ErrorCodes.FOCUS_QUOTA_EXCEEDED);
      }
      
      // 处理认证错误
      if (error.message?.includes('AUTH_INVALID') || error.message?.includes('Unauthorized')) {
        this.toast.error('认证失败', '请重新登录后再试');
        throw new Error(ErrorCodes.SYNC_AUTH_EXPIRED);
      }
      
      // 处理服务配置错误
      if (error.message?.includes('SERVICE_NOT_CONFIGURED')) {
        this.toast.error('服务未配置', '语音转写服务未正确配置，请联系管理员');
        throw new Error(ErrorCodes.FOCUS_SERVICE_UNAVAILABLE);
      }
      
      throw error;
    }
    
    // ✅ 成功日志
    this.logger.info('SpeechToText', `Transcription successful: ${data.text?.length || 0} chars, duration=${data.duration}s`);
    
    // 更新剩余配额
    remainingQuota.update(q => Math.max(0, q - 1));
    
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
