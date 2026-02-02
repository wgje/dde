// ============================================
// 专注模式配置常量
// ============================================

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
  },
  
  // 聚光灯配置
  SPOTLIGHT: {
    /** 任务完成后延迟显示下一个（毫秒） */
    NEXT_TASK_DELAY: 500,
    /** 背景地质层透明度 */
    STRATA_BACKGROUND_OPACITY: 0.3,
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
    /** 录音最大时长（秒） */
    MAX_RECORDING_DURATION: 120,
    /** 转写 API 超时（毫秒）- Groq 极快，通常 1-2 秒 */
    TRANSCRIBE_TIMEOUT: 10000,
    /** 条目每日显示上限 */
    MAX_ENTRIES_PER_DAY: 50,
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
    /** 每日配额限制 */
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
    /** 防抖延迟（与 SYNC_CONFIG.DEBOUNCE_DELAY 一致） */
    DEBOUNCE_DELAY: 3000,
    /** IndexedDB 存储键前缀 */
    IDB_PREFIX: 'focus_',
    /** IndexedDB 数据库名称 */
    IDB_NAME: 'focus_mode',
    /** IndexedDB 版本 - 增加版本号以添加 sync_metadata store */
    IDB_VERSION: 2,
  },
  
  // IndexedDB Object Store 名称
  IDB_STORES: {
    BLACK_BOX_ENTRIES: 'black_box_entries',
    FOCUS_PREFERENCES: 'focus_preferences',
    OFFLINE_AUDIO_CACHE: 'offline_audio_cache',
    SYNC_METADATA: 'sync_metadata',
  },
  
  // 键盘快捷键
  KEYBOARD: {
    /** 大门：标记已读 */
    GATE_MARK_READ: ['1', 'Enter'],
    /** 大门：标记完成 */
    GATE_MARK_COMPLETED: ['2', ' '],
    /** 大门：稍后提醒 */
    GATE_SNOOZE: ['3', 's', 'S'],
    /** 黑匣子条目：已读 */
    ENTRY_READ: ['r', 'R'],
    /** 黑匣子条目：完成 */
    ENTRY_COMPLETE: ['c', 'C'],
    /** 黑匣子条目：归档 */
    ENTRY_ARCHIVE: ['a', 'A'],
  },
} as const;

/**
 * 专注模式错误码
 * @reserved 预留的错误码系统，供专注模式错误处理使用
 */
export const FocusErrorCodes = {
  /** 配额已用完 */
  QUOTA_EXCEEDED: 'FOCUS_QUOTA_EXCEEDED',
  /** 转写失败 */
  TRANSCRIBE_FAILED: 'FOCUS_TRANSCRIBE_FAILED',
  /** 浏览器不支持录音 */
  RECORDING_NOT_SUPPORTED: 'FOCUS_RECORDING_NOT_SUPPORTED',
  /** 麦克风权限被拒绝 */
  RECORDING_PERMISSION_DENIED: 'FOCUS_RECORDING_PERMISSION_DENIED',
  /** 录音太短 */
  RECORDING_TOO_SHORT: 'FOCUS_RECORDING_TOO_SHORT',
  /** 录音太长 */
  RECORDING_TOO_LONG: 'FOCUS_RECORDING_TOO_LONG',
  /** 网络错误 */
  NETWORK_ERROR: 'FOCUS_NETWORK_ERROR',
  /** 条目不存在 */
  ENTRY_NOT_FOUND: 'FOCUS_ENTRY_NOT_FOUND',
  /** 跳过次数已达上限 */
  SNOOZE_LIMIT_EXCEEDED: 'FOCUS_SNOOZE_LIMIT_EXCEEDED',
  /** 服务不可用 */
  SERVICE_UNAVAILABLE: 'FOCUS_SERVICE_UNAVAILABLE',
} as const;

export type FocusErrorCode = typeof FocusErrorCodes[keyof typeof FocusErrorCodes];

/**
 * 专注模式错误消息
 * @reserved 预留的错误消息映射，供专注模式错误处理使用
 */
export const FocusErrorMessages: Record<FocusErrorCode, string> = {
  [FocusErrorCodes.QUOTA_EXCEEDED]: '今日转写次数已达上限',
  [FocusErrorCodes.TRANSCRIBE_FAILED]: '语音转写失败，请重试',
  [FocusErrorCodes.RECORDING_NOT_SUPPORTED]: '当前浏览器不支持录音功能',
  [FocusErrorCodes.RECORDING_PERMISSION_DENIED]: '请允许麦克风权限后重试',
  [FocusErrorCodes.RECORDING_TOO_SHORT]: '录音太短，请按住久一点',
  [FocusErrorCodes.RECORDING_TOO_LONG]: '录音超过最大时长限制',
  [FocusErrorCodes.NETWORK_ERROR]: '网络连接失败，已保存待重试',
  [FocusErrorCodes.ENTRY_NOT_FOUND]: '条目不存在',
  [FocusErrorCodes.SNOOZE_LIMIT_EXCEEDED]: '今日跳过次数已达上限',
  [FocusErrorCodes.SERVICE_UNAVAILABLE]: '转写服务暂不可用',
};
