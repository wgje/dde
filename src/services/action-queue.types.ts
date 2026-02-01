/**
 * 操作队列类型定义
 * 
 * 从 action-queue.service.ts 提取的类型定义
 */
import { Project, Task, UserPreferences } from '../models';

/**
 * 操作重要性级别
 * Level 1: 日志/埋点类 - 失败后 FIFO 丢弃，无提示
 * Level 2: 重要但可补救的数据 - 失败进入死信队列，有容量和清理策略
 * Level 3: 关键操作 - 失败次数超阈值触发用户提示
 */
export type OperationPriority = 'low' | 'normal' | 'critical';

/**
 * 操作有效载荷类型
 * 根据实体类型和操作类型定义具体的载荷结构
 */
export type ActionPayload = 
  | ProjectPayload
  | ProjectDeletePayload
  | TaskPayload
  | TaskDeletePayload
  | PreferencePayload;

export interface ProjectPayload {
  project: Project;
}

export interface ProjectDeletePayload {
  projectId: string;
  userId: string;
}

export interface TaskPayload {
  task: Task;
  projectId: string;
}

export interface TaskDeletePayload {
  taskId: string;
  projectId: string;
}

export interface PreferencePayload {
  preferences: Partial<UserPreferences>;
  userId: string;
}

/**
 * 操作队列项
 */
export interface QueuedAction<T extends ActionPayload = ActionPayload> {
  id: string;
  type: 'create' | 'update' | 'delete';
  entityType: 'project' | 'task' | 'preference';
  entityId: string;
  payload: T;
  timestamp: number;
  retryCount: number;
  lastError?: string;
  /** 错误类型：network=网络错误可重试，business=业务错误不可重试，timeout=超时，unknown=未知错误 */
  errorType?: 'network' | 'business' | 'timeout' | 'unknown';
  /** 操作优先级：决定失败后的处理策略 */
  priority?: OperationPriority;
}

/**
 * 类型安全的操作入队参数
 */
export type EnqueueParams = 
  | { type: 'create' | 'update'; entityType: 'project'; entityId: string; payload: ProjectPayload; priority?: OperationPriority }
  | { type: 'delete'; entityType: 'project'; entityId: string; payload: ProjectDeletePayload; priority?: OperationPriority }
  | { type: 'create' | 'update'; entityType: 'task'; entityId: string; payload: TaskPayload; priority?: OperationPriority }
  | { type: 'delete'; entityType: 'task'; entityId: string; payload: TaskDeletePayload; priority?: OperationPriority }
  | { type: 'create' | 'update' | 'delete'; entityType: 'preference'; entityId: string; payload: PreferencePayload; priority?: OperationPriority };

/**
 * 死信队列项 - 永久失败的操作
 */
export interface DeadLetterItem {
  action: QueuedAction;
  failedAt: string;
  reason: string;
}

/**
 * 队列状态信息
 */
export interface QueueStatus {
  /** 当前队列长度 */
  queueLength: number;
  /** 死信队列长度 */
  deadLetterLength: number;
  /** 正在处理 */
  isProcessing: boolean;
  /** 暂停状态 */
  isPaused: boolean;
  /** 下次重试时间（如果有） */
  nextRetryTime?: number;
}

/**
 * 操作处理器类型
 */
export type ActionProcessor = (action: QueuedAction) => Promise<boolean>;
