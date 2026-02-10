/**
 * Supabase 数据库类型定义
 * 
 * 【重要】此文件是"数据库协议层"，直接映射数据库 Schema
 * - 字段命名使用 snake_case（与数据库一致）
 * - 仅 Service 层可以访问这些类型
 * - Component 层应该使用 src/models/index.ts 中的领域模型
 * 
 * 生成方式：基于 scripts/supabase-setup.sql 手动创建
 * 理想情况下应使用 `supabase gen types typescript` 自动生成
 * 
 * @see https://supabase.com/docs/reference/javascript/typescript-support
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/**
 * Supabase 数据库 Schema 定义
 */
export interface Database {
  public: {
    Tables: {
      /** 项目表 */
      projects: {
        Row: ProjectRow;
        Insert: ProjectInsert;
        Update: ProjectUpdate;
      };
      /** 任务表 */
      tasks: {
        Row: TaskRow;
        Insert: TaskInsert;
        Update: TaskUpdate;
      };
      /** 连接表 */
      connections: {
        Row: ConnectionRow;
        Insert: ConnectionInsert;
        Update: ConnectionUpdate;
      };
      /** 用户偏好设置表 */
      user_preferences: {
        Row: UserPreferencesRow;
        Insert: UserPreferencesInsert;
        Update: UserPreferencesUpdate;
      };
      /** 项目成员表 */
      project_members: {
        Row: ProjectMemberRow;
        Insert: ProjectMemberInsert;
        Update: ProjectMemberUpdate;
      };
      /** 清理日志表 */
      cleanup_logs: {
        Row: CleanupLogRow;
        Insert: CleanupLogInsert;
        Update: never; // 日志表不支持更新
      };
      /** 任务墓碑表 - 记录已永久删除的任务 ID，防止已删除任务复活 */
      task_tombstones: {
        Row: TaskTombstoneRow;
        Insert: TaskTombstoneInsert;
        Update: never; // 墓碑记录不支持更新
      };
      /** 连接墓碑表 - 记录已永久删除的连接 ID，防止已删除连接复活 */
      connection_tombstones: {
        Row: ConnectionTombstoneRow;
        Insert: ConnectionTombstoneInsert;
        Update: never;
      };
      /** 黑匣子条目表 - 专注模式语音/文本记录 */
      black_box_entries: {
        Row: BlackBoxEntryRow;
        Insert: BlackBoxEntryInsert;
        Update: BlackBoxEntryUpdate;
      };
      /** 语音转写用量表 - 每用户每日配额追踪 */
      transcription_usage: {
        Row: TranscriptionUsageRow;
        Insert: TranscriptionUsageInsert;
        Update: TranscriptionUsageUpdate;
      };
      /** 附件扫描表 - 病毒扫描结果记录 */
      attachment_scans: {
        Row: AttachmentScanRow;
        Insert: AttachmentScanInsert;
        Update: AttachmentScanUpdate;
      };
      /** 隔离文件表 - 检测到威胁的文件 */
      quarantined_files: {
        Row: QuarantinedFileRow;
        Insert: QuarantinedFileInsert;
        Update: QuarantinedFileUpdate;
      };
      /** 熔断器日志表 */
      circuit_breaker_logs: {
        Row: CircuitBreakerLogRow;
        Insert: CircuitBreakerLogInsert;
        Update: never;
      };
      /** 清除操作限流表 */
      purge_rate_limits: {
        Row: PurgeRateLimitRow;
        Insert: PurgeRateLimitInsert;
        Update: PurgeRateLimitUpdate;
      };
      /** 应用配置表 - 全局键值对 */
      app_config: {
        Row: AppConfigRow;
        Insert: AppConfigInsert;
        Update: AppConfigUpdate;
      };
    };
    Views: {
      /** 活跃任务视图（排除软删除） */
      active_tasks: {
        Row: TaskRow;
      };
      /** 活跃连接视图（排除软删除） */
      active_connections: {
        Row: ConnectionRow;
      };
    };
    Functions: {
      cleanup_old_deleted_tasks: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_old_logs: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_old_deleted_connections: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_expired_scan_records: {
        Args: Record<string, never>;
        Returns: number;
      };
      cleanup_deleted_attachments: {
        Args: { retention_days?: number };
        Returns: { deleted_count: number; storage_paths: string[] }[];
      };
      /** 获取完整项目数据（任务 + 连接） */
      get_full_project_data: {
        Args: { p_project_id: string };
        Returns: Json;
      };
      /** 获取用户项目元数据（增量同步） */
      get_user_projects_meta: {
        Args: { p_since_timestamp?: string };
        Returns: Json;
      };
      /** 获取服务器时间（时钟同步） */
      get_server_time: {
        Args: Record<string, never>;
        Returns: string;
      };
      /** 获取仪表盘统计数据 */
      get_dashboard_stats: {
        Args: Record<string, never>;
        Returns: Json;
      };
      /** 获取当前用户 ID */
      current_user_id: {
        Args: Record<string, never>;
        Returns: string;
      };
      /** 批量更新/插入任务 */
      batch_upsert_tasks: {
        Args: { p_project_id: string; p_tasks: Json[] };
        Returns: number;
      };
      /** 追加任务附件 */
      append_task_attachment: {
        Args: { p_attachment: Json; p_task_id: string };
        Returns: boolean;
      };
      /** 移除任务附件 */
      remove_task_attachment: {
        Args: { p_attachment_id: string; p_task_id: string };
        Returns: boolean;
      };
      /** 安全删除任务（软删除 + tombstone） */
      safe_delete_tasks: {
        Args: { p_project_id: string; p_task_ids: string[] };
        Returns: number;
      };
      /** 永久清除任务 v1 */
      purge_tasks: {
        Args: { p_task_ids: string[] };
        Returns: number;
      };
      /** 永久清除任务 v2（带项目校验） */
      purge_tasks_v2: {
        Args: { p_project_id: string; p_task_ids: string[] };
        Returns: number;
      };
      /** 永久清除任务 v3（返回附件路径） */
      purge_tasks_v3: {
        Args: { p_project_id: string; p_task_ids: string[] };
        Returns: PurgeResult;
      };
      /** 检查任务是否已被墓碑化 */
      is_task_tombstoned: {
        Args: { p_task_id: string };
        Returns: boolean;
      };
      /** 检查连接是否已被墓碑化 */
      is_connection_tombstoned: {
        Args: { p_connection_id: string };
        Returns: boolean;
      };
      /** 检查用户是否为项目所有者 */
      user_is_project_owner: {
        Args: { p_project_id: string };
        Returns: boolean;
      };
      /** 检查用户是否有项目访问权限 */
      user_has_project_access: {
        Args: { p_project_id: string };
        Returns: boolean;
      };
      /** 获取用户可访问的项目 ID 列表 */
      user_accessible_project_ids: {
        Args: Record<string, never>;
        Returns: string[];
      };
      /** 迁移单个项目到 v2 */
      migrate_project_data_to_v2: {
        Args: { p_project_id: string };
        Returns: { tasks_migrated: number; connections_migrated: number; errors: string[] }[];
      };
      /** 迁移所有项目到 v2 */
      migrate_all_projects_to_v2: {
        Args: Record<string, never>;
        Returns: { project_id: string; project_title: string; tasks_migrated: number; connections_migrated: number; errors: string[] }[];
      };
    };
    CompositeTypes: {
      purge_result: PurgeResult;
    };
  };
}

