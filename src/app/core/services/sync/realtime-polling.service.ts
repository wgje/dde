/**
 * RealtimePollingService - 实时订阅与轮询管理
 * 
 * 职责：
 * - Realtime 订阅项目变更
 * - 轮询同步（流量优化模式）
 * - 订阅状态管理
 * - 降级机制（Realtime → 轮询）
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 9 技术债务修复的一部分
 */

import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { SyncStateService } from './sync-state.service';
import { SYNC_CONFIG } from '../../../../config';
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
/**
 * 远程变更回调
 */
export type RemoteChangeCallback = (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;

/**
 * 用户偏好变更回调
 */
export type UserPreferencesChangeCallback = (payload: { eventType: string; userId: string }) => void;

@Injectable({
  providedIn: 'root'
})
export class RealtimePollingService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RealtimePolling');
  private readonly toast = inject(ToastService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);

  /** Realtime 订阅通道 */
  private realtimeChannel: RealtimeChannel | null = null;
  
  /** 轮询定时器 */
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 当前订阅的项目 ID */
  private currentProjectId: string | null = null;
  
  /** Realtime 更新是否暂停 */
  private realtimePaused = false;
  
  /** 用户活跃状态 */
  private isUserActive = true;
  
  /** 用户活跃超时定时器 */
  private userActiveTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** Realtime 是否启用（运行时可切换） */
  readonly isRealtimeEnabled = signal<boolean>(SYNC_CONFIG.REALTIME_ENABLED);
  
  /** 远程变更回调 */
  private onRemoteChangeCallback: RemoteChangeCallback | null = null;
  
  /** 用户偏好变更回调 */
  private onUserPreferencesChangeCallback: UserPreferencesChangeCallback | null = null;

  constructor() {
    this.setupUserActivityTracking();
    
    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });
  }

  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      return null;
    }
    try {
      return this.supabase.client();
    } catch {
      return null;
    }
  }

  /**
   * 设置用户活跃状态追踪
   */
  private setupUserActivityTracking(): void {
    if (typeof window === 'undefined') return;
    
    const resetActiveTimer = () => {
      this.isUserActive = true;
      if (this.userActiveTimer) {
        clearTimeout(this.userActiveTimer);
      }
      this.userActiveTimer = setTimeout(() => {
        this.isUserActive = false;
      }, SYNC_CONFIG.USER_ACTIVE_TIMEOUT);
    };
    
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(event => {
      window.addEventListener(event, resetActiveTimer, { passive: true });
    });
    
    resetActiveTimer();
  }

  /**
   * 设置远程变更回调
   */
  setOnRemoteChange(callback: RemoteChangeCallback): void {
    this.onRemoteChangeCallback = callback;
  }

  /**
   * 设置用户偏好变更回调
   */
  setUserPreferencesChangeCallback(callback: UserPreferencesChangeCallback | null): void {
    this.onUserPreferencesChangeCallback = callback;
  }

  /**
   * 启用/禁用 Realtime（运行时切换）
   */
  setRealtimeEnabled(enabled: boolean): void {
    this.isRealtimeEnabled.set(enabled);
    
    if (this.currentProjectId) {
      const projectId = this.currentProjectId;
      this.unsubscribeFromProject().then(() => {
        this.subscribeToProject(projectId, '');
      });
    }
    
    this.logger.info(`Realtime ${enabled ? '已启用' : '已禁用，使用轮询'}`);
  }

  /**
   * 订阅项目变更（自动选择 Realtime 或轮询）
   */
  async subscribeToProject(projectId: string, userId: string): Promise<void> {
    await this.unsubscribeFromProject();
    
    this.currentProjectId = projectId;
    
    if (this.isRealtimeEnabled()) {
      await this.subscribeToProjectRealtime(projectId, userId);
    } else {
      this.startPolling(projectId);
    }
  }

  /**
   * 启动轮询
   */
  private startPolling(projectId: string): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
    }
    
    this.logger.info('启动轮询同步', { projectId, interval: SYNC_CONFIG.POLLING_INTERVAL });
    
    const poll = async () => {
      if (!this.syncState.syncState().isOnline || this.realtimePaused) return;
      
      try {
        if (this.onRemoteChangeCallback) {
          await this.onRemoteChangeCallback({ 
            eventType: 'polling', 
            projectId 
          });
        }
      } catch (e) {
        this.logger.debug('轮询检查失败', e);
      }
    };
    
    const getPollingInterval = () => 
      this.isUserActive ? SYNC_CONFIG.POLLING_ACTIVE_INTERVAL : SYNC_CONFIG.POLLING_INTERVAL;
    
    const scheduleNextPoll = () => {
      this.pollingTimer = setTimeout(async () => {
        await poll();
        scheduleNextPoll();
      }, getPollingInterval());
    };
    
    poll().then(() => scheduleNextPoll());
  }

  /**
   * 停止轮询
   */
  private stopPolling(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * 订阅项目实时变更（Realtime 模式）
   */
  private async subscribeToProjectRealtime(projectId: string, userId: string): Promise<void> {
    const client = this.getSupabaseClient();
    if (!client) return;
    
    const channelName = `project:${projectId}:${userId.substring(0, 8)}`;
    
    this.logger.info('启用 Realtime 订阅', { projectId, channel: channelName });
    
    let previousStatus: string | null = null;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    
    this.realtimeChannel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
          filter: `project_id=eq.${projectId}`
        },
        (payload) => {
          const taskData = payload.new as { project_id?: string } | undefined;
          if (taskData && taskData.project_id !== projectId) {
            return;
          }
          
          this.logger.debug('收到任务变更', { event: payload.eventType });
          if (this.onRemoteChangeCallback && !this.realtimePaused) {
            this.onRemoteChangeCallback({ 
              eventType: payload.eventType, 
              projectId 
            });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'connections',
          filter: `project_id=eq.${projectId}`
        },
        (payload) => {
          const connData = payload.new as { project_id?: string } | undefined;
          if (connData && connData.project_id !== projectId) {
            return;
          }
          
          this.logger.debug('收到连接变更', { event: payload.eventType });
          if (this.onRemoteChangeCallback && !this.realtimePaused) {
            this.onRemoteChangeCallback({ 
              eventType: payload.eventType, 
              projectId 
            });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_preferences',
          filter: userId ? `user_id=eq.${userId}` : undefined
        },
        (payload) => {
          this.logger.debug('收到用户偏好变更', { event: payload.eventType });
          if (this.onUserPreferencesChangeCallback && !this.realtimePaused && userId) {
            this.onUserPreferencesChangeCallback({
              eventType: payload.eventType,
              userId
            });
          }
        }
      )
      .subscribe((status, err) => {
        this.logger.info('Realtime 订阅状态', { status, channel: channelName, previousStatus });
        
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          consecutiveErrors++;
          this.sentryLazyLoader.captureMessage('Realtime 订阅错误', { 
            level: 'warning',
            extra: { status, error: err?.message, consecutiveErrors }
          });
          
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.logger.warn('Realtime 连续失败，降级到轮询', { consecutiveErrors });
            this.fallbackToPolling(projectId);
            return;
          }
        } else if (status === 'SUBSCRIBED') {
          consecutiveErrors = 0;
        }
        
        if (status === 'SUBSCRIBED' && previousStatus && previousStatus !== 'SUBSCRIBED') {
          this.logger.info('Realtime 重连成功，触发增量同步', { previousStatus });
          
          if (this.onRemoteChangeCallback && !this.realtimePaused) {
            this.onRemoteChangeCallback({ 
              eventType: 'reconnect', 
              projectId 
            }).catch(e => {
              this.logger.warn('重连后增量同步失败', e);
            });
          }
        }
        
        previousStatus = status;
      });
  }

  /**
   * Realtime 降级到轮询
   */
  private fallbackToPolling(projectId: string): void {
    this.logger.info('Realtime 降级到轮询模式', { projectId });
    
    if (this.realtimeChannel) {
      const client = this.getSupabaseClient();
      if (client) {
        client.removeChannel(this.realtimeChannel).catch((e: unknown) => {
          this.logger.debug('移除 Realtime 通道失败（可能已断开）', { error: e });
        });
      }
      this.realtimeChannel = null;
    }
    
    this.startPolling(projectId);
    this.toast.info('实时同步暂不可用', '已切换到定时同步模式');
  }

  /**
   * 取消订阅
   */
  async unsubscribeFromProject(): Promise<void> {
    this.currentProjectId = null;
    
    this.stopPolling();
    
    if (this.realtimeChannel) {
      const client = this.getSupabaseClient();
      if (client) {
        await client.removeChannel(this.realtimeChannel);
      }
      this.realtimeChannel = null;
    }
  }

  /**
   * 暂停 Realtime 更新
   */
  pauseRealtimeUpdates(): void {
    this.realtimePaused = true;
  }

  /**
   * 恢复 Realtime 更新
   */
  resumeRealtimeUpdates(): void {
    this.realtimePaused = false;
  }

  /**
   * 获取当前项目 ID
   */
  getCurrentProjectId(): string | null {
    return this.currentProjectId;
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.stopPolling();
    if (this.userActiveTimer) {
      clearTimeout(this.userActiveTimer);
    }
  }
}
