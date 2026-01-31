/**
 * EventBusService - 事件总线服务
 * 
 * 用于解耦服务之间的循环依赖，特别是：
 * - StoreService ↔ TaskOperationAdapterService 循环
 * - AuthService ↔ SimpleSyncService 循环
 * 
 * 通过发布/订阅模式，上层服务发送事件，下层服务订阅处理
 * 
 * @see docs/tech-debt-remediation-plan.md C-05
 */
import { Injectable, signal } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import type { Project, Task } from '../models';

// ============================================
// 事件类型定义
// ============================================

/** 撤销请求事件 */
export interface UndoRequestEvent {
  readonly type: 'undo-request';
  readonly source: string; // 请求来源服务名
}

/** 重做请求事件 */
export interface RedoRequestEvent {
  readonly type: 'redo-request';
  readonly source: string;
}

/** 项目切换事件 */
export interface ProjectSwitchEvent {
  readonly type: 'project-switch';
  readonly projectId: string | null;
  readonly source: string;
}

/** 同步状态变更事件 */
export interface SyncStatusEvent {
  readonly type: 'sync-status';
  readonly status: 'syncing' | 'synced' | 'error' | 'offline';
  readonly details?: string;
}

/** 强制同步请求事件 */
export interface ForceSyncRequestEvent {
  readonly type: 'force-sync-request';
  readonly source: string;
}

/** 任务更新事件（跨服务通知） */
export interface TaskUpdateEvent {
  readonly type: 'task-update';
  readonly taskId: string;
  readonly updateType: 'content' | 'structure' | 'position' | 'delete';
  readonly source: string;
}

/** 会话恢复事件 */
export interface SessionRestoredEvent {
  readonly type: 'session-restored';
  readonly userId: string;
  readonly source: string;
}

/** 所有事件类型联合 */
export type AppEvent = 
  | UndoRequestEvent 
  | RedoRequestEvent 
  | ProjectSwitchEvent 
  | SyncStatusEvent
  | ForceSyncRequestEvent
  | TaskUpdateEvent
  | SessionRestoredEvent;

// ============================================
// EventBusService
// ============================================

@Injectable({ providedIn: 'root' })
export class EventBusService {
  // 专用事件通道（类型安全）
  private readonly _undoRequest$ = new Subject<UndoRequestEvent>();
  private readonly _redoRequest$ = new Subject<RedoRequestEvent>();
  private readonly _projectSwitch$ = new Subject<ProjectSwitchEvent>();
  private readonly _syncStatus$ = new Subject<SyncStatusEvent>();
  private readonly _forceSyncRequest$ = new Subject<ForceSyncRequestEvent>();
  private readonly _taskUpdate$ = new Subject<TaskUpdateEvent>();
  private readonly _sessionRestored$ = new Subject<SessionRestoredEvent>();
  
  // 通用事件通道（用于扩展）
  private readonly _events$ = new Subject<AppEvent>();
  
  // 最近事件记录（调试用）
  private readonly _lastEvent = signal<AppEvent | null>(null);
  
  // ========== 公开的 Observable ==========
  
  /** 撤销请求事件流 */
  readonly onUndoRequest$: Observable<UndoRequestEvent> = this._undoRequest$.asObservable();
  
  /** 重做请求事件流 */
  readonly onRedoRequest$: Observable<RedoRequestEvent> = this._redoRequest$.asObservable();
  
  /** 项目切换事件流 */
  readonly onProjectSwitch$: Observable<ProjectSwitchEvent> = this._projectSwitch$.asObservable();
  
  /** 同步状态事件流 */
  readonly onSyncStatus$: Observable<SyncStatusEvent> = this._syncStatus$.asObservable();
  
  /** 强制同步请求事件流 */
  readonly onForceSyncRequest$: Observable<ForceSyncRequestEvent> = this._forceSyncRequest$.asObservable();
  
  /** 任务更新事件流 */
  readonly onTaskUpdate$: Observable<TaskUpdateEvent> = this._taskUpdate$.asObservable();
  
  /** 会话恢复事件流 */
  readonly onSessionRestored$: Observable<SessionRestoredEvent> = this._sessionRestored$.asObservable();
  
  /** 所有事件流（调试/日志用） */
  readonly allEvents$: Observable<AppEvent> = this._events$.asObservable();
  
  /** 最近事件（Signal，用于调试面板） */
  readonly lastEvent = this._lastEvent.asReadonly();
  
  // ========== 发布方法 ==========
  
  /**
   * 请求撤销操作
   * @param source 请求来源服务名
   */
  requestUndo(source: string): void {
    const event: UndoRequestEvent = { type: 'undo-request', source };
    this._undoRequest$.next(event);
    this._events$.next(event);
    this._lastEvent.set(event);
  }
  
  /**
   * 请求重做操作
   * @param source 请求来源服务名
   */
  requestRedo(source: string): void {
    const event: RedoRequestEvent = { type: 'redo-request', source };
    this._redoRequest$.next(event);
    this._events$.next(event);
    this._lastEvent.set(event);
  }
  
  /**
   * 发布项目切换事件
   * @param projectId 目标项目 ID
   * @param source 请求来源
   */
  publishProjectSwitch(projectId: string | null, source: string): void {
    const event: ProjectSwitchEvent = { type: 'project-switch', projectId, source };
    this._projectSwitch$.next(event);
    this._events$.next(event);
    this._lastEvent.set(event);
  }
  
  /**
   * 发布同步状态变更
   * @param status 同步状态
   * @param details 详情
   */
  publishSyncStatus(status: SyncStatusEvent['status'], details?: string): void {
    const event: SyncStatusEvent = { type: 'sync-status', status, details };
    this._syncStatus$.next(event);
    this._events$.next(event);
    this._lastEvent.set(event);
  }
  
  /**
   * 请求强制同步
   * @param source 请求来源
   */
  requestForceSync(source: string): void {
    const event: ForceSyncRequestEvent = { type: 'force-sync-request', source };
    this._forceSyncRequest$.next(event);
    this._events$.next(event);
    this._lastEvent.set(event);
  }
  
  /**
   * 发布任务更新事件
   * @param taskId 任务 ID
   * @param updateType 更新类型
   * @param source 来源
   */
  publishTaskUpdate(
    taskId: string, 
    updateType: TaskUpdateEvent['updateType'], 
    source: string
  ): void {
    const event: TaskUpdateEvent = { type: 'task-update', taskId, updateType, source };
    this._taskUpdate$.next(event);
    this._events$.next(event);
    this._lastEvent.set(event);
  }
  
  /**
   * 发布会话恢复事件
   * @param userId 用户 ID
   * @param source 请求来源
   */
  publishSessionRestored(userId: string, source: string): void {
    const event: SessionRestoredEvent = { type: 'session-restored', userId, source };
    this._sessionRestored$.next(event);
    this._events$.next(event);
    this._lastEvent.set(event);
  }
}