// ============================================
// 项目表 (projects)
// ============================================

/** 项目行数据（SELECT 返回） */
export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string | null;
  description: string | null;
  created_date: string | null;
  updated_at: string | null;
  version: number;
  /** @deprecated v1 格式，新数据使用 tasks/connections 独立表 */
  data: Json | null;
  /** 是否已迁移到 v2 独立表 */
  migrated_to_v2: boolean;
}

/** 项目插入数据 */
export interface ProjectInsert {
  id?: string;
  owner_id: string;
  title?: string | null;
  description?: string | null;
  created_date?: string | null;
  version?: number;
  data?: Json | null;
  migrated_to_v2?: boolean;
}

/** 项目更新数据 */
export interface ProjectUpdate {
  title?: string | null;
  description?: string | null;
  version?: number;
  data?: Json | null;
  migrated_to_v2?: boolean;
}

// ============================================
// 任务表 (tasks)
// ============================================

/** 任务状态枚举 */
export type TaskStatusDb = 'active' | 'completed' | 'archived';

/** 任务优先级枚举 */
export type TaskPriorityDb = 'low' | 'medium' | 'high' | 'urgent' | null;

/** 任务行数据（SELECT 返回） */
export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  content: string | null;
  stage: number | null;
  order: number;
  rank: number;
  status: TaskStatusDb;
  x: number;
  y: number;
  short_id: string | null;
  priority: TaskPriorityDb;
  due_date: string | null;
  tags: Json;
  attachments: Json;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 任务插入数据 */
export interface TaskInsert {
  id?: string;
  project_id: string;
  parent_id?: string | null;
  title: string;
  content?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: TaskStatusDb;
  x?: number;
  y?: number;
  short_id?: string | null;
  priority?: TaskPriorityDb;
  due_date?: string | null;
  tags?: Json;
  attachments?: Json;
  deleted_at?: string | null;
}

/** 任务更新数据 */
export interface TaskUpdate {
  parent_id?: string | null;
  title?: string;
  content?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: TaskStatusDb;
  x?: number;
  y?: number;
  short_id?: string | null;
  priority?: TaskPriorityDb;
  due_date?: string | null;
  tags?: Json;
  attachments?: Json;
  deleted_at?: string | null;
}

