/**
 * SyncPerceptionService - 同步感知服务
 * 
 * 借鉴思源笔记的感知模式设计，实现多设备实时同步通知。
 * 
 * 【核心概念】
 * 当设备A完成同步后，通过 Supabase Realtime Broadcast 通知其他设备，
 * 其他设备收到通知后立即拉取最新数据，而不是等待下一次轮询。
 * 
 * 【工作流程】
 * 1. 设备A完成数据上传 → 发送 "sync_completed" 广播
 * 2. 设备B收到广播 → 立即触发下载同步
 * 3. 所有设备保持数据最新状态
 * 
 * 【优势】
 * - 实时性：比轮询更快的同步响应
 * - 节能：减少无效的轮询请求
 * - 可靠：基于 Supabase Realtime 的稳定连接
 */
import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { Subject } from 'rxjs';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';

/**
 * 同步完成事件
 */
export interface SyncCompletedEvent {
  /** 发起同步的设备ID */
  deviceId: string;
  /** 发起同步的设备名称 */
  deviceName: string;
  /** 同步时间戳 */
  syncedAt: number;
  /** 同步的项目ID列表 */
  projectIds: string[];
  /** 同步类型 */
  syncType: 'upload' | 'download' | 'both';
}

/**
 * 设备心跳事件
 */
export interface DeviceHeartbeatEvent {
  /** 设备ID */
  deviceId: string;
  /** 设备名称 */
  deviceName: string;
  /** 操作系统 */
  os: string;
  /** 应用版本 */
  version: string;
  /** 心跳时间戳 */
  timestamp: number;
}

/**
 * 在线设备信息
 */
export interface OnlineDevice {
  deviceId: string;
  deviceName: string;
  os: string;
  version: string;
  lastSeen: number;
}

/** 生成唯一的设备 ID */
const DEVICE_ID = typeof crypto !== 'undefined' 
  ? crypto.randomUUID()
  : Math.random().toString(36).substring(2) + Date.now().toString(36);

/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL = 30000;

/** 设备离线判定时间（毫秒） - 3分钟无心跳视为离线 */
const DEVICE_OFFLINE_THRESHOLD = 180000;

