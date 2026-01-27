// ============================================
// 性能优化配置
// 包含性能相关的功能开关和配置常量
// 创建日期：2026-01-26
// ============================================

/**
 * 性能优化功能开关
 * 
 * 用于快速启用/禁用性能优化功能
 * 便于 A/B 测试和问题回滚
 */
export const PERFORMANCE_FLAGS = {
  /**
   * 【P0】使用批量 RPC 加载项目
   * 
   * 开启：使用 get_full_project_data RPC 函数（1 个请求）
   * 关闭：使用传统顺序查询（4+ 个请求）
   * 
   * 预期收益：减少 70% API 请求，首屏时间 -3s
   */
  USE_BATCH_RPC: true,

  /**
   * 【P0】首屏优先加载策略
   * 
   * 开启：先加载当前项目，后台加载其他项目
   * 关闭：同时加载所有项目
   * 
   * 预期收益：首屏可交互时间 -67%
   */
  FIRST_SCREEN_PRIORITY: true,

  /**
   * 【P1】GoJS 批量渲染
   * 
   * 开启：使用事务批量添加节点
   * 关闭：逐个添加节点
   * 
   * 预期收益：减少布局重计算，渲染时间 -300ms
   */
  GOJS_BATCH_RENDER: true,

  /**
   * 【P2】Service Worker API 缓存
   * 
   * 开启：缓存 Supabase API 响应
   * 关闭：每次请求都访问网络
   * 
   * 预期收益：重复访问响应时间 -80%
   */
  SW_API_CACHE: true,

  /**
   * 【调试】启用性能日志
   * 
   * 开启：记录详细的性能指标
   * 关闭：静默模式
   */
  ENABLE_PERF_LOGGING: false,
} as const;

/**
 * 批量加载配置
 */
export const BATCH_LOAD_CONFIG = {
  /**
   * 首屏加载超时（毫秒）
   * 超时后回退到传统加载方式
   */
  FIRST_SCREEN_TIMEOUT: 10000,

  /**
   * 后台加载延迟（毫秒）
   * 首屏渲染后等待多久开始加载其他项目
   */
  BACKGROUND_LOAD_DELAY: 100,

  /**
   * requestIdleCallback 超时（毫秒）
   * 确保后台加载不会无限等待
   */
  IDLE_CALLBACK_TIMEOUT: 5000,

  /**
   * RPC 调用超时（毫秒）
   */
  RPC_TIMEOUT: 30000,

  /**
   * RPC 失败后的回退策略
   */
  FALLBACK_ON_RPC_ERROR: true,
} as const;

/**
 * GoJS 渲染优化配置
 */
export const GOJS_PERF_CONFIG = {
  /**
   * 批量添加阈值
   * 节点数超过此值时使用批量添加
   */
  BATCH_ADD_THRESHOLD: 10,

  /**
   * 禁用动画的节点数阈值
   * 节点数超过此值时临时禁用动画
   */
  DISABLE_ANIMATION_THRESHOLD: 50,

  /**
   * 虚拟化阈值
   * 节点数超过此值时启用虚拟化
   */
  VIRTUALIZATION_THRESHOLD: 200,

  /**
   * 布局计算超时（毫秒）
   */
  LAYOUT_TIMEOUT: 5000,
} as const;

/**
 * 骨架屏配置
 */
export const SKELETON_CONFIG = {
  /**
   * 最小显示时间（毫秒）
   * 避免骨架屏闪烁
   */
  MIN_DISPLAY_TIME: 300,

  /**
   * 最大显示时间（毫秒）
   * 超时后强制隐藏
   */
  MAX_DISPLAY_TIME: 10000,

  /**
   * 淡出动画时间（毫秒）
   */
  FADE_OUT_DURATION: 200,
} as const;

/**
 * 性能监控配置
 */
export const PERF_MONITORING_CONFIG = {
  /**
   * LCP 警告阈值（毫秒）
   */
  LCP_WARNING_THRESHOLD: 2500,

  /**
   * LCP 错误阈值（毫秒）
   */
  LCP_ERROR_THRESHOLD: 4000,

  /**
   * API 请求数警告阈值
   */
  API_COUNT_WARNING_THRESHOLD: 10,

  /**
   * 首屏时间警告阈值（毫秒）
   */
  FIRST_SCREEN_WARNING_THRESHOLD: 3000,

  /**
   * 是否上报性能指标到 Sentry
   */
  REPORT_TO_SENTRY: true,
} as const;
