// ============================================
// 启动性能优化配置（弱网优先）
// ============================================

/**
 * 启动性能二阶段配置
 */
export const STARTUP_PERF_CONFIG = {
  /**
   * index.html 是否允许执行预加载 fetch
   * 默认 false：关闭首屏无效预请求
   */
  INDEX_PRELOAD_FETCH_ENABLED: false,

  /**
   * 增强字体样式兜底延迟加载时间（毫秒）
   * 无用户交互时到点自动加载
   */
  FONT_ENHANCED_LOAD_DELAY_MS: 8000,

  /**
   * 增强字体优先交互触发（V2）
   */
  FONT_ENHANCED_INTERACTION_ONLY_V2: true,

  /**
   * 增强字体强制兜底加载上限（毫秒）
   * 防止长时间停留在 fallback 字体
   */
  FONT_ENHANCED_FORCE_LOAD_MAX_DELAY_MS: 15000,

  /**
   * 弱网/省流模式下，timeout 触发不抢首阶段带宽
   */
  FONT_ENHANCED_SKIP_ON_CONSTRAINED_NETWORK: true,

  /**
   * Focus 启动后远端拉取的最早触发时间（毫秒）
   */
  FOCUS_REMOTE_STARTUP_DELAY_MS: 4000,

  /**
   * Focus 启动远端拉取前要求页面连续可见最短时长（毫秒）
   */
  FOCUS_REMOTE_MIN_VISIBLE_MS: 1200,

  /**
   * Flow 自动恢复（桌面 + 非弱网）空闲触发延迟
   */
  FLOW_RESTORE_IDLE_DELAY_MS: 1200,

  /**
   * Flow 弱网模式下仅预热 chunk 的空闲延迟
   */
  FLOW_IDLE_PRELOAD_DELAY_MS: 3000,

  /**
   * Flow 自动恢复允许的最大 RTT（毫秒）
   */
  FLOW_RESTORE_MAX_RTT_MS: 280,

  /**
   * Flow 弱网判定的最小下行带宽阈值（Mbps）
   */
  FLOW_IDLE_PRELOAD_MIN_DOWNLINK_MBPS: 1.5,

  /**
   * 事件驱动同步脉冲：可见态心跳间隔（毫秒）
   */
  SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS: 300000,

  /**
   * 事件驱动同步脉冲：事件冷却窗口（毫秒）
   */
  SYNC_EVENT_COOLDOWN_MS: 10000,

  /**
   * 跨标签本地回填冷却窗口（毫秒）
   */
  TAB_SYNC_LOCAL_REFRESH_COOLDOWN_MS: 3000,

  /**
   * 构建门禁：main 入口包体上限（KB，raw）
   */
  STARTUP_MAIN_MAX_KB: 260,

  /**
   * 弱网门禁：启动阶段 fetch 请求上限
   */
  STARTUP_INITIAL_FETCH_MAX: 12,

  /**
   * 认证态弱网门禁：首阶段数据请求上限（fetch/xhr）
   */
  STARTUP_INITIAL_DATA_FETCH_MAX: 20,

  /**
   * 弱网 strict 模式下允许的 modulepreload 数量
   */
  STARTUP_MODULEPRELOAD_MAX: 0,

  /**
   * 构建门禁：main/polyfills 递归静态依赖闭包体积上限（KB，raw）
   */
  STARTUP_INITIAL_STATIC_JS_MAX_KB: 340,

  /**
   * 构建门禁：workspace shell 入口 chunk 体积上限（KB，raw）
   */
  STARTUP_WORKSPACE_CHUNK_MAX_KB: 125,

  /**
   * 构建门禁：main 静态 import-statement 数量上限
   */
  STARTUP_MAIN_STATIC_IMPORT_MAX: 10,

  /**
   * 分层启动：P1 交互层预热延迟
   */
  P1_INTERACTION_HYDRATE_DELAY_MS: 500,

  /**
   * 分层启动：P2 同步层预热延迟
   */
  P2_SYNC_HYDRATE_DELAY_MS: 2000,

  /**
   * 分层启动：P2 触发前最短可见时长
   */
  P2_SYNC_MIN_VISIBLE_MS: 1200,
} as const;
