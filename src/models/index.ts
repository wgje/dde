// ============================================
// NanoFlow 数据模型定义
// ============================================

/**
 * 任务状态枚举
 */
export type TaskStatus = 'active' | 'completed';

/**
 * 任务模型
 */
export interface Task {
  id: string;
  title: string;
  content: string; // Markdown 内容
  stage: number | null; // null 表示未分配阶段
  parentId: string | null;
  order: number; // 阶段内排序
  rank: number; // 基于重力的排序权重
  status: TaskStatus;
  x: number; // 流程图 X 坐标
  y: number; // 流程图 Y 坐标
  createdDate: string;
  displayId: string; // 显示 ID，如 "1", "1,a", "2,b" (动态计算，会随位置变化)
  shortId?: string; // 永久短 ID，如 "NF-A1B2" (创建时生成，永不改变)
  hasIncompleteTask?: boolean; // 是否包含未完成的待办项
}

/**
 * 连接模型（任务之间的关联）
 */
export interface Connection {
  source: string;
  target: string;
  description?: string; // 联系块描述
}

/**
 * 项目模型
 */
export interface Project {
  id: string;
  name: string;
  description: string;
  createdDate: string;
  tasks: Task[];
  connections: Connection[];
  updatedAt?: string; // 用于冲突检测
  version?: number; // 数据版本号
}

/**
 * 未完成项目模型（待办事项）
 */
export interface UnfinishedItem {
  taskId: string;
  taskDisplayId: string;
  text: string;
}

/**
 * 用户偏好设置
 */
export interface UserPreferences {
  theme: ThemeType;
  layoutDirection: 'ltr' | 'rtl';
  floatingWindowPref: 'auto' | 'fixed';
}

/**
 * 主题类型
 */
export type ThemeType = 'default' | 'ocean' | 'forest' | 'sunset' | 'lavender';

/**
 * Supabase 项目行数据结构
 */
export interface ProjectRow {
  id: string;
  owner_id: string;
  title?: string | null;
  description?: string | null;
  created_date?: string | null;
  data?: {
    tasks?: Task[];
    connections?: Connection[];
  } | null;
  updated_at?: string | null;
}

/**
 * 同步状态
 */
export interface SyncState {
  isSyncing: boolean;
  isOnline: boolean;
  offlineMode: boolean;
  sessionExpired: boolean;
  syncError: string | null;
  hasConflict: boolean;
  conflictData: { 
    local: Project; 
    remote: Project;
    projectId: string;
    remoteData?: Project;
  } | null;
}

/**
 * 撤销/重做操作类型
 */
export type UndoActionType = 
  | 'task-create'
  | 'task-delete'
  | 'task-update'
  | 'task-move'
  | 'connection-create'
  | 'connection-delete'
  | 'project-update';

/**
 * 撤销/重做操作记录
 */
export interface UndoAction {
  type: UndoActionType;
  timestamp: number;
  projectId: string;
  data: {
    before: Partial<Project>;
    after: Partial<Project>;
  };
}
