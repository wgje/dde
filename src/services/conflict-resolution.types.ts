/**
 * 冲突解决相关类型定义
 * 从 conflict-resolution.service.ts 提取
 */

import { Project } from '../models';

/**
 * 冲突解决策略（LWW 简化版）
 * - local: 使用本地版本（用户刚编辑的内容）
 * - remote: 使用远程版本（其他设备的内容）
 * - merge: 智能合并（保留双方新增的任务，冲突时本地优先）
 */
export type ConflictResolutionStrategy = 'local' | 'remote' | 'merge';

/**
 * 冲突数据
 */
export interface ConflictData {
  localProject: Project;
  remoteProject: Project;
  projectId: string;
}

/**
 * 合并结果
 */
export interface MergeResult {
  project: Project;
  issues: string[];
  conflictCount: number;
}

/**
 * 【v5.9】Tombstone 查询结果
 * 用于追踪 tombstone 查询是否成功，以便保守处理
 */
export interface TombstoneQueryResult {
  /** 已删除的任务 ID 集合 */
  ids: Set<string>;
  /** 是否成功从远程查询到 tombstones */
  fromRemote: boolean;
  /** 是否仅使用本地缓存（远程查询失败时） */
  localCacheOnly: boolean;
  /** 查询时间戳 */
  timestamp: number;
}

/**
 * 恢复的任务信息
 */
export interface RecoveredTaskInfo {
  taskId: string;
  title: string;
  reason: 'tombstone' | 'missing-local';
}

/**
 * 同步合并统计信息
 */
export interface MergeStats {
  added: number;
  updated: number;
  recovered: number;
  total: number;
}
