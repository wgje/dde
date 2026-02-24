// ============================================
// State Overlap — 停泊功能配置常量
// 策划案 A9 配置常量规范
// ============================================

/**
 * 停泊功能配置
 *
 * ⚠️ 禁止新增以下已废弃常量：
 * MAX_PARKED_TASKS, MISSION_CONTROL_THRESHOLD, OVERLAP_NOTICE_DURATION,
 * LATER_TODAY_CAP, LATER_TODAY_HIDDEN_AFTER, TOMORROW_MORNING,
 * LATER_TODAY, SIDEBAR_PARKING_HEIGHT
 */
export const PARKING_CONFIG = {
  /** 72h 覆盖完整周末（周五下午 → 周一上午） */
  PARKED_TASK_STALE_THRESHOLD: 72 * 60 * 60 * 1000,
  /** 距 72h 剩余 8h 时显示"即将清理"橙色标签 */
  PARKED_TASK_STALE_WARNING: 64 * 60 * 60 * 1000,
  /** 只警告，不强删（此值待 MVP 验证后调整） */
  PARKED_TASK_SOFT_LIMIT: 10,

  /** 最短可见时长（毫秒），防误消散 */
  NOTICE_MIN_VISIBLE_MS: 2500,
  /** 无操作兜底淡出时长（毫秒） */
  NOTICE_FALLBACK_TIMEOUT_MS: 15000,
  /** 提醒通知前 5s 不被外部交互消散（三阶段渐进消散的第一阶段） */
  REMINDER_IMMUNE_MS: 5000,

  /** 恢复高亮闪烁时长——亮起→保持→淡出三段式 */
  EDIT_LINE_FLASH_DURATION: 1000,

  /** Snooze 预设时间（毫秒） */
  SNOOZE_PRESETS: {
    /** 5 分钟 */
    QUICK: 5 * 60 * 1000,
    /** 30 分钟 */
    NORMAL: 30 * 60 * 1000,
    /**
     * 2h-later = 当前时间 + 2h，不封顶
     * ⚠️ 不使用 "later-today" 命名——用户在 23:00 操作时 +2h 会跨天，
     * "today" 暗示日内，产生认知歧义
     */
    TWO_HOURS_LATER: 2 * 60 * 60 * 1000,
    /** 备选第三档：当前时间 + 24h */
    TOMORROW_SAME_TIME: 24 * 60 * 60 * 1000,
  },

  /**
   * Snooze 软上限
   * 5 次后视觉弱化但不禁止继续 snooze
   * 3 次在高强度工作日一上午即可用完，放宽至 5
   */
  MAX_SNOOZE_COUNT: 5,

  /** 最小触控目标尺寸（px），符合 WCAG 2.1 */
  MIN_TOUCH_TARGET: 44,

  /**
   * 手动移除停泊项后 Snackbar 撤回窗口（毫秒）
   * 5s 符合 Material Design 默认值，留够阅读+决策时间
   */
  REMOVE_UNDO_TIMEOUT_MS: 5000,

  /**
   * 自动衰老清理后 Snackbar 撤回窗口（毫秒）
   * 系统行为需更长理解时间
   */
  EVICTION_UNDO_TIMEOUT_MS: 8000,

  /**
   * 衰老清理在启动后延迟执行的等待时间（毫秒）
   * 用户首次交互后再延迟此毫秒数
   */
  EVICTION_STARTUP_DELAY_MS: 3000,

  // ─── Dock 布局 ───
  /**
   * 触发条基准宽度（收起态胶囊），实际 180-220px 自适应文案长度
   */
  DOCK_TRIGGER_WIDTH: 200,
  /** 触发条高度 */
  DOCK_TRIGGER_HEIGHT: 32,
  /**
   * 展开态面板最大宽度
   * CSS: min(720px, 80vw)
   */
  DOCK_EXPANDED_MAX_WIDTH: 720,
  /**
   * 展开态面板基准高度 vh
   * CSS: clamp(280px, 45vh, min(480px, 70vh))
   */
  DOCK_EXPANDED_HEIGHT_VH: 45,
  /** 展开/收起动画时长（毫秒） */
  DOCK_ANIMATION_MS: 200,
  /** 左侧列表栏占展开面板宽度比例 */
  DOCK_LIST_RATIO: 0.4,
  /** 移动端 Bottom Sheet 最大高度（vh 百分比） */
  DOCK_MOBILE_MAX_HEIGHT_VH: 70,
  /** 移动端下拉收起阈值（px） */
  DOCK_MOBILE_DISMISS_THRESHOLD: 80,

  // ─── 提醒红点 ───
  /** 提醒通知连续被兜底淡出此次数后显示红点 */
  REMINDER_BADGE_THRESHOLD: 2,

  // ─── BeforeUnload ───
  /** BeforeUnload 注册优先级（高于默认 10） */
  BEFORE_UNLOAD_PRIORITY: 5,
  /** localStorage 草稿 key */
  SNAPSHOT_DRAFT_KEY: 'parking-snapshot-draft',
} as const;
