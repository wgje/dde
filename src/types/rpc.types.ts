/**
 * Supabase RPC 函数签名集中定义
 *
 * 所有客户端调用 rpc() 时应通过此类型确保参数与返回值类型安全
 * 【集中定义】维护单一真相源，避免多处 RPC 调用参数类型不一致
 */

import { Task, Connection, Project, BlackBoxEntry, DockSnapshot } from '../models';

/**
 * RPC 函数参数与返回值的完整签名映射
 * 每个函数都包含：
 *   - 入参 (Params 后缀的接口)
 *   - 返回值 (Return 后缀的接口)
 *   - 可能的错误状况说明（注释）
 */

// ============================================================
// Focus / Black Box 相关 RPC
// ============================================================

/**
 * 增加每日例行完成次数
 * Edge Function: functions/focus/ 不存在单独函数，通常由 increment_routine_completion RPC 提供
 *
 * 入参：project_id, routine_date
 * 返回值：updated_count
 * 错误：无效 project_id，权限不足
 */
export interface IncrementRoutineCompletionParams {
  project_id: string;
  routine_date: string; // ISO 日期格式
}

export interface IncrementRoutineCompletionReturn {
  updated_count: number;
}

/**
 * 获取 Black Box 同步水位（最后同步时间戳）
 * 返回该用户的最后同步时间，用于增量同步
 *
 * 入参：无
 * 返回值：watermark 为 ISO 8601 字符串或 null
 * 错误：权限不足（未登录）
 */
export interface GetBlackBoxSyncWatermarkReturn {
  watermark: string | null; // ISO 8601
}

// ============================================================
// Project 相关 RPC
// ============================================================

/**
 * 软删除项目及其所有子任务、连接、附件
 * 标记为 deleted_at，不真正删除
 *
 * 入参：project_id
 * 返回值：deleted_count（包括任务、连接）
 * 错误：项目不存在，权限不足（非所有者）
 */
export interface SoftDeleteProjectParams {
  project_id: string;
}

export interface SoftDeleteProjectReturn {
  deleted_count: number;
}

/**
 * 获取完整项目数据（任务、连接、附件元数据）
 * 用于初次加载或完全刷新
 *
 * 入参：project_id
 * 返回值：tasks[]、connections[]、attachmentMetadata[]
 * 错误：项目不存在，权限不足
 */
export interface GetFullProjectDataParams {
  project_id: string;
}

export interface GetFullProjectDataReturn {
  tasks: Task[];
  connections: Connection[];
  // 附件元数据（不含文件内容）
  attachmentMetadata?: Array<{
    id: string;
    name: string;
    size: number;
    type: string;
    url?: string;
  }>;
}

/**
 * 获取项目同步水位（最后同步时间戳）
 *
 * 入参：project_id
 * 返回值：watermark 为 ISO 8601 字符串或 null
 * 错误：项目不存在，权限不足
 */
export interface GetProjectSyncWatermarkParams {
  project_id: string;
}

export interface GetProjectSyncWatermarkReturn {
  watermark: string | null; // ISO 8601
}

/**
 * 获取用户所有项目的同步水位
 * 用于批量增量拉取前的初始化
 *
 * 入参：无
 * 返回值：Map<project_id, watermark>
 * 错误：权限不足（未登录）
 */
export interface GetUserProjectsWatermarkReturn {
  [projectId: string]: string | null; // ISO 8601
}

/**
 * 获取项目在指定时间之后的头部版本（用于增量同步）
 * 返回 (id, updated_at, content) 的轻量级列表
 *
 * 入参：project_id, since_timestamp
 * 返回值：heads[]（轻量级任务/连接列表）
 * 错误：项目不存在，权限不足，timestamp 无效
 */
export interface ListProjectHeadsSinceParams {
  project_id: string;
  since_timestamp: string; // ISO 8601
}

export interface ListProjectHeadsSinceReturn {
  heads: Array<{
    id: string;
    entityType: 'task' | 'connection';
    updatedAt: string; // ISO 8601
    deletedAt: string | null;
  }>;
}

/**
 * 探测用户是否有权访问指定项目
 * 用于权限校验和快速失败
 *
 * 入参：project_id
 * 返回值：accessible（boolean）
 * 错误：无（always returns {accessible: false} if no permission）
 */
export interface GetAccessibleProjectProbeParams {
  project_id: string;
}

export interface GetAccessibleProjectProbeReturn {
  accessible: boolean;
}

/**
 * 获取专注模式断点恢复探针
 * 返回用户最近一次的专注会话快照和中断位置
 *
 * 入参：project_id（可选）
 * 返回值：snapshot、position、recoveryToken
 * 错误：无有效快照时返回 null
 */
export interface GetResumeRecoveryProbeParams {
  project_id?: string;
}

export interface GetResumeRecoveryProbeReturn {
  snapshot: DockSnapshot | null;
  position?: { sessionId: string; taskId: string } | null;
  recoveryToken?: string | null;
}

// ============================================================
// RPC 调用类型守卫与工厂函数
// ============================================================

/**
 * 类型安全的 RPC 调用工厂
 * 使用示例：
 *   const params: GetFullProjectDataParams = { project_id: 'abc123' };
 *   const result = await rpcCall<GetFullProjectDataReturn>('get_full_project_data', params);
 */
export interface RpcSignature {
  increment_routine_completion: {
    params: IncrementRoutineCompletionParams;
    returns: IncrementRoutineCompletionReturn;
  };
  get_black_box_sync_watermark: {
    params: Record<string, never>; // 无参数
    returns: GetBlackBoxSyncWatermarkReturn;
  };
  soft_delete_project: {
    params: SoftDeleteProjectParams;
    returns: SoftDeleteProjectReturn;
  };
  get_full_project_data: {
    params: GetFullProjectDataParams;
    returns: GetFullProjectDataReturn;
  };
  get_project_sync_watermark: {
    params: GetProjectSyncWatermarkParams;
    returns: GetProjectSyncWatermarkReturn;
  };
  get_user_projects_watermark: {
    params: Record<string, never>;
    returns: GetUserProjectsWatermarkReturn;
  };
  list_project_heads_since: {
    params: ListProjectHeadsSinceParams;
    returns: ListProjectHeadsSinceReturn;
  };
  get_accessible_project_probe: {
    params: GetAccessibleProjectProbeParams;
    returns: GetAccessibleProjectProbeReturn;
  };
  get_resume_recovery_probe: {
    params: GetResumeRecoveryProbeParams;
    returns: GetResumeRecoveryProbeReturn;
  };
}

/**
 * 类型守卫：检查 RPC 函数名是否有效
 */
export function isValidRpcFunction(fnName: unknown): fnName is keyof RpcSignature {
  const validFunctions: (keyof RpcSignature)[] = [
    'increment_routine_completion',
    'get_black_box_sync_watermark',
    'soft_delete_project',
    'get_full_project_data',
    'get_project_sync_watermark',
    'get_user_projects_watermark',
    'list_project_heads_since',
    'get_accessible_project_probe',
    'get_resume_recovery_probe',
  ];
  return typeof fnName === 'string' && validFunctions.includes(fnName as keyof RpcSignature);
}
