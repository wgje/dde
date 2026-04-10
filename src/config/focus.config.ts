// ============================================
// 专注模式配置常量
// ============================================

import { SYNC_CONFIG } from './sync.config';

/**
 * 专注模式配置
 */
export const FOCUS_CONFIG = {
  // 大门配置
  GATE: {
    /** 检查遗留条目的时间范围（天） */
    PENDING_DAYS_RANGE: 7,
    /** 动画时长（毫秒） */
    TRANSITION_DURATION: 300,
    /** 每日最大跳过次数 */
    MAX_SNOOZE_PER_DAY: 3,
    /** 待机多久后回来重新触发大门检查（毫秒），默认 5 分钟 */
    IDLE_RECHECK_THRESHOLD: 5 * 60 * 1000,
  },
  
  // 地质层配置
  STRATA: {
    /** 显示的最大天数 */
    MAX_DISPLAY_DAYS: 30,
    /** 透明度衰减系数 */
    OPACITY_DECAY: 0.15,
    /** 最小透明度 */
    MIN_OPACITY: 0.3,
  },
  
  // 黑匣子配置
  BLACK_BOX: {
    /** 录音最大时长（秒）- 个人使用，不设上限，设置为极大值 */
    MAX_RECORDING_DURATION: 86400,
    /** 转写 API 超时（毫秒）- 需略大于 Edge Function 的 Groq 超时（25s），确保能收到带 CORS 头的错误响应 */
    TRANSCRIBE_TIMEOUT: 30000,
    /** 条目每日显示上限 */
    MAX_ENTRIES_PER_DAY: 999999,
  },
  
  // 语音转文字配置（Groq + whisper-large-v3）
  SPEECH_TO_TEXT: {
    /** Groq 使用的模型 */
    MODEL: 'whisper-large-v3',
    /** 语言 */
    LANGUAGE: 'zh',
    /** 音频格式优先级 */
    AUDIO_MIME_TYPES: [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/wav'
    ] as const,
    /** 每日配额限制 - 与 Edge Function DAILY_QUOTA_PER_USER 保持一致 */
    DAILY_QUOTA: 50,
    /** Edge Function 名称 */
    EDGE_FUNCTION_NAME: 'transcribe',
    /** 最大文件大小（字节）- Groq 限制 25MB */
    MAX_FILE_SIZE: 25 * 1024 * 1024,
    /** 最小录音大小（字节）- 避免过短录音 */
    MIN_FILE_SIZE: 1000,
    /** 音频采样率 */
    SAMPLE_RATE: 16000,
    /** 音频比特率 */
    AUDIO_BITS_PER_SECOND: 128000,
  },
  
  // 同步配置（与主架构对齐）
  SYNC: {
    /** 防抖延迟 — 引用 SYNC_CONFIG.DEBOUNCE_DELAY 作为唯一真实来源 */
    DEBOUNCE_DELAY: SYNC_CONFIG.DEBOUNCE_DELAY,
    /** IndexedDB 存储键前缀 */
    IDB_PREFIX: 'focus_',
    /** IndexedDB 数据库名称 */
    IDB_NAME: 'focus_mode',
    /** IndexedDB 版本 - v3: 新增 parked_tasks store（State Overlap） */
    IDB_VERSION: 3,
  },
  
  // IndexedDB Object Store 名称
  IDB_STORES: {
    BLACK_BOX_ENTRIES: 'black_box_entries',
    FOCUS_PREFERENCES: 'focus_preferences',
    OFFLINE_AUDIO_CACHE: 'offline_audio_cache',
    SYNC_METADATA: 'sync_metadata',
    /** 停泊任务跨项目缓存（v3 新增） */
    PARKED_TASKS: 'parked_tasks',
  },
  
  // 键盘快捷键
  KEYBOARD: {
    /** 大门：标记已读 */
    GATE_MARK_READ: ['1', 'Enter'],
    /** 大门：标记完成 */
    GATE_MARK_COMPLETED: ['2', ' '],
    /** 大门：稍后处理（Snooze） */
    GATE_SNOOZE: ['3'],
    /** 黑匣子条目：已读 */
    ENTRY_READ: ['r', 'R'],
    /** 黑匣子条目：完成 */
    ENTRY_COMPLETE: ['c', 'C'],
    /** 黑匣子条目：归档 */
    ENTRY_ARCHIVE: ['a', 'A'],
  },
} as const;
