/**
 * 黑匣子服务
 * 
 * 负责黑匣子条目的 CRUD 操作
 * 遵循 Offline-first：本地写入 → UI 更新 → 后台推送
 */

import { Injectable, inject } from '@angular/core';
import { BlackBoxEntry } from '../models/focus';
import { Result, success, failure, ErrorCodes } from '../utils/result';
import { 
  blackBoxEntriesMap, 
  blackBoxEntriesGroupedByDate,
  unreadBlackBoxCount,
  updateBlackBoxEntry,
  deleteBlackBoxEntry as _deleteFromStore,
  getTodayDate
} from '../app/core/state/focus-stores';
import { BlackBoxSyncService } from './black-box-sync.service';
import { AuthService } from './auth.service';
import { ProjectStateService } from './project-state.service';

interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

@Injectable({
  providedIn: 'root'
})
export class BlackBoxService {
  private syncService = inject(BlackBoxSyncService);
  private auth = inject(AuthService);
  private projectState = inject(ProjectStateService);
  
  /**
   * 按日期分组的条目（暴露给组件）
   */
  readonly entriesByDate = blackBoxEntriesGroupedByDate;
  
  /**
   * 未读条目数量（暴露给组件）
   */
  readonly pendingCount = unreadBlackBoxCount;
  
  /**
   * 获取所有条目 Map
   */
  readonly entriesMap = blackBoxEntriesMap;
  
  /**
   * 创建黑匣子条目
   * 遵循 Offline-first：本地写入 → UI 更新 → 后台推送
   */
  create(data: Partial<BlackBoxEntry>): Result<BlackBoxEntry, OperationError> {
    const userId = this.auth.currentUserId();
    const projectId = this.projectState.activeProjectId();
    
    if (!userId) {
      return failure(ErrorCodes.PERMISSION_DENIED, '请先登录');
    }
    
    const now = new Date().toISOString();
    const entry: BlackBoxEntry = {
      id: crypto.randomUUID(),  // ⚠️ 客户端生成 UUID
      projectId: projectId ?? '',
      userId,
      content: data.content ?? '',
      date: getTodayDate(),
      createdAt: now,
      updatedAt: now,
      isRead: false,
      isCompleted: false,
      isArchived: false,
      deletedAt: null,
      syncStatus: 'pending',
      localCreatedAt: now,
      snoozeCount: 0,
      ...data
    };
    
    // 1. 更新状态（立即 UI 响应）
    updateBlackBoxEntry(entry);
    
    // 2. 后台同步（防抖 3s）
    this.syncService.scheduleSync(entry);
    
    return success(entry);
  }
  
  /**
   * 更新条目
   */
  update(id: string, updates: Partial<BlackBoxEntry>): Result<BlackBoxEntry, OperationError> {
    const entry = blackBoxEntriesMap().get(id);
    if (!entry) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '条目不存在');
    }
    
    const updated: BlackBoxEntry = {
      ...entry,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    // 本地优先更新
    updateBlackBoxEntry(updated);
    
    // 后台同步
    this.syncService.scheduleSync(updated);
    
    return success(updated);
  }
  
  /**
   * 标记为已读
   */
  markAsRead(id: string): Result<BlackBoxEntry, OperationError> {
    return this.update(id, { isRead: true });
  }
  
  /**
   * 标记为完成
   */
  markAsCompleted(id: string): Result<BlackBoxEntry, OperationError> {
    return this.update(id, { isCompleted: true });
  }
  
  /**
   * 归档条目
   */
  archive(id: string): Result<BlackBoxEntry, OperationError> {
    return this.update(id, { isArchived: true });
  }
  
  /**
   * 取消归档
   */
  unarchive(id: string): Result<BlackBoxEntry, OperationError> {
    return this.update(id, { isArchived: false });
  }
  
  /**
   * 删除条目（软删除）
   */
  delete(id: string): Result<void, OperationError> {
    const entry = blackBoxEntriesMap().get(id);
    if (!entry) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '条目不存在');
    }
    
    const deleted: BlackBoxEntry = {
      ...entry,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // 更新状态
    updateBlackBoxEntry(deleted);
    
    // 同步删除
    this.syncService.scheduleSync(deleted);
    
    return success(undefined);
  }
  
  /**
   * 获取单个条目
   */
  getEntry(id: string): BlackBoxEntry | undefined {
    return blackBoxEntriesMap().get(id);
  }
  
  /**
   * 获取指定日期的条目
   */
  getEntriesByDate(date: string): BlackBoxEntry[] {
    return Array.from(blackBoxEntriesMap().values())
      .filter(e => e.date === date && !e.deletedAt && !e.isArchived)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  
  /**
   * 获取已完成的条目（用于地质层）
   */
  getCompletedEntries(date?: string): BlackBoxEntry[] {
    const entries = Array.from(blackBoxEntriesMap().values())
      .filter(e => e.isCompleted && !e.deletedAt);
    
    if (date) {
      return entries.filter(e => e.date === date);
    }
    
    return entries.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }
  
  /**
   * 获取已归档的条目
   */
  getArchivedEntries(): BlackBoxEntry[] {
    return Array.from(blackBoxEntriesMap().values())
      .filter(e => e.isArchived && !e.deletedAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  
  /**
   * 跳过条目（稍后提醒）
   */
  snooze(id: string, until?: string): Result<BlackBoxEntry, OperationError> {
    const entry = blackBoxEntriesMap().get(id);
    if (!entry) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '条目不存在');
    }
    
    // 默认跳过到明天
    const snoozeUntil = until ?? this.getTomorrowDate();
    
    return this.update(id, { 
      snoozeUntil,
      snoozeCount: (entry.snoozeCount ?? 0) + 1
    });
  }
  
  /**
   * 从服务器加载条目
   */
  async loadFromServer(): Promise<void> {
    await this.syncService.pullChanges();
  }
  
  /**
   * 获取明天日期
   */
  private getTomorrowDate(): string {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }
}
