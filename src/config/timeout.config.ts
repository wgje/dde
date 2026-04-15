// ============================================
// 超时与重试配置
// 包含 API 超时策略、重试策略相关常量
// ============================================

/**
 * 分级超时策略配置
 * 根据业务场景设置不同的超时时间：
 * - QUICK: 快速读取操作（简单查询、检查存在性）
 * - STANDARD: 普通 API 调用（增删改查）
 * - HEAVY: 重型操作（复杂聚合查询、批量操作）
 * - UPLOAD: 文件上传操作
 */
export const TIMEOUT_CONFIG = {
  /** 快速读取操作超时（毫秒）- 5秒 */
  QUICK: 5000,
  /** 普通 API 调用超时（毫秒）- 10秒 */
  STANDARD: 10000,
  /** 重型操作超时（毫秒）- 30秒 */
  HEAVY: 30000,
  /** 文件上传超时（毫秒）- 60秒 */
  UPLOAD: 60000,
  /** 实时连接超时（毫秒）- 15秒 */
  REALTIME: 15000,
} as const;

export type TimeoutLevel = keyof typeof TIMEOUT_CONFIG;

/**
 * 空闲调度 fallback 超时
 * 当 `requestIdleCallback` 不可用（Safari 等）或业务方不想等到真正空闲时，
 * 用 `setTimeout` 回退到一个"伪空闲"时间点。统一命名，避免散落的魔数。
 */
export const IDLE_SCHEDULE_CONFIG = {
  /** 轻量任务的空闲 fallback（毫秒）- 关键渲染路径之外的小型初始化 */
  SHORT_MS: 1200,
  /** 常规任务的空闲 fallback（毫秒）- 如启动后增量云端拉取 */
  STANDARD_MS: 2000,
  /** 重型任务的空闲 fallback（毫秒）- 如 Sentry/埋点初始化，远离 LCP */
  LONG_MS: 5000,
} as const;

/**
 * Supabase 客户端全局 fetch 上限（毫秒）
 * - 覆盖所有非上传请求，避免长尾请求永远挂起占用连接池
 * - 业务方仍可通过自带 AbortSignal 更早取消，本值仅为「最后防线」
 * - 2 分钟：兼顾 Realtime long-poll / 大批查询，同时不会堆积到用户感知
 */
export const SUPABASE_CLIENT_FETCH_MAX_MS = 120_000;

/**
 * UI 反馈级短超时（毫秒）
 * 用于 DOM 动画、高亮、toast 等即时视觉反馈，不涉及网络或后台工作。
 * 这些值应该保持一致，以统一应用的"响应感"。
 */
export const UI_FEEDBACK_DELAY = {
  /** 焦点/高亮自动消退（毫秒）- 300ms = 一帧多刷新，肉眼可见但不烦人 */
  HIGHLIGHT_CLEAR: 300,
  /** 瞬时通知/Flash 消退（毫秒）- 300ms，同上 */
  FLASH_CLEAR: 300,
  /** 初始焦点获取延迟（毫秒）- 100ms，DOM 稳定后再焦点，避免抢占 */
  INITIAL_FOCUS: 100,
  /** 上传/处理完成通知显示时长（毫秒）- 3s，给用户充分时间看到成功提示 */
  UPLOAD_COMPLETE_NOTIFY: 3000,
} as const;

/**
 * 业务关键路径短轮询超时（毫秒）
 * 用于同步点检查、状态确认等"等待关键事件就绪"的场景。
 * 典型持续时间 200-500ms。
 */
export const POLLING_CHECK_DELAY = {
  /** 同步完成检查（毫秒）- 200ms */
  SYNC_READY: 200,
  /** 特定条件检查（毫秒）- 500ms */
  CONDITION_READY: 500,
} as const;

/**
 * 配置操作延迟（毫秒）
 * 用于配置变更的防抖 / 持久化稳定化。
 */
export const CONFIG_OPERATION_DELAY = {
  /** 配置稳定化保存（毫秒）- 100ms，给配置加载/迁移足够时间稳定 */
  SAVE_STABILIZE: 100,
} as const;

/**
 * 重试策略配置
 * 针对幂等操作（GET 请求、存在性检查等）自动重试
 */
export const RETRY_POLICY = {
  /** 最大重试次数 */
  MAX_RETRIES: 3,
  /** 初始重试延迟（毫秒） */
  INITIAL_DELAY: 500,
  /** 最大重试延迟（毫秒） */
  MAX_DELAY: 5000,
  /** 延迟增长因子（指数退避） */
  BACKOFF_FACTOR: 2,
  /** 可重试的 HTTP 状态码 */
  RETRYABLE_STATUS_CODES: [408, 429, 500, 502, 503, 504],
  /** 可重试的错误消息模式 */
  RETRYABLE_ERROR_PATTERNS: [
    'network',
    'timeout',
    'ECONNRESET',
    'ETIMEDOUT',
    'fetch failed',
    'Failed to fetch'
  ],
} as const;

  /**
   * 批量数据库操作重试退避基准（毫秒）
   * 所有批量写操作（upsert/delete）的重试延迟公式均以此为单位：
   * - 线性退避: BATCH_RETRY_BASE_MS * (retry + 1) → 100ms, 200ms, 300ms
   * - 指数退避: BATCH_RETRY_BASE_MS * 2^retryCount → 100ms, 200ms, 400ms
   */
  export const BATCH_RETRY_BASE_MS = 100;

  /**
   * 网络离线检测防抖（毫秒）
   * 在标记离线前等待一小段时间再次确认，过滤瞬时网络波动导致的误判。
   */
  export const NETWORK_OFFLINE_DEBOUNCE_MS = 100;
