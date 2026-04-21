/**
 * 变更追踪相关类型定义
 * 从 change-tracker.service.ts 提取
 */

import { Task, Connection } from '../models';

/**
 * 变更类型枚举
 */
export type ChangeType = 'create' | 'update' | 'delete';

/**
 * 实体类型
 */
export type EntityType = 'task' | 'connection';

/**
 * 变更记录
 */
export interface ChangeRecord {
  /** 实体ID */
  entityId: string;
  /** 实体类型 */
  entityType: EntityType;
  /** 变更类型 */
  changeType: ChangeType;
  /** 所属项目ID */
  projectId: string;
  /** 变更时间戳 */
  timestamp: number;
  /** 单调递增修订号，用于区分同一毫秒内的先后编辑 */
  revision?: number;
  /** 变更的字段（仅 update 类型有意义） */
  changedFields?: string[];
  /** 实体数据（用于 create/update） */
  data?: Task | Connection;
}

export interface ConnectionDeleteSummary {
  id: string;
  source: string;
  target: string;
}

/**
 * 项目变更摘要
 */
export interface ProjectChangeSummary {
  projectId: string;
  /** 需要创建的任务 */
  tasksToCreate: Task[];
  /** 需要更新的任务 */
  tasksToUpdate: Task[];
  /** 需要删除的任务ID */
  taskIdsToDelete: string[];
  /** 需要创建的连接 */
  connectionsToCreate: Connection[];
  /** 需要更新的连接 */
  connectionsToUpdate: Connection[];
  /** 需要删除的连接（带显式 id，避免同端点多记录误删） */
  connectionsToDelete: ConnectionDeleteSummary[];
  /** 是否有任何变更 */
  hasChanges: boolean;
  /** 总变更数量 */
  totalChanges: number;
  /** 
   * 【流量优化 2026-01-12】每个任务的变更字段映射
   * 用于增量更新：仅更新变化的字段，而非全量推送
   */
  taskUpdateFieldsById: Record<string, string[] | undefined>;
}

/**
 * 字段锁定数据
 */
export interface FieldLockData {
  timestamp: number;
  duration: number;
}

