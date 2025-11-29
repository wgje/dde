// ============================================
// 应用配置常量
// ============================================

/**
 * 布局配置
 */
export const LAYOUT_CONFIG = {
  /** 阶段间水平间距 */
  STAGE_SPACING: 260,
  /** 任务行垂直间距 */
  ROW_SPACING: 140,
  /** 根任务基础 rank 值 */
  RANK_ROOT_BASE: 10000,
  /** rank 步进值 */
  RANK_STEP: 500,
  /** rank 最小间隔 */
  RANK_MIN_GAP: 50,
} as const;

/**
 * 同步配置
 */
export const SYNC_CONFIG = {
  /** 防抖延迟（毫秒） */
  DEBOUNCE_DELAY: 800,
  /** 编辑状态超时（毫秒） */
  EDITING_TIMEOUT: 1500,
  /** 远程变更处理延迟（毫秒） */
  REMOTE_CHANGE_DELAY: 500,
} as const;

/**
 * 缓存配置
 */
export const CACHE_CONFIG = {
  /** 离线缓存 key */
  OFFLINE_CACHE_KEY: 'nanoflow.offline-cache-v2',
  /** 主题缓存 key */
  THEME_CACHE_KEY: 'nanoflow.theme',
  /** 缓存版本号 */
  CACHE_VERSION: 2,
} as const;

/**
 * 撤销/重做配置
 */
export const UNDO_CONFIG = {
  /** 最大撤销历史数 */
  MAX_HISTORY_SIZE: 50,
} as const;

/**
 * 字母表（用于 displayId 生成）
 */
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * 上标数字映射
 */
export const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
};
