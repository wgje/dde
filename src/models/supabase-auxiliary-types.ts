import type { Json } from './supabase-types';

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
  theme: ThemeTypeDb | null;
  layout_direction: LayoutDirectionDb | null;
  floating_window_pref: FloatingWindowPrefDb | null;
  /** 颜色模式：light/dark/system */
  color_mode: string | null;
  /** 自动解决冲突开关 */
  auto_resolve_conflicts: boolean | null;
  /** 本地自动备份开关 */
  local_backup_enabled: boolean | null;
  /** 本地自动备份间隔（毫秒） */
  local_backup_interval_ms: number | null;
  /** 专注模式偏好（JSONB） */
  focus_preferences: Json | null;
  /** 停泊坞快照（JSONB） */
  dock_snapshot: Json | null;
  created_at: string;
  updated_at: string;
}

/** 用户偏好设置插入数据 */
export interface UserPreferencesInsert {
  id: string;
  user_id: string;
  theme?: string | null;
  layout_direction?: string | null;
  floating_window_pref?: string | null;
  color_mode?: string | null;
  auto_resolve_conflicts?: boolean | null;
  local_backup_enabled?: boolean | null;
  local_backup_interval_ms?: number | null;
  focus_preferences?: Json | null;
  dock_snapshot?: Json | null;
}

/** 用户偏好设置更新数据 */
export interface UserPreferencesUpdate {
  theme?: string | null;
  layout_direction?: string | null;
  floating_window_pref?: string | null;
  color_mode?: string | null;
  auto_resolve_conflicts?: boolean | null;
  local_backup_enabled?: boolean | null;
  local_backup_interval_ms?: number | null;
  focus_preferences?: Json | null;
  dock_snapshot?: Json | null;
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
  focus_meta: Json | null;
  date: string;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
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
  focus_meta?: Json | null;
  date?: string;
  project_id?: string | null;
  user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
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
  focus_meta?: Json | null;
  date?: string;
  project_id?: string | null;
  is_read?: boolean | null;
  is_completed?: boolean | null;
  is_archived?: boolean | null;
  snooze_until?: string | null;
  snooze_count?: number | null;
  deleted_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
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
  user_id: string | null;
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
  user_id?: string | null;
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
  user_id?: string | null;
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

// ============================================
// 专注会话快照表 (focus_sessions) - Focus Console v3
// ============================================

/** 专注会话行数据 */
export interface FocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  session_state: Json;
  updated_at: string;
}

/** 专注会话插入数据 */
export interface FocusSessionInsert {
  id: string;
  user_id: string;
  started_at: string;
  ended_at?: string | null;
  session_state: Json;
  updated_at?: string;
}

/** 专注会话更新数据 */
export interface FocusSessionUpdate {
  ended_at?: string | null;
  session_state?: Json;
  started_at?: string;
}

// ============================================
// 日常任务表 (routine_tasks) - Focus Console v3
// ============================================

