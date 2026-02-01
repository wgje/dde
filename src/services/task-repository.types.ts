/**
 * 任务仓库类型定义
 * 
 * 数据库行类型和映射辅助类型
 */
import { Task, Connection, Attachment } from '../models';

/**
 * 数据库任务行类型
 */
export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  content: string;
  stage: number | null;
  order: number;
  rank: number;
  status: 'active' | 'completed' | 'archived';
  x: number;
  y: number;
  short_id: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
  due_date: string | null;
  tags: string[];
  attachments: Attachment[];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 数据库连接行类型
 */
export interface ConnectionRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  /** 联系块标题 */
  title: string | null;
  description: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 数据库项目行类型
 */
export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string | null;
  description: string | null;
  created_date: string | null;
  updated_at: string | null;
  version: number;
  migrated_to_v2: boolean;
}

/**
 * 增量同步统计
 */
export interface IncrementalSyncStats {
  created: number;
  updated: number;
  deleted: number;
}

/**
 * 增量同步结果
 */
export interface IncrementalSyncResult {
  success: boolean;
  error?: string;
  stats?: IncrementalSyncStats;
}

/**
 * 基础操作结果
 */
export interface RepositoryResult {
  success: boolean;
  error?: string;
}

/**
 * 批量操作结果
 */
export interface BatchOperationResult extends RepositoryResult {
  failedCount?: number;
}

/**
 * 完整项目加载结果
 */
export interface FullProjectResult {
  project: ProjectRow;
  tasks: Task[];
  connections: Connection[];
}
