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
 * 单个任务的冲突保留策略
 */
export type TaskResolutionChoice = 'local' | 'remote';

/**
 * 逐任务冲突解决计划
 *
 * 用于把“系统建议 + 用户覆写”转成稳定的任务级决议，
 * 确保最终落盘结果与 UI 展示一致。
 */
export interface ConflictResolutionPlan {
  taskChoices: Record<string, TaskResolutionChoice>;
  appliedBy?: 'system' | 'user' | 'mixed';
}

/**
 * 合并结果
 */
export interface MergeResult {
  project: Project;
  issues: string[];
  conflictCount: number;
}
