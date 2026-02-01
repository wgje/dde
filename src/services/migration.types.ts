/**
 * 迁移服务类型定义
 * 
 * 从 migration.service.ts 提取的类型定义
 */

/**
 * 迁移快照配置
 */
export const MIGRATION_SNAPSHOT_CONFIG = {
  /** sessionStorage 最大大小（字节）- 预留 1MB 给其他用途 */
  MAX_SESSION_STORAGE_SIZE: 4 * 1024 * 1024,
  /** 主 sessionStorage key */
  PRIMARY_KEY: 'nanoflow.migration-snapshot',
  /** 备份 localStorage key */
  FALLBACK_KEY: 'nanoflow.migration-snapshot-fallback',
  /** 迁移状态 key */
  STATUS_KEY: 'nanoflow.migration-status',
} as const;

/**
 * 迁移状态枚举
 * 用于跟踪迁移过程中的各个阶段，确保原子性
 */
export type MigrationStatus = 
  | 'idle'           // 空闲状态
  | 'preparing'      // 准备中（创建快照）
  | 'validating'     // 验证本地数据
  | 'uploading'      // 上传中
  | 'verifying'      // 验证远程数据
  | 'cleaning'       // 清理本地数据
  | 'completed'      // 完成
  | 'failed'         // 失败
  | 'rollback';      // 回滚中

/**
 * 迁移状态记录
 */
export interface MigrationStatusRecord {
  status: MigrationStatus;
  startedAt: string;
  lastUpdatedAt: string;
  phase: number;        // 当前阶段 (1-5)
  totalPhases: number;  // 总阶段数
  projectsTotal: number;
  projectsCompleted: number;
  projectsFailed: string[];
  error?: string;
}

/**
 * 数据完整性检查结果
 */
export interface IntegrityCheckResult {
  valid: boolean;
  issues: IntegrityIssue[];
  projectCount: number;
  taskCount: number;
  connectionCount: number;
}

/**
 * 完整性问题
 */
export interface IntegrityIssue {
  type: 'missing-id' | 'orphan-task' | 'broken-connection' | 'invalid-field' | 'duplicate-id';
  entityType: 'project' | 'task' | 'connection';
  entityId?: string;
  message: string;
  severity: 'warning' | 'error';
}

/**
 * 本地数据迁移策略
 */
export type MigrationStrategy = 'keep-local' | 'keep-remote' | 'merge' | 'discard-local';

/**
 * 迁移结果
 */
export interface MigrationResult {
  success: boolean;
  migratedProjects: number;
  strategy: MigrationStrategy;
  error?: string;
}

/**
 * 迁移进度
 */
export interface MigrationProgress {
  phase: number;
  totalPhases: number;
  message: string;
  projectsCompleted: number;
  projectsTotal: number;
}
