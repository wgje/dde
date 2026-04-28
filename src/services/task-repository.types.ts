/**
 * 任务仓库类型定义
 * 
 * 数据库行类型和映射辅助类型
 */
import { Attachment } from '../models';

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
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;
  tags: string[];
  attachments: Attachment[];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  parking_meta?: import('../models/parking').TaskParkingMeta | null;
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
