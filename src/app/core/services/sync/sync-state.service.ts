/**
 * SyncStateService - 同步状态管理
 * 
 * 职责：
 * - 维护同步状态 Signal
 * - 提供便捷的 computed 属性
 * - 处理会话过期逻辑
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 3 技术债务修复的一部分
 */

import { Injectable, signal, computed } from '@angular/core';
import { Project } from '../../../../models';

/**
 * 同步状态
 */
export interface SyncState {
  /** 是否正在同步 */
  isSyncing: boolean;
  /** 是否在线 */
  isOnline: boolean;
  /** 是否处于离线模式 */
  offlineMode: boolean;
  /** 会话是否过期 */
  sessionExpired: boolean;
  /** 上次同步时间 */
  lastSyncTime: string | null;
  /** 待处理的同步项数量 */
  pendingCount: number;
  /** 同步错误信息 */
  syncError: string | null;
  /** 是否存在冲突 */
  hasConflict: boolean;
  /** 冲突数据 */
  conflictData: ConflictData | null;
}

/**
 * 冲突数据
 */
export interface ConflictData {
  /** 本地版本 */
  local: Project;
  /** 远程版本 */
  remote: Project;
  /** 远程数据（兼容旧接口别名） */
  remoteData?: Project;
  /** 项目 ID */
  projectId: string;
}

/**
 * 同步状态管理服务
 * 
 * 提供统一的同步状态访问和更新接口
 */
@Injectable({
  providedIn: 'root'
})
export class SyncStateService {
  
  /** 同步状态 Signal */
  readonly syncState = signal<SyncState>({
    isSyncing: false,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    offlineMode: false,
    sessionExpired: false,
    lastSyncTime: null,
    pendingCount: 0,
    syncError: null,
    hasConflict: false,
    conflictData: null
  });
  
  /** 兼容旧接口：state 别名 */
  readonly state = this.syncState;
  
  /** 便捷 computed 属性 */
  readonly isOnline = computed(() => this.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncState().isSyncing);
  readonly hasConflict = computed(() => this.syncState().hasConflict);
  readonly sessionExpired = computed(() => this.syncState().sessionExpired);
  readonly pendingCount = computed(() => this.syncState().pendingCount);
  
  /** 是否正在从远程加载 */
  readonly isLoadingRemote = signal(false);
  
  /**
   * 更新同步状态
   */
  update(partial: Partial<SyncState>): void {
    this.syncState.update(state => ({ ...state, ...partial }));
  }
  
  /**
   * 设置是否正在同步
   */
  setSyncing(isSyncing: boolean): void {
    this.update({ isSyncing });
  }
  
  /**
   * 设置在线状态
   */
  setOnline(isOnline: boolean): void {
    this.update({ isOnline });
  }
  
  /**
   * 设置离线模式
   */
  setOfflineMode(offlineMode: boolean): void {
    this.update({ offlineMode });
  }
  
  /**
   * 设置会话过期
   */
  setSessionExpired(sessionExpired: boolean): void {
    this.update({ sessionExpired });
  }
  
  /**
   * 重置会话过期状态
   */
  resetSessionExpired(): void {
    this.update({ sessionExpired: false });
  }
  
  /**
   * 设置上次同步时间
   */
  setLastSyncTime(lastSyncTime: string | null): void {
    this.update({ lastSyncTime });
  }
  
  /**
   * 设置待处理数量
   */
  setPendingCount(pendingCount: number): void {
    this.update({ pendingCount });
  }
  
  /**
   * 增加待处理数量
   */
  incrementPendingCount(): void {
    this.update({ pendingCount: this.syncState().pendingCount + 1 });
  }
  
  /**
   * 减少待处理数量
   */
  decrementPendingCount(): void {
    const current = this.syncState().pendingCount;
    this.update({ pendingCount: Math.max(0, current - 1) });
  }
  
  /**
   * 设置同步错误
   */
  setSyncError(syncError: string | null): void {
    this.update({ syncError });
  }
  
  /**
   * 设置冲突状态
   */
  setConflict(conflictData: ConflictData): void {
    this.update({
      hasConflict: true,
      conflictData
    });
  }
  
  /**
   * 清除冲突状态
   */
  clearConflict(): void {
    this.update({
      hasConflict: false,
      conflictData: null
    });
  }
  
  /**
   * 设置正在加载远程数据
   */
  setLoadingRemote(loading: boolean): void {
    this.isLoadingRemote.set(loading);
  }
  
  /**
   * 检查会话是否已过期
   * 返回 boolean 而非 Signal，便于在非响应式代码中使用
   */
  isSessionExpired(): boolean {
    return this.syncState().sessionExpired;
  }
}