/** 日常任务行数据 */
export interface RoutineTaskRow {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** 日常任务插入数据 */
export interface RoutineTaskInsert {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day?: number;
  is_enabled?: boolean;
}

/** 日常任务更新数据 */
export interface RoutineTaskUpdate {
  title?: string;
  max_times_per_day?: number;
  is_enabled?: boolean;
}

// ============================================
// 日常任务完成记录表 (routine_completions) - Focus Console v3
// ============================================

/** 日常任务完成记录行数据 */
export interface RoutineCompletionRow {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  count: number;
  updated_at: string;
}

/** 日常任务完成记录插入数据 */
export interface RoutineCompletionInsert {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  count?: number;
}

/** 日常任务完成记录更新数据 */
export interface RoutineCompletionUpdate {
  count?: number;
  date_key?: string;
}

/** 日常任务完成事件行数据 */
export interface RoutineCompletionEventRow {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  created_at: string;
}

/** 日常任务完成事件插入数据 */
export interface RoutineCompletionEventInsert {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  created_at?: string;
}

/** 日常任务完成事件更新数据 */
export interface RoutineCompletionEventUpdate {
  date_key?: string;
  created_at?: string;
}

// ============================================
// Widget 设备绑定表 (widget_devices)
// ============================================

export interface WidgetDeviceRow {
  id: string;
  user_id: string;
  platform: string;
  installation_id: string;
  push_token: string | null;
  push_token_updated_at: string | null;
  secret_hash: string;
  token_hash: string | null;
  capabilities: Json;
  binding_generation: number;
  expires_at: string;
  last_seen_at: string;
  last_bound_user_hash: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface WidgetDeviceInsert {
  id: string;
  user_id: string;
  platform: string;
  installation_id: string;
  secret_hash: string;
  token_hash?: string | null;
  expires_at: string;
  last_bound_user_hash: string;
  push_token?: string | null;
  push_token_updated_at?: string | null;
  capabilities?: Json;
  binding_generation?: number;
  last_seen_at?: string;
  revoked_at?: string | null;
  revoke_reason?: string | null;
}

export interface WidgetDeviceUpdate {
  user_id?: string;
  platform?: string;
  installation_id?: string;
  push_token?: string | null;
  push_token_updated_at?: string | null;
  secret_hash?: string;
  token_hash?: string | null;
  capabilities?: Json;
  binding_generation?: number;
  expires_at?: string;
  last_seen_at?: string;
  last_bound_user_hash?: string;
  revoked_at?: string | null;
  revoke_reason?: string | null;
}

// ============================================
// Widget 实例元数据表 (widget_instances)
// ============================================

export interface WidgetInstanceRow {
  id: string;
  device_id: string;
  user_id: string;
  platform: string;
  host_instance_id: string;
  size_bucket: string;
  config_scope: string;
  privacy_mode: string;
  binding_generation: number;
  installed_at: string;
  last_seen_at: string;
  uninstalled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WidgetInstanceInsert {
  id: string;
  device_id: string;
  user_id: string;
  platform: string;
  host_instance_id: string;
  size_bucket: string;
  config_scope?: string;
  privacy_mode?: string;
  binding_generation?: number;
  installed_at?: string;
  last_seen_at?: string;
  uninstalled_at?: string | null;
}

export interface WidgetInstanceUpdate {
  device_id?: string;
  user_id?: string;
  platform?: string;
  host_instance_id?: string;
  size_bucket?: string;
  config_scope?: string;
  privacy_mode?: string;
  binding_generation?: number;
  installed_at?: string;
  last_seen_at?: string;
  uninstalled_at?: string | null;
}

// ============================================
// Widget 请求限流表 (widget_request_rate_limits)
// ============================================

export interface WidgetRequestRateLimitRow {
  scope_type: string;
  scope_key: string;
  call_count: number;
  window_start: string;
  blocked_until: string | null;
  last_decision: string;
  created_at: string;
  updated_at: string;
}

export interface WidgetRequestRateLimitInsert {
  scope_type: string;
  scope_key: string;
  call_count?: number;
  window_start?: string;
  blocked_until?: string | null;
  last_decision?: string;
}

export interface WidgetRequestRateLimitUpdate {
  call_count?: number;
  window_start?: string;
  blocked_until?: string | null;
  last_decision?: string;
}

// ============================================
// Widget Webhook 去重事件表 (widget_notify_events)
// ============================================

export interface WidgetNotifyEventRow {
  webhook_id: string;
  user_id: string | null;
  source_table: string;
  event_type: string;
  summary_cursor: string | null;
  last_status: string;
  processed_at: string;
  created_at: string;
  updated_at: string;
}

export interface WidgetNotifyEventInsert {
  webhook_id: string;
  event_type: string;
  source_table: string;
  user_id?: string | null;
  summary_cursor?: string | null;
  last_status?: string;
  processed_at?: string;
}

export interface WidgetNotifyEventUpdate {
  user_id?: string | null;
  source_table?: string;
  event_type?: string;
  summary_cursor?: string | null;
  last_status?: string;
  processed_at?: string;
}

// ============================================
// Widget 推送节流表 (widget_notify_throttle)
// ============================================

export interface WidgetNotifyThrottleRow {
  user_id: string;
  last_notified_at: string;
  last_summary_version: string | null;
  last_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WidgetNotifyThrottleInsert {
  user_id: string;
  last_notified_at?: string;
  last_summary_version?: string | null;
  last_event_id?: string | null;
}

export interface WidgetNotifyThrottleUpdate {
  last_notified_at?: string;
  last_summary_version?: string | null;
  last_event_id?: string | null;
}
