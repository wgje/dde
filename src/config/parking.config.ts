// ============================================
// Parking / Dock feature constants
// ============================================

import type { FragmentEventCategory } from '../models/parking-dock';

export const PARKING_CONFIG = {
  MOTION: {
    easing: {
      // 大动作统一使用柔和收束曲线，避免入场时的生硬回弹感。
      enter: 'cubic-bezier(0.22, 1, 0.36, 1)',
      // 常规结构切换、透明度变化共享同一节奏，避免父子层级速度冲突。
      standard: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      // 退出不再使用偏陡曲线，改为更短更稳的收尾。
      exit: 'cubic-bezier(0.4, 0, 0.2, 1)',
      micro: 'cubic-bezier(0.18, 0.75, 0.28, 1)',
      // 柔和弹性：轻微弹性触感但无过冲
      spring: 'cubic-bezier(0.2, 0.8, 0.3, 1.0)',
    },
    shell: {
      enterMs: 320,
      exitMs: 260,
    },
    overlay: {
      enterMs: 280,
      exitMs: 220,
    },
    panel: {
      enterMs: 220,
      exitMs: 180,
      peekMs: 180,
    },
    focus: {
      enterMs: 340,
      exitMs: 280,
      stageDelayMs: 40,
      radarDelayMs: 90,
      hudDelayMs: 120,
      ambientDelayMs: 140,
    },
    card: {
      clickExitMs: 140,
      waitExitMs: 150,
      completeExitMs: 160,
      promoteMs: 160,
      reorderMs: 180,
      detailMs: 160,
    },
    radar: {
      promoteMs: 180,
      appearMs: 220,
      returnMs: 180,
      hoverMs: 140,
    },
    hud: {
      enterMs: 200,
    },
    notice: {
      enterMs: 200,
      exitMs: 160,
    },
    micro: {
      hoverMs: 140,
      pressMs: 120,
      pulseMs: 160,
      glowMs: 160,
    },
    distance: {
      panelLiftPx: 12,
      panelPeekPx: 6,
      focusShiftPx: 6,
      focusExitShiftPx: 8,
      cardHoverLiftPx: 2,
      cardHoverScale: 1.006,
      cardPressScale: 0.988,
      cardFlyPx: 84,
      cardSinkPx: 10,
      cardPushStartPx: 10,
      cardPushBackPx: 28,
      radarFloatPx: 2,
      radarMagnetLiftPx: 12,
      semicircleLiftPx: 8,
    },
    console: {
      durationMs: {
        completeExit: 160,
        completeShift: 160,
        suspendExit: 150,
        suspendReturn: 160,
        switch: 180,
        radar: 180,
      },
      poses: {
        focus: {
          translateX: 0,
          translateY: 0,
          translateZ: 0,
          scale: 1,
          rotateXDeg: 0,
          opacity: 1,
          blurPx: 0,
          zIndex: 50,
        },
        depth1: {
          translateX: 8,
          translateY: -16,
          translateZ: -10,
          scale: 0.96,
          rotateXDeg: 0,
          opacity: 0.7,
          blurPx: 0.4,
          zIndex: 39,
        },
        depth2: {
          translateX: 16,
          translateY: -32,
          translateZ: -20,
          scale: 0.92,
          rotateXDeg: 0,
          opacity: 0.5,
          blurPx: 0.8,
          zIndex: 36,
        },
        depth3: {
          translateX: 24,
          translateY: -48,
          translateZ: -30,
          scale: 0.88,
          rotateXDeg: 0,
          opacity: 0.3,
          blurPx: 1.2,
          zIndex: 33,
        },
        offstageTop: {
          translateX: 10,
          translateY: -156,
          translateZ: 48,
          scale: 0.68,
          rotateXDeg: -2.5,
          opacity: 0,
          blurPx: 0,
          zIndex: 58,
        },
        offstageBottom: {
          translateX: 18,
          translateY: 42,
          translateZ: -44,
          scale: 0.84,
          rotateXDeg: 2,
          opacity: 0,
          blurPx: 1.4,
          zIndex: 48,
        },
        offstageBack: {
          translateX: 92,
          translateY: -142,
          translateZ: -76,
          scale: 0.58,
          rotateXDeg: 8,
          opacity: 0,
          blurPx: 2.2,
          zIndex: 30,
        },
        radarEntry: {
          translateX: 0,
          translateY: 80,
          translateZ: -80,
          scale: 0.5,
          rotateXDeg: 6,
          opacity: 0,
          blurPx: 1.8,
          zIndex: 31,
        },
      },
    },
  },

  // Core
  PARKED_TASK_STALE_THRESHOLD: 72 * 60 * 60 * 1000,
  PARKED_TASK_STALE_WARNING: 64 * 60 * 60 * 1000,
  PARKED_TASK_SOFT_LIMIT: 10,

  NOTICE_MIN_VISIBLE_MS: 2500,
  NOTICE_FALLBACK_TIMEOUT_MS: 15000,
  REMINDER_IMMUNE_MS: 5000,
  EDIT_LINE_FLASH_DURATION: 1000,

  SNOOZE_PRESETS: {
    QUICK: 5 * 60 * 1000,
    NORMAL: 30 * 60 * 1000,
    TWO_HOURS_LATER: 2 * 60 * 60 * 1000,
    TOMORROW_SAME_TIME: 24 * 60 * 60 * 1000,
  },

  MAX_SNOOZE_COUNT: 5,
  MIN_TOUCH_TARGET: 44,
  REMOVE_UNDO_TIMEOUT_MS: 5000,
  EVICTION_UNDO_TIMEOUT_MS: 8000,
  EVICTION_STARTUP_DELAY_MS: 3000,

  // Dock layout
  DOCK_TRIGGER_WIDTH: 200,
  DOCK_TRIGGER_HEIGHT: 32,
  DOCK_EXPANDED_MAX_WIDTH: 860,
  DOCK_BAR_HEIGHT: 120,
  DOCK_ANIMATION_MS: 220,
  DOCK_BOTTOM_OFFSET_PX: 24,
  DOCK_MOBILE_MAX_HEIGHT_VH: 70,
  DOCK_MOBILE_DISMISS_THRESHOLD: 80,
  DOCK_PARK_BUTTON_SYNC_MODE: 'on' as 'off' | 'on',
  DOCK_FOCUS_CONTENT_EFFECT: 'dim' as 'dim' | 'hide',
  // Deprecated alias for legacy call sites; prefer DOCK_FOCUS_CONTENT_EFFECT.
  DOCK_FOCUS_TAKEOVER_MODE: 'blur' as 'hidden' | 'blur',
  DOCK_V3_STRICT_SAMPLE_UI: false,
  DOCK_V3_SHOW_ADVANCED_UI: true,
  DOCK_V3_SHOW_HELP_HINTS: true,
  DOCK_FOCUS_DIM_OPACITY: 0.35,
  DOCK_FOCUS_DIM_TRANSLATE_Y_PX: 12,
  DOCK_DROP_REJECT_SHAKE_MS: 180,
  DOCK_DROP_REJECT_RESET_MS: 220,
  DOCK_SEMICIRCLE_BASE_WIDTH_PX: 80,
  DOCK_SEMICIRCLE_BASE_HEIGHT_PX: 40,
  DOCK_SEMICIRCLE_EXPANDED_WIDTH_PX: 160,
  DOCK_SEMICIRCLE_EXPANDED_HEIGHT_PX: 52,
  DOCK_SEMICIRCLE_DRAG_EXPAND_DELAY_MS: 500,
  DOCK_SEMICIRCLE_AUTO_COLLAPSE_MS: 2000,
  DOCK_EXIT_CONFIRM_RESTORE_HINT_MS: 3000,
  DOCK_CONSOLE_SOFT_LIMIT: 15,
  DOCK_CONSOLE_HARD_LIMIT: 30,

  // Focus shell (v3)
  DOCK_FOCUS_BG_IMAGE_URL:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%230b1020'/%3E%3Cstop offset='55%25' stop-color='%231a1f3b'/%3E%3Cstop offset='100%25' stop-color='%23230f2f'/%3E%3C/linearGradient%3E%3CradialGradient id='r1' cx='25%25' cy='30%25' r='40%25'%3E%3Cstop offset='0%25' stop-color='%234f46e5' stop-opacity='0.35'/%3E%3Cstop offset='100%25' stop-color='%234f46e5' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='r2' cx='75%25' cy='70%25' r='45%25'%3E%3Cstop offset='0%25' stop-color='%2310b981' stop-opacity='0.2'/%3E%3Cstop offset='100%25' stop-color='%2310b981' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Crect width='1600' height='900' fill='url(%23g)'/%3E%3Crect width='1600' height='900' fill='url(%23r1)'/%3E%3Crect width='1600' height='900' fill='url(%23r2)'/%3E%3C/svg%3E",
  // Full-screen blur is disabled to avoid expensive GPU composition in focus mode.
  DOCK_FOCUS_BACKDROP_BLUR_PX: 0,
  DOCK_FOCUS_BACKDROP_ALPHA: 0.82,
  DOCK_STAGE_OFFSET_Y_PX: 48,
  DOCK_FOCUS_FLIP_DURATION_MS: 340,
  DOCK_FOCUS_FLIP_EASING: 'cubic-bezier(0.22, 1, 0.36, 1)',
  DOCK_FOCUS_FLIP_GHOST_OPACITY: 0.92,
  DOCK_FOCUS_FLIP_Z_INDEX: 75,
  // Focus mode animation strategy: prioritize stable frame pacing over decorative loops.
  FOCUS_MOTION_PROFILE: 'performance' as 'default' | 'performance',
  FOCUS_ENABLE_RADAR_FLOAT: false,
  FOCUS_ENABLE_STACK_SWIPE_HINT: false,
  // 策划案：等待结束时状态机光晕提示用户主任务就绪，默认开启
  FOCUS_ENABLE_STATUS_EXTRA_GLOW: true,
  FOCUS_ENABLE_REST_REMINDER_GLOW: true,
  FOCUS_DEBUG_PERF_METRICS: false,
  FOCUS_SCENE_TRANSPARENT_ALPHA: 0.28,
  FOCUS_SCENE_TRANSPARENT_STAGE_ALPHA: 0.72,
  FOCUS_SCENE_TRANSPARENT_VIGNETTE_ALPHA: 0.24,
  FOCUS_SCENE_ENTRY_BG_MS: 0,
  FOCUS_SCENE_ENTRY_STAGE_MS: 40,
  FOCUS_SCENE_ENTRY_RADAR_MS: 90,
  FOCUS_SCENE_ENTRY_ENV_MS: 140,
  FOCUS_SCENE_ENTRY_HUD_MS: 120,
  FOCUS_BLANK_PERIOD_BREATHE_DURATION_S: 5.4,
  FOCUS_BLANK_PERIOD_DRIFT_DURATION_S: 9.2,

  // Console stack
  CONSOLE_CARD_WIDTH: 340,
  CONSOLE_CARD_HEIGHT: 440,
  CONSOLE_STACK_VISIBLE_MAX: 4,
  CONSOLE_STACK_SCALE: 0.85,
  CONSOLE_STACK_Y_OFFSET: -60,
  CONSOLE_STACK_BG_OPACITY: 0.4,
  // 动画计时器必须 >= CSS animation duration，否则 setTimeout 提前触发会卡在动画最后几帧。
  // 过早修改 DOM（移除 will-change、更新 entries signal）会导致合成层降级和布局抖动。
  CONSOLE_FLY_OUT_MS: 160,
  CONSOLE_PUSH_IN_MS: 160,
  CONSOLE_DRAW_MS: 180,
  CONSOLE_SINK_MS: 150,
  CONSOLE_SILENT_APPEAR_MS: 160,
  CONSOLE_PUSH_BACK_MS: 180,
  CONSOLE_MAGNET_PULL_MS: 180,

  // Radar
  RADAR_STRONG_RADIUS: 280,
  RADAR_WEAK_RADIUS: 420,
  RADAR_STRONG_OPACITY: 0.6,
  RADAR_WEAK_OPACITY: 0.25,
  RADAR_WEAK_SCALE: 0.9,
  RADAR_CREATE_FORM_WIDTH: 240,
  RADAR_FLOAT_DURATION_S: 4.2,
  RADAR_HIGHLIGHT_PULSE_MS: 320,
  RADAR_COMBO_VISIBLE_LIMIT: 8,
  RADAR_BACKUP_VISIBLE_LIMIT: 10,
  RADAR_PROJECT_SHARED_COLOR: '#64748b',
  RADAR_PROJECT_COLOR_PALETTE: [
    '#38bdf8',
    '#f97316',
    '#22c55e',
    '#eab308',
    '#f43f5e',
    '#14b8a6',
    '#a855f7',
    '#84cc16',
    '#06b6d4',
    '#f59e0b',
  ] as const,

  // Status machine
  STATUS_MACHINE_MIN_WIDTH: 220,
  STATUS_RING_PULSE_MS: 320,
  STATUS_MACHINE_NOTIFICATION_TONE_HZ: 440,
  STATUS_MACHINE_NOTIFICATION_DURATION_MS: 200,
  STATUS_RING_STROKE_WIDTH: 2.5,
  STATUS_RING_RADIUS: 9,
  STATUS_RING_WAIT_STROKE: '#f59e0b',
  STATUS_RING_EXPIRED_STROKE: '#fbbf24',

  // Scheduling — 调度评分权重与阈值
  /** 紧张窗口判定阈值（分钟）：剩余 ≤ 2min 视为紧张留白期 */
  SCHEDULE_TIGHT_THRESHOLD_MINUTES: 2,
  /** combo-select 区候选强匹配权重 */
  SCHEDULE_STRONG_ZONE_WEIGHT: 35,
  /** backup 区候选弱匹配权重 */
  SCHEDULE_WEAK_ZONE_WEIGHT: 20,
  /** 树距离强关联权重（直接父子/兄弟） */
  SCHEDULE_RELATION_STRONG_WEIGHT: 32,
  /** 树距离弱关联权重（远亲节点） */
  SCHEDULE_RELATION_WEAK_WEIGHT: 12,
  /** relationScore 归一化上限 */
  SCHEDULE_RELATION_SCORE_CAP: 100,
  /** 低负荷候选权重 */
  SCHEDULE_LOW_LOAD_WEIGHT: 20,
  /** 高负荷候选权重 */
  SCHEDULE_HIGH_LOAD_WEIGHT: 8,
  /** 负荷切换奖励：高→低 */
  SCHEDULE_LOAD_TRANSITION_LOW_BONUS: 10,
  /** 负荷切换惩罚：高→高 */
  SCHEDULE_LOAD_TRANSITION_HIGH_PENALTY: -8,
  // GAP-2: 同项目为最低优先级，惩罚值从 -7 降为 -2，使树距离主导调度
  SCHEDULE_PROJECT_SWITCH_PENALTY: -2,
  /** 时间窗口紧密匹配权重 */
  SCHEDULE_TIME_TIGHT_MATCH_WEIGHT: 30,
  SCHEDULE_TIME_NORMAL_MATCH_WEIGHT: 20,
  SCHEDULE_TIME_SMALL_OVERRUN_WEIGHT: 12,
  SCHEDULE_WAIT_WINDOW_FIT_WEIGHT: 14,
  SCHEDULE_TIME_MISMATCH_PENALTY: -10,
  SCHEDULE_WAIT_CHILD_WEIGHT: 8,
  /** 容许超出窗口的分钟数 */
  SCHEDULE_OVER_RUN_ALLOWANCE_MINUTES: 10,
  /** 紧密匹配判定范围（分钟） */
  SCHEDULE_TIGHT_REMAINING_MINUTES: 5,
  /** 候选过长比率阈值（expectedMinutes / remainingMinutes） */
  SCHEDULE_CANDIDATE_C_TOO_LONG_RATIO: 1.5,
  /** 候选过短比率阈值 */
  SCHEDULE_CANDIDATE_C_TOO_SHORT_RATIO: 0.35,
  /** 待决策卡片存活时间（毫秒） */
  PENDING_DECISION_TTL_MS: 3 * 60 * 1000,
  FRAGMENT_PHASE_AUTO_POPUP: true,
  // Oversized recommendation threshold for the relaxed large-card fallback (分钟).
  RECOMMENDATION_OVERSIZED_THRESHOLD_MINUTES: 30,

  // 倦怠检测 — 2h 滑动窗口内高负荷完成次数达到阈值即触发冷却
  /** 倦怠检测滑动窗口（毫秒） — 2 小时 */
  BURNOUT_WINDOW_MS: 2 * 60 * 60 * 1000,
  /** 窗口内高负荷完成次数阈值 */
  BURNOUT_HIGH_LOAD_THRESHOLD: 3,
  /** 倦怠冷却期（毫秒） — 20 分钟 */
  BURNOUT_COOLDOWN_MS: 20 * 60 * 1000,

  // 碎片阶段防御
  /** 被动碎片触发阈值（分钟） */
  FRAGMENT_PASSIVE_THRESHOLD_MINUTES: 5,
  /** silentFade 动画时长（毫秒） */
  FRAGMENT_SILENT_FADE_MS: 600,
  FRAGMENT_CATEGORY_SORT_ORDER: ['physical-crossover', 'digital-janitor', 'micro-progress'] as readonly FragmentEventCategory[],
  // Zen mode center pulse defaults.
  ZEN_MODE_PULSE_SIZE_PX: 60,
  ZEN_MODE_BLUR_PX: 8,
  ZEN_MODE_HINT_TEXT: '放空一会儿…',
  ZEN_MODE_BREATHE_DURATION_S: 4,
  ZEN_MODE_PRIMARY_RGB: '99 102 241',
  ZEN_MODE_SECONDARY_RGB: '52 211 153',
  ZEN_MODE_BURNOUT_PRIMARY_RGB: '245 158 11',
  ZEN_MODE_BURNOUT_SECONDARY_RGB: '248 113 113',
  // 休息时间提醒阈值（策划案设计：高负荷工作者更耐疲劳但需更严格的总量控制，
  // 因此高负荷阈值 90min 大于低负荷 30min —— 低负荷场景更频繁提醒以保持活力）
  REST_REMINDER_HIGH_LOAD_THRESHOLD_MS: 90 * 60 * 1000,
  REST_REMINDER_LOW_LOAD_THRESHOLD_MS: 30 * 60 * 1000,
  // 碎片时间用户选择倒计时（秒）
  FRAGMENT_ENTRY_COUNTDOWN_S: 8,
  // 组合任务完成后碎片过渡倒计时（秒），期间同时展示推荐候选
  FRAGMENT_TRANSITION_COUNTDOWN_S: 6,
  // 等待结束光晕降级时间（毫秒）：持续闪动后自动降级为静态微光，避免持续催促感
  GLOW_DEGRADE_AFTER_MS: 3 * 60 * 1000,
  // Undo window after destructive dock actions.
  UNDO_WINDOW_MS: 3000,
  // Fourth visible background card in the console stack.
  CONSOLE_STACK_4TH_OPACITY: 0.15,
  CONSOLE_STACK_4TH_SCALE: 0.62,
  CONSOLE_STACK_4TH_BLUR_PX: 2.0,
  CONSOLE_STACK_4TH_TITLE_MAX_CHARS: 8,
  // Minimal HUD pill defaults for transparent focus mode.
  HUD_MINIMAL_PILL_OPACITY: 0.6,
  HUD_MINIMAL_TOP_PX: 16,
  HUD_MINIMAL_WIDTH_PX: 200,
  HUD_FULL_MAX_WIDTH_PX: 290,
  HUD_FULL_MAX_HEIGHT_PX: 220,
  HUD_FULL_DEFAULT_TOP_PX: 16,
  HUD_SAFE_RIGHT_INSET_PX: 104,
  HUD_EXPAND_ON_HOVER: true,
  FIRST_MAIN_OVERRIDE_WINDOW_MS: 15000,
  FOCUS_HUD_LAYOUT_STORAGE_KEY: 'focusConsole.hudLayout.v1',
  FOCUS_CONSOLE_V2_ENABLED: true,
  FOCUS_CONSOLE_LEADER_CHANNEL: 'nanoflow-focus-console-leader',
  FOCUS_CONSOLE_LEADER_LEASE_KEY: 'nanoflow.focus-console.leader-lease',
  FOCUS_CONSOLE_LEASE_MS: 10000,
  FOCUS_CONSOLE_HEARTBEAT_MS: 3000,
  FOCUS_CONSOLE_FOLLOWER_STALE_MS: 15000,
  FOCUS_PERF_SAMPLE_WINDOW_MS: 1000,
  FOCUS_PERF_T1_FPS: 45,
  FOCUS_PERF_T2_FPS: 30,
  FOCUS_PERF_RECOVER_FPS: 52,
  FOCUS_PERF_HYSTERESIS_WINDOWS: 2,
  // Daily routine slots visible during fragment mode.
  ROUTINE_SLOTS_MAX_PER_DAY: 8,
  ROUTINE_RESET_HOUR_DEFAULT: 0,

  // Misc
  REMINDER_BADGE_THRESHOLD: 2,
  BEFORE_UNLOAD_PRIORITY: 5,
  SNAPSHOT_DRAFT_KEY: 'parking-snapshot-draft',
  DOCK_SNAPSHOT_STORAGE_KEY: 'nanoflow.dock-snapshot.v3',
} as const;