// ============================================
// 连接表 (connections)
// ============================================

/** 连接行数据（SELECT 返回） */
export interface ConnectionRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  /** 联系块标题（外显内容） */
  title: string | null;
  /** 联系块详细描述 */
  description: string | null;
  created_at: string;
  updated_at: string;
  /** 软删除时间戳，存在表示已标记删除 */
  deleted_at: string | null;
}

/** 连接插入数据 */
export interface ConnectionInsert {
  id?: string;
  project_id: string;
  source_id: string;
  target_id: string;
  title?: string | null;
  description?: string | null;
  deleted_at?: string | null;
}

/** 连接更新数据 */
export interface ConnectionUpdate {
  title?: string | null;
  description?: string | null;
  deleted_at?: string | null;
}

// ============================================
// 用户偏好设置表 (user_preferences)
// ============================================

/** 主题类型（数据库） */
export type ThemeTypeDb = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/** 布局方向（数据库） */
export type LayoutDirectionDb = 'ltr' | 'rtl';

/** 浮动窗口偏好（数据库） */
export type FloatingWindowPrefDb = 'auto' | 'fixed';

/** 用户偏好设置行数据 */
export interface UserPreferencesRow {
  id: string;
  user_id: string;
  theme: string | null;
  layout_direction: string | null;
  floating_window_pref: string | null;
  created_at: string;
  updated_at: string;
}

/** 用户偏好设置插入数据 */
export interface UserPreferencesInsert {
  id?: string;
  user_id: string;
  theme?: string | null;
  layout_direction?: string | null;
  floating_window_pref?: string | null;
}

/** 用户偏好设置更新数据 */
export interface UserPreferencesUpdate {
  theme?: string | null;
  layout_direction?: string | null;
  floating_window_pref?: string | null;
}

// ============================================
// 项目成员表 (project_members)
// ============================================

/** 成员角色枚举 */
export type MemberRoleDb = 'viewer' | 'editor' | 'admin';

/** 项目成员行数据 */
export interface ProjectMemberRow {
  id: string;
  project_id: string;
  user_id: string;
  role: MemberRoleDb;
  invited_by: string | null;
  invited_at: string | null;
  accepted_at: string | null;
}

/** 项目成员插入数据 */
export interface ProjectMemberInsert {
  id?: string;
  project_id: string;
  user_id: string;
  role?: MemberRoleDb;
  invited_by?: string | null;
}

/** 项目成员更新数据 */
export interface ProjectMemberUpdate {
  role?: MemberRoleDb;
  accepted_at?: string | null;
}

// ============================================
// 清理日志表 (cleanup_logs)
// ============================================

/** 清理日志行数据 */
export interface CleanupLogRow {
  id: string;
  type: string;
  details: Json;
  created_at: string;
}

/** 清理日志插入数据 */
export interface CleanupLogInsert {
  id?: string;
  type: string;
  details?: Json;
}

// ============================================
// 任务墓碑表 (task_tombstones)
// ============================================

/**
 * 任务墓碑行数据
 * 记录已被永久删除的任务 ID，防止已删除任务在同步时复活
 */
export interface TaskTombstoneRow {
  task_id: string;
  project_id: string;
  deleted_at: string;
  deleted_by: string | null;
}

/** 任务墓碑插入数据 */
export interface TaskTombstoneInsert {
  task_id: string;
  project_id: string;
  deleted_at?: string;
  deleted_by?: string | null;
}

// ============================================
// 连接墓碑表 (connection_tombstones)
// ============================================

/** 连接墓碑行数据 */
export interface ConnectionTombstoneRow {
  connection_id: string;
  project_id: string;
  deleted_at: string;
  deleted_by: string | null;
}

/** 连接墓碑插入数据 */
export interface ConnectionTombstoneInsert {
  connection_id: string;
  project_id: string;
  deleted_at?: string;
  deleted_by?: string | null;
}

// ============================================
// 黑匣子条目表 (black_box_entries)
// ============================================

/** 黑匣子条目行数据 */
export interface BlackBoxEntryRow {
  id: string;
  project_id: string | null;
  user_id: string | null;
  content: string;
  date: string;
  created_at: string | null;
  updated_at: string | null;
  is_read: boolean | null;
  is_completed: boolean | null;
  is_archived: boolean | null;
  snooze_until: string | null;
  snooze_count: number | null;
  deleted_at: string | null;
}

/** 黑匣子条目插入数据 */
export interface BlackBoxEntryInsert {
  id: string;
  content: string;
  date?: string;
  project_id?: string | null;
  user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  is_read?: boolean | null;
  is_completed?: boolean | null;
  is_archived?: boolean | null;
  snooze_until?: string | null;
  snooze_count?: number | null;
  deleted_at?: string | null;
}

