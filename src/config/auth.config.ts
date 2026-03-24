// ============================================
// 认证配置
// 包含用户认证、会话管理、路由守卫相关常量
// ============================================

/**
 * 认证配置
 */
export const AUTH_CONFIG = {
  /**
   * 启动阶段数据加载最大等待时间（毫秒）
   * 超时后转后台继续加载，避免阻塞 UI 渲染
   *
   * 【优化 2026-03-24】从 3s 减少到 2s
   * 背景：本地会话快速路径（tryLocalSessionFastPath）命中时跳过网络调用，
   * loadProjects() 采用离线优先策略，本地缓存/种子数据加载通常 <100ms。
   * 此超时仅用于网络回退场景，2s 足够覆盖。
   */
  SESSION_CHECK_TIMEOUT: 2000,
  /** 【P2-13 修复】记住登录状态过期时间（毫秒）- 从 7天 缩短为 24小时 */
  REMEMBER_ME_EXPIRY: 24 * 60 * 60 * 1000,
  /** 密码最小长度（与后端保持一致） */
  MIN_PASSWORD_LENGTH: 8,
  /** 本地模式用户 ID（用于离线/本地编辑时的数据隔离） */
  LOCAL_MODE_USER_ID: 'local-user',
  /** 本地模式缓存 key */
  LOCAL_MODE_CACHE_KEY: 'nanoflow.local-mode',
} as const;

/**
 * Guard 配置
 * 路由守卫的超时和重试配置
 * 
 * 【性能优化 2026-01-20】
 * 会话检查超时从 10s 减少到 2s，优先渲染 UI
 * 策略：先放行路由让 UI 渲染，会话检查异步进行
 */
export const GUARD_CONFIG = {
  /** 数据初始化最大等待时间（毫秒）- 弱网环境建议增加 */
  DATA_INIT_TIMEOUT: 8000,
  /** 检查间隔（毫秒） */
  CHECK_INTERVAL: 100,
  /** 慢网络警告阈值（毫秒）- 超过此时间显示网络警告 */
  SLOW_NETWORK_THRESHOLD: 3000,
  /** 
   * 会话检查最大等待时间（毫秒）
   * 【优化】从 10s 减少到 2s，超时后立即放行让 UI 渲染
   */
  SESSION_CHECK_TIMEOUT: 2000,
  /** 会话检查轮询初始间隔（毫秒） */
  SESSION_CHECK_POLL_INTERVAL: 50,
  /** 会话检查轮询最大间隔（毫秒） */
  SESSION_CHECK_POLL_MAX_INTERVAL: 200,
} as const;
