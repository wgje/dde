// ============================================
// 专注模式数据模型定义
// ============================================

/**
 * 黑匣子条目状态
 */
export type BlackBoxSyncStatus = 'pending' | 'synced' | 'conflict';

/**
 * 黑匣子条目
 * 语音转写后的文本记录，用于紧急捕捉想法
 */
export interface BlackBoxEntry {
  /** UUID - 必须由客户端 crypto.randomUUID() 生成 */
  id: string;
  /** 所属项目 ID */
  projectId: string;
  /** 所属用户 ID */
  userId: string;
  
  // 内容
  /** 转写文本内容 */
  content: string;
  
  // 时间
  /** YYYY-MM-DD 格式，用于按日分组 */
  date: string;
  /** ISO 时间戳 */
  createdAt: string;
  /** 最后更新时间戳，LWW 关键字段 */
  updatedAt: string;
  
  // 状态
  /** 是否已读 */
  isRead: boolean;
  /** 是否已完成 */
  isCompleted: boolean;
  /** 是否已归档 */
  isArchived: boolean;
  
  // 跳过/稍后提醒
  /** 跳过至该日期（YYYY-MM-DD） */
  snoozeUntil?: string;
  /** 已跳过次数 */
  snoozeCount?: number;
  
  // 软删除
  /** 软删除时间戳，null 表示未删除 */
  deletedAt: string | null;
  
  // 离线同步元数据
  /** 同步状态 */
  syncStatus?: BlackBoxSyncStatus;
  /** 本地创建时间（用于离线排序） */
  localCreatedAt?: string;
  
  // 元数据
  /** 原始音频时长（秒），转写后删除音频 */
  originalAudioDuration?: number;
}

/**
 * 按日期分组的黑匣子条目
 */
export interface BlackBoxDateGroup {
  /** YYYY-MM-DD */
  date: string;
  /** 该日期的条目列表 */
  entries: BlackBoxEntry[];
}

/**
 * 大门状态机
 */
export type GateState = 
  | 'checking'      // 检查是否有遗留条目
  | 'reviewing'     // 展示遗留条目中
  | 'completed'     // 全部处理完毕
  | 'bypassed'      // 无遗留条目，直接通过
  | 'disabled';     // 用户禁用大门功能

/**
 * 大门上下文
 */
export interface GateContext {
  /** 待处理的黑匣子条目 */
  pendingItems: BlackBoxEntry[];
  /** 当前条目索引 */
  currentIndex: number;
  /** 大门状态 */
  state: GateState;
  /** 当日已跳过次数 */
  snoozeCount: number;
}

/**
 * 专注模式用户偏好
 */
export interface FocusPreferences {
  /** 是否启用大门（默认 true） */
  gateEnabled: boolean;
  /** 是否启用聚光灯模式 */
  spotlightEnabled: boolean;
  /** 是否启用地质层 */
  strataEnabled: boolean;
  /** 是否启用黑匣子 */
  blackBoxEnabled: boolean;
  /** 每日最大跳过次数（默认 3） */
  maxSnoozePerDay: number;
}

/**
 * 默认专注模式偏好
 */
export const DEFAULT_FOCUS_PREFERENCES: FocusPreferences = {
  gateEnabled: true,
  spotlightEnabled: true,
  strataEnabled: true,
  blackBoxEnabled: true,
  maxSnoozePerDay: 3
};

/**
 * 地质层项目（整合黑匣子和任务）
 */
export interface StrataItem {
  /** 来源类型 */
  type: 'black_box' | 'task';
  /** 唯一标识符 */
  id: string;
  /** 显示标题 */
  title: string;
  /** 完成时间 */
  completedAt: string;
  /** 原始数据源（可选，用于详情展示） */
  source?: BlackBoxEntry | unknown;
}

/**
 * 地质层按日分层
 */
export interface StrataLayer {
  /** YYYY-MM-DD */
  date: string;
  /** 该日完成的项目 */
  items: StrataItem[];
  /** 透明度（0-1） */
  opacity: number;
  /** 是否折叠 */
  collapsed?: boolean;
}

/**
 * 转写使用量记录
 */
export interface TranscriptionUsage {
  /** UUID - 由 Edge Function 生成 */
  id: string;
  /** 用户 ID */
  userId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 音频秒数 */
  audioSeconds: number;
  /** 创建时间 */
  createdAt: string;
}

/**
 * 离线音频缓存条目
 */
export interface OfflineAudioCacheEntry {
  /** UUID */
  id: string;
  /** 音频 Blob */
  blob: Blob;
  /** 创建时间 */
  createdAt: string;
  /** MIME 类型 */
  mimeType: string;
  /** 所属项目 ID */
  projectId?: string;
}
