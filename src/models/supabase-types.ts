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

import type {
  UserPreferencesRow,
  UserPreferencesInsert,
  UserPreferencesUpdate,
  ProjectMemberRow,
  ProjectMemberInsert,
  ProjectMemberUpdate,
  CleanupLogRow,
  CleanupLogInsert,
  TaskTombstoneRow,
  TaskTombstoneInsert,
  ConnectionTombstoneRow,
  ConnectionTombstoneInsert,
  BlackBoxEntryRow,
  BlackBoxEntryInsert,
  BlackBoxEntryUpdate,
  TranscriptionUsageRow,
  TranscriptionUsageInsert,
  TranscriptionUsageUpdate,
  AttachmentScanRow,
  AttachmentScanInsert,
  AttachmentScanUpdate,
  QuarantinedFileRow,
  QuarantinedFileInsert,
  QuarantinedFileUpdate,
  CircuitBreakerLogRow,
  CircuitBreakerLogInsert,
  PurgeRateLimitRow,
  PurgeRateLimitInsert,
  PurgeRateLimitUpdate,
  AppConfigRow,
  AppConfigInsert,
  AppConfigUpdate,
  FocusSessionRow,
  FocusSessionInsert,
  FocusSessionUpdate,
  RoutineTaskRow,
  RoutineTaskInsert,
  RoutineTaskUpdate,
  RoutineCompletionRow,
  RoutineCompletionInsert,
  RoutineCompletionUpdate,
  RoutineCompletionEventRow,
  RoutineCompletionEventInsert,
  RoutineCompletionEventUpdate,
  WidgetDeviceRow,
  WidgetDeviceInsert,
  WidgetDeviceUpdate,
  WidgetInstanceRow,
  WidgetInstanceInsert,
  WidgetInstanceUpdate,
  WidgetRequestRateLimitRow,
  WidgetRequestRateLimitInsert,
  WidgetRequestRateLimitUpdate,
  WidgetNotifyEventRow,
  WidgetNotifyEventInsert,
  WidgetNotifyEventUpdate,
  WidgetNotifyThrottleRow,
  WidgetNotifyThrottleInsert,
  WidgetNotifyThrottleUpdate,
  PurgeResult,
} from './supabase-auxiliary-types';

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
      /** 专注会话快照表 - Focus Console v3 */
      focus_sessions: {
        Row: FocusSessionRow;
        Insert: FocusSessionInsert;
        Update: FocusSessionUpdate;
      };
      /** 日常任务表 - Focus Console v3 */
      routine_tasks: {
        Row: RoutineTaskRow;
        Insert: RoutineTaskInsert;
        Update: RoutineTaskUpdate;
      };
      /** 日常任务完成记录表 - Focus Console v3 */
      routine_completions: {
        Row: RoutineCompletionRow;
        Insert: RoutineCompletionInsert;
        Update: RoutineCompletionUpdate;
      };
      /** 日常任务完成事件表 - Focus Console v3 */
      routine_completion_events: {
        Row: RoutineCompletionEventRow;
        Insert: RoutineCompletionEventInsert;
        Update: RoutineCompletionEventUpdate;
      };
      /** Widget 设备绑定表 */
      widget_devices: {
        Row: WidgetDeviceRow;
        Insert: WidgetDeviceInsert;
        Update: WidgetDeviceUpdate;
      };
      /** Widget 实例元数据表 */
      widget_instances: {
        Row: WidgetInstanceRow;
        Insert: WidgetInstanceInsert;
        Update: WidgetInstanceUpdate;
      };
      /** Widget 请求限流表 */
      widget_request_rate_limits: {
        Row: WidgetRequestRateLimitRow;
        Insert: WidgetRequestRateLimitInsert;
        Update: WidgetRequestRateLimitUpdate;
      };
      /** Widget Webhook 去重事件表 */
      widget_notify_events: {
        Row: WidgetNotifyEventRow;
        Insert: WidgetNotifyEventInsert;
        Update: WidgetNotifyEventUpdate;
      };
      /** Widget 推送节流表 */
      widget_notify_throttle: {
        Row: WidgetNotifyThrottleRow;
        Insert: WidgetNotifyThrottleInsert;
        Update: WidgetNotifyThrottleUpdate;
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
      consume_transcription_quota: {
        Args: {
          p_user_id: string;
          p_usage_date: string;
          p_daily_limit: number;
          p_audio_seconds?: number;
        };
        Returns: Json;
      };
      release_transcription_quota: {
        Args: {
          p_usage_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      /** 原子递增日常任务完成计数 */
      increment_routine_completion: {
        Args: {
          p_completion_id: string;
          p_routine_id: string;
          p_date_key: string;
        };
        Returns: number;
      };
      /** 获取完整项目数据（任务 + 连接） */
      get_full_project_data: {
        Args: { p_project_id: string };
        Returns: Json;
      };
      /** 获取单项目聚合同步水位 */
      get_project_sync_watermark: {
        Args: { p_project_id: string };
        Returns: string | null;
      };
      /** 获取当前项目访问性 + 项目域聚合水位 */
      get_accessible_project_probe: {
        Args: { p_project_id: string };
        Returns: {
          project_id: string;
          accessible: boolean;
          watermark: string | null;
        }[];
      };
      /** 恢复链路聚合探测（activeProject + 项目/黑匣子水位） */
      get_resume_recovery_probe: {
        Args: { p_project_id?: string | null };
        Returns: {
          active_project_id: string | null;
          active_accessible: boolean;
          active_watermark: string | null;
          projects_watermark: string | null;
          blackbox_watermark: string | null;
          server_now: string | null;
        }[];
      };
      /** 获取黑匣子域聚合水位 */
      get_black_box_sync_watermark: {
        Args: Record<string, never>;
        Returns: string | null;
      };
      /** 获取当前用户项目域聚合水位 */
      get_user_projects_watermark: {
        Args: Record<string, never>;
        Returns: string | null;
      };
      /** 获取用户项目元数据（增量同步） */
      get_user_projects_meta: {
        Args: { p_since_timestamp?: string };
        Returns: Json;
      };
      /** 列出指定水位后的项目头变更 */
      list_project_heads_since: {
        Args: { p_since?: string | null };
        Returns: { project_id: string; updated_at: string; version: number }[];
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
      /** 安全软删除项目（owner-only, idempotent） */
      soft_delete_project: {
        Args: { p_project_id: string };
        Returns: boolean;
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
      /** Widget 公网摘要接口三维限流 */
      consume_widget_rate_limit: {
        Args: {
          p_scope_type: string;
          p_scope_key: string;
          p_max_calls: number;
          p_window_seconds?: number;
          p_block_seconds?: number;
        };
        Returns: {
          allowed: boolean;
          retry_after_seconds: number;
          remaining_calls: number;
        }[];
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
// Row / Insert / Update interfaces below use snake_case field names
// intentionally — they mirror the Supabase (PostgreSQL) column names
// so that the types stay 1-to-1 with the database schema.
// ============================================

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
  deleted_at: string | null;
  version: number;
  /** @deprecated v1 格式，新数据使用 tasks/connections 独立表 */
  data: Json | null;
  /** 是否已迁移到 v2 独立表 */
  migrated_to_v2: boolean;
}

/** 项目插入数据 */
export interface ProjectInsert {
  id: string;
  owner_id: string;
  title?: string | null;
  description?: string | null;
  created_date?: string | null;
  deleted_at?: string | null;
  version?: number;
  data?: Json | null;
  migrated_to_v2?: boolean;
}

/** 项目更新数据 */
export interface ProjectUpdate {
  title?: string | null;
  description?: string | null;
  deleted_at?: string | null;
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
  expected_minutes: number | null;
  cognitive_load: 'high' | 'low' | null;
  wait_minutes: number | null;
  tags: Json;
  attachments: Json;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** State Overlap 停泊元数据（JSONB），NULL 表示非停泊任务 */
  parking_meta: import('./parking').TaskParkingMeta | null;
  /** 任务僚机注意事项元数据（JSONB），NULL 表示未设置 */
  attention_meta: import('./core-types').TaskAttentionMeta | null;
}

/** 任务插入数据 */
export interface TaskInsert {
  id: string;
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
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;
  tags?: Json;
  attachments?: Json;
  deleted_at?: string | null;
  completed_at?: string | null;
  /** State Overlap 停泊元数据 */
  parking_meta?: import('./parking').TaskParkingMeta | null;
  /** 任务僚机注意事项元数据 */
  attention_meta?: import('./core-types').TaskAttentionMeta | null;
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
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;
  tags?: Json;
  attachments?: Json;
  deleted_at?: string | null;
  completed_at?: string | null;
  /** State Overlap 停泊元数据 */
  parking_meta?: import('./parking').TaskParkingMeta | null;
  /** 任务僚机注意事项元数据 */
  attention_meta?: import('./core-types').TaskAttentionMeta | null;
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
  id: string;
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


export type {
  ThemeTypeDb,
  LayoutDirectionDb,
  FloatingWindowPrefDb,
  UserPreferencesRow,
  UserPreferencesInsert,
  UserPreferencesUpdate,
  MemberRoleDb,
  ProjectMemberRow,
  ProjectMemberInsert,
  ProjectMemberUpdate,
  CleanupLogRow,
  CleanupLogInsert,
  TaskTombstoneRow,
  TaskTombstoneInsert,
  ConnectionTombstoneRow,
  ConnectionTombstoneInsert,
  BlackBoxEntryRow,
  BlackBoxEntryInsert,
  BlackBoxEntryUpdate,
  TranscriptionUsageRow,
  TranscriptionUsageInsert,
  TranscriptionUsageUpdate,
  AttachmentScanRow,
  AttachmentScanInsert,
  AttachmentScanUpdate,
  QuarantinedFileRow,
  QuarantinedFileInsert,
  QuarantinedFileUpdate,
  CircuitBreakerLogRow,
  CircuitBreakerLogInsert,
  PurgeRateLimitRow,
  PurgeRateLimitInsert,
  PurgeRateLimitUpdate,
  AppConfigRow,
  AppConfigInsert,
  AppConfigUpdate,
  PurgeResult,
  FocusSessionRow,
  FocusSessionInsert,
  FocusSessionUpdate,
  RoutineTaskRow,
  RoutineTaskInsert,
  RoutineTaskUpdate,
  RoutineCompletionRow,
  RoutineCompletionInsert,
  RoutineCompletionUpdate,
  RoutineCompletionEventRow,
  RoutineCompletionEventInsert,
  RoutineCompletionEventUpdate,
  WidgetDeviceRow,
  WidgetDeviceInsert,
  WidgetDeviceUpdate,
  WidgetInstanceRow,
  WidgetInstanceInsert,
  WidgetInstanceUpdate,
  WidgetRequestRateLimitRow,
  WidgetRequestRateLimitInsert,
  WidgetRequestRateLimitUpdate,
  WidgetNotifyEventRow,
  WidgetNotifyEventInsert,
  WidgetNotifyEventUpdate,
  WidgetNotifyThrottleRow,
  WidgetNotifyThrottleInsert,
  WidgetNotifyThrottleUpdate,
} from './supabase-auxiliary-types';
