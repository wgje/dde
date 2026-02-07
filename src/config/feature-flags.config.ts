// ============================================
// 特性开关配置
// 用于功能开关（开/关），与环境配置分离
// 
// 使用方式：
// import { FEATURE_FLAGS } from '@config/feature-flags.config';
// if (FEATURE_FLAGS.CIRCUIT_BREAKER_ENABLED) { ... }
// 
// 当前版本：静态配置，需重新部署
// 未来考虑：可通过 Supabase Edge Config 实现运行时动态开关
// ============================================

/**
 * 特性开关
 * 
 * 职责：控制功能的开/关
 * 与 environment.ts 的区别：
 * - FEATURE_FLAGS 用于功能开关（开/关）
 * - environment.ts 用于环境配置（开发/生产）
 */
export const FEATURE_FLAGS = {
  // ==================== 熔断层 ====================
  /** 是否启用客户端熔断保护 */
  CIRCUIT_BREAKER_ENABLED: true,
  /** 是否启用 L3 硬熔断（可单独关闭硬熔断） */
  CIRCUIT_BREAKER_L3_ENABLED: true,
  
  // ==================== Demo 模式 ====================
  /** 是否启用 Demo 模式（显示 Demo Banner，限制功能） */
  DEMO_MODE_ENABLED: false,
  /** Demo 模式最大项目数限制 */
  DEMO_PROJECT_LIMIT: 3,
  /** Demo 数据保留天数（用于共享实例方案） */
  DEMO_DATA_RETENTION_DAYS: 7,
  
  // ==================== 安全功能 ====================
  /** 是否启用会话过期检查 */
  SESSION_EXPIRED_CHECK_ENABLED: true,
  /** 是否启用登出时数据清理 */
  LOGOUT_CLEANUP_ENABLED: true,
  /** 是否启用 Connection Tombstone 防复活 */
  CONNECTION_TOMBSTONE_ENABLED: true,
  
  // ==================== 备份功能 ====================
  /** 是否启用自动备份 */
  AUTO_BACKUP_ENABLED: false, // 默认关闭，待 P2 实现
  /** 是否启用用户手动导出 */
  MANUAL_EXPORT_ENABLED: false, // 默认关闭，待 P1 实现
  
  // ==================== 同步功能 ====================
  /**
   * 是否启用 Realtime 订阅（替代轮询）
   * 注意：实际运行时开关由 SYNC_CONFIG.REALTIME_ENABLED 控制
   */
  REALTIME_ENABLED: false, // 流量优化，默认使用轮询
  /**
   * 是否启用增量同步优化
   * 注意：实际运行时开关由 SYNC_CONFIG.DELTA_SYNC_ENABLED 控制
   * 此标志用于更高层的功能门控
   */
  INCREMENTAL_SYNC_ENABLED: false, // 与 SYNC_CONFIG.DELTA_SYNC_ENABLED 保持一致
  /** 同步成功语义：仅远端确认成功才视为成功 */
  SYNC_STRICT_SUCCESS_ENABLED: true,
  /** 队列耐久优先：禁用默认淘汰策略 */
  SYNC_DURABILITY_FIRST_ENABLED: true,
  /** Delta 游标使用服务端 max(updated_at) 推进 */
  SYNC_SERVER_CURSOR_ENABLED: true,
  /** Realtime 任务级回调链路 */
  SYNC_TASK_LEVEL_CALLBACK_ENABLED: true,
  /** 单队列语义（灰度开关，先用于状态口径与入口约束） */
  SYNC_UNIFIED_QUEUE_SEMANTICS_ENABLED: true,
  
  // ==================== 迁移功能 ====================
  /** 是否启用迁移快照 */
  MIGRATION_SNAPSHOT_ENABLED: true,
  /** 是否要求迁移二次确认 */
  MIGRATION_CONFIRMATION_REQUIRED: true,
  
  // ==================== 调试功能 ====================
  /** 是否启用详细日志 */
  VERBOSE_LOGGING_ENABLED: false,
  /** 是否启用性能监控 */
  PERFORMANCE_MONITORING_ENABLED: false,
} as const;

/**
 * 特性开关类型（仅布尔类型的开关）
 */
export type FeatureFlag = {
  [K in keyof typeof FEATURE_FLAGS]: typeof FEATURE_FLAGS[K] extends boolean ? K : never
}[keyof typeof FEATURE_FLAGS];

/**
 * 检查特性是否启用
 * @reserved 预留的工具函数，供动态特性开关检查使用
 * 
 * @param flag 特性开关名称（仅布尔类型）
 * @returns 是否启用
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return FEATURE_FLAGS[flag] as boolean;
}