/** 黑匣子条目更新数据 */
export interface BlackBoxEntryUpdate {
  content?: string;
  date?: string;
  project_id?: string | null;
  is_read?: boolean | null;
  is_completed?: boolean | null;
  is_archived?: boolean | null;
  snooze_until?: string | null;
  snooze_count?: number | null;
  deleted_at?: string | null;
  updated_at?: string | null;
}

// ============================================
// 语音转写用量表 (transcription_usage)
// ============================================

/** 语音转写用量行数据 */
export interface TranscriptionUsageRow {
  id: string;
  user_id: string | null;
  date: string;
  audio_seconds: number | null;
  created_at: string | null;
}

/** 语音转写用量插入数据 */
export interface TranscriptionUsageInsert {
  id: string;
  user_id?: string | null;
  date?: string;
  audio_seconds?: number | null;
  created_at?: string | null;
}

/** 语音转写用量更新数据 */
export interface TranscriptionUsageUpdate {
  audio_seconds?: number | null;
  date?: string;
  user_id?: string | null;
}

// ============================================
// 附件扫描表 (attachment_scans)
// ============================================

/** 附件扫描行数据 */
export interface AttachmentScanRow {
  id: string;
  file_id: string;
  scanner: string;
  status: string;
  threat_name: string | null;
  threat_description: string | null;
  error_message: string | null;
  file_hash: string | null;
  engine_version: string | null;
  signature_version: string | null;
  scanned_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 附件扫描插入数据 */
export interface AttachmentScanInsert {
  file_id: string;
  id?: string;
  scanner?: string;
  status?: string;
  threat_name?: string | null;
  threat_description?: string | null;
  error_message?: string | null;
  file_hash?: string | null;
  engine_version?: string | null;
  signature_version?: string | null;
  scanned_at?: string | null;
}

/** 附件扫描更新数据 */
export interface AttachmentScanUpdate {
  scanner?: string;
  status?: string;
  threat_name?: string | null;
  threat_description?: string | null;
  error_message?: string | null;
  file_hash?: string | null;
  engine_version?: string | null;
  signature_version?: string | null;
  scanned_at?: string | null;
}

// ============================================
// 隔离文件表 (quarantined_files)
// ============================================

/** 隔离文件行数据 */
export interface QuarantinedFileRow {
  id: string;
  original_file_id: string;
  storage_path: string;
  threat_name: string;
  threat_description: string | null;
  quarantined_by: string | null;
  quarantined_at: string | null;
  expires_at: string | null;
  restored: boolean | null;
  restored_at: string | null;
  notes: string | null;
}

/** 隔离文件插入数据 */
export interface QuarantinedFileInsert {
  original_file_id: string;
  storage_path: string;
  threat_name: string;
  id?: string;
  threat_description?: string | null;
  quarantined_by?: string | null;
  quarantined_at?: string | null;
  expires_at?: string | null;
  restored?: boolean | null;
  notes?: string | null;
}

/** 隔离文件更新数据 */
export interface QuarantinedFileUpdate {
  restored?: boolean | null;
  restored_at?: string | null;
  notes?: string | null;
  expires_at?: string | null;
}

// ============================================
// 熔断器日志表 (circuit_breaker_logs)
// ============================================

/** 熔断器日志行数据 */
export interface CircuitBreakerLogRow {
  id: string;
  user_id: string;
  operation: string;
  blocked: boolean;
  reason: string | null;
  details: Json | null;
  created_at: string;
}

/** 熔断器日志插入数据 */
export interface CircuitBreakerLogInsert {
  user_id: string;
  operation: string;
  id?: string;
  blocked?: boolean;
  reason?: string | null;
  details?: Json | null;
}

// ============================================
// 清除操作限流表 (purge_rate_limits)
// ============================================

/** 清除限流行数据 */
export interface PurgeRateLimitRow {
  user_id: string;
  call_count: number | null;
  window_start: string | null;
}

/** 清除限流插入数据 */
export interface PurgeRateLimitInsert {
  user_id: string;
  call_count?: number | null;
  window_start?: string | null;
}

/** 清除限流更新数据 */
export interface PurgeRateLimitUpdate {
  call_count?: number | null;
  window_start?: string | null;
}

// ============================================
// 应用配置表 (app_config)
// ============================================

/** 应用配置行数据 */
export interface AppConfigRow {
  key: string;
  value: Json;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 应用配置插入数据 */
export interface AppConfigInsert {
  key: string;
  value: Json;
  description?: string | null;
}

/** 应用配置更新数据 */
export interface AppConfigUpdate {
  value?: Json;
  description?: string | null;
}

// ============================================
// 复合类型 (Composite Types)
// ============================================

/** 清除操作结果 */
export interface PurgeResult {
  purged_count: number | null;
  attachment_paths: string[] | null;
}