@Injectable({
  providedIn: 'root'
})
export class SyncPerceptionService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SyncPerception');
  private readonly destroyRef = inject(DestroyRef);
  
  /** 感知频道 */
  private perceptionChannel: RealtimeChannel | null = null;
  
  /** 心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 当前订阅的用户ID */
  private currentUserId: string | null = null;
  
  /** 是否已启用感知 */
  private readonly _enabled = signal(false);
  
  /** 在线设备列表 */
  private readonly _onlineDevices = signal<Map<string, OnlineDevice>>(new Map());
  
  /** 最后同步事件 */
  private readonly _lastSyncEvent = signal<SyncCompletedEvent | null>(null);
  
  /** 同步完成事件流 */
  private readonly syncCompleted$ = new Subject<SyncCompletedEvent>();
  
  // ========== 公开的响应式属性 ==========
  
  /** 是否已启用感知 */
  readonly enabled = this._enabled.asReadonly();
  
  /** 当前设备ID */
  readonly deviceId = DEVICE_ID;
  
  /** 在线设备数量 */
  readonly onlineDeviceCount = computed(() => this._onlineDevices().size);
  
  /** 在线设备列表（排除自己） */
  readonly onlineDevices = computed(() => {
    const devices = Array.from(this._onlineDevices().values());
    return devices.filter(d => d.deviceId !== DEVICE_ID);
  });
  
  /** 是否有其他设备在线 */
  readonly hasOtherDevicesOnline = computed(() => this.onlineDevices().length > 0);
  
  /** 最后同步事件 */
  readonly lastSyncEvent = this._lastSyncEvent.asReadonly();
  
  /** 同步完成事件 Observable（用于外部订阅） */
  readonly onSyncCompleted$ = this.syncCompleted$.asObservable();
  
  constructor() {
    this.destroyRef.onDestroy(() => {
      this.disable();
    });
  }
  
  // ========== 公开方法 ==========
  
  /**
   * 启用同步感知
   * @param userId 用户ID
   */
  async enable(userId: string): Promise<void> {
    if (this._enabled() && this.currentUserId === userId) {
      this.logger.debug('感知已启用，跳过');
      return;
    }
    
    // 如果之前订阅了其他用户，先清理
    if (this.currentUserId && this.currentUserId !== userId) {
      await this.disable();
    }
    
    this.currentUserId = userId;
    
    try {
      await this.setupPerceptionChannel(userId);
      this.startHeartbeat();
      this._enabled.set(true);
      this.logger.info('同步感知已启用', { userId, deviceId: DEVICE_ID });
    } catch (e) {
      this.logger.error('启用同步感知失败', e);
      throw e;
    }
  }
  
  /**
   * 禁用同步感知
   */
  async disable(): Promise<void> {
    this.stopHeartbeat();
    
    if (this.perceptionChannel) {
      await this.supabase.client().removeChannel(this.perceptionChannel);
      this.perceptionChannel = null;
    }
    
    this.currentUserId = null;
    this._enabled.set(false);
    this._onlineDevices.set(new Map());
    
    this.logger.info('同步感知已禁用');
  }
  
  /**
   * 广播同步完成事件
   * 当本设备完成同步后调用，通知其他设备
   */
  async broadcastSyncCompleted(projectIds: string[], syncType: 'upload' | 'download' | 'both' = 'both'): Promise<void> {
    if (!this._enabled() || !this.perceptionChannel) {
      this.logger.debug('感知未启用，跳过广播');
      return;
    }
    
    const event: SyncCompletedEvent = {
      deviceId: DEVICE_ID,
      deviceName: this.getDeviceName(),
      syncedAt: Date.now(),
      projectIds,
      syncType
    };
    
    try {
      await this.perceptionChannel.send({
        type: 'broadcast',
        event: 'sync_completed',
        payload: event
      });
      
      this.logger.debug('同步完成事件已广播', { projectIds, syncType });
    } catch (e) {
      this.logger.error('广播同步完成事件失败', e);
    }
  }
  
  /**
   * 获取当前在线设备列表
   */
  getOnlineDevices(): OnlineDevice[] {
    return this.onlineDevices();
  }
  
  /**
   * 获取设备名称
   */
  getDeviceName(): string {
    // 尝试从 navigator 获取设备信息
    if (typeof navigator !== 'undefined') {
      const platform = navigator.platform || 'Unknown';
      const userAgent = navigator.userAgent || '';
      
      // 简单的设备类型检测
      if (/iPhone|iPad|iPod/.test(userAgent)) {
        return 'iOS Device';
      } else if (/Android/.test(userAgent)) {
        return 'Android Device';
      } else if (/Mac/.test(platform)) {
        return 'Mac';
      } else if (/Win/.test(platform)) {
        return 'Windows PC';
      } else if (/Linux/.test(platform)) {
        return 'Linux PC';
      }
    }
    
    return 'Unknown Device';
  }
  
  /**
   * 获取操作系统信息
   */
  getOS(): string {
    if (typeof navigator !== 'undefined') {
      const userAgent = navigator.userAgent || '';
      
      if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
      if (/Android/.test(userAgent)) return 'Android';
      if (/Mac/.test(userAgent)) return 'macOS';
      if (/Win/.test(userAgent)) return 'Windows';
      if (/Linux/.test(userAgent)) return 'Linux';
    }
    
    return 'Unknown';
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 设置感知频道
   */
  private async setupPerceptionChannel(userId: string): Promise<void> {
    const channelName = `sync-perception:${userId}`;
    
    this.perceptionChannel = this.supabase.client().channel(channelName, {
      config: {
        broadcast: { self: false } // 不接收自己的广播
      }
    });
    
    // 监听同步完成事件
    this.perceptionChannel.on('broadcast', { event: 'sync_completed' }, (payload) => {
      const event = payload.payload as SyncCompletedEvent;
      
      // 忽略自己的事件
      if (event.deviceId === DEVICE_ID) return;
      
      this.logger.info('收到同步完成通知', { from: event.deviceName, projectIds: event.projectIds });
      this._lastSyncEvent.set(event);
      this.syncCompleted$.next(event);
    });
    
    // 监听心跳事件
    this.perceptionChannel.on('broadcast', { event: 'heartbeat' }, (payload) => {
      const event = payload.payload as DeviceHeartbeatEvent;
      this.handleHeartbeat(event);
    });
    
    // 订阅频道
    await new Promise<void>((resolve, reject) => {
      this.perceptionChannel!.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          this.logger.info('感知频道已连接');
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.logger.error('感知频道连接失败', { status, err });
          reject(new Error(`Channel subscription failed: ${status}`));
        }
      });
    });
  }
  
  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    // 立即发送一次心跳
    this.sendHeartbeat();
    
    // 定时发送心跳
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
      this.cleanupOfflineDevices();
    }, HEARTBEAT_INTERVAL);
  }
  
  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  /**
   * 发送心跳
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.perceptionChannel) return;
    
    const event: DeviceHeartbeatEvent = {
      deviceId: DEVICE_ID,
      deviceName: this.getDeviceName(),
      os: this.getOS(),
      version: '1.0.0', // TODO: 从环境变量获取
      timestamp: Date.now()
    };
    
    try {
      await this.perceptionChannel.send({
        type: 'broadcast',
        event: 'heartbeat',
        payload: event
      });
    } catch (e) {
      this.logger.warn('发送心跳失败', e);
    }
  }
  
  /**
   * 处理收到的心跳
   */
  private handleHeartbeat(event: DeviceHeartbeatEvent): void {
    // 忽略自己的心跳
    if (event.deviceId === DEVICE_ID) return;
    
    const devices = new Map(this._onlineDevices());
    devices.set(event.deviceId, {
      deviceId: event.deviceId,
      deviceName: event.deviceName,
      os: event.os,
      version: event.version,
      lastSeen: event.timestamp
    });
    
    this._onlineDevices.set(devices);
  }
  
  /**
   * 清理离线设备
   */
  private cleanupOfflineDevices(): void {
    const now = Date.now();
    const devices = new Map(this._onlineDevices());
    let removed = 0;
    
    for (const [deviceId, device] of devices) {
      if (now - device.lastSeen > DEVICE_OFFLINE_THRESHOLD) {
        devices.delete(deviceId);
        removed++;
      }
    }
    
    if (removed > 0) {
      this._onlineDevices.set(devices);
      this.logger.debug('清理离线设备', { removed });
    }
  }
}
