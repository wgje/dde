/**
 * 核心业务类型定义
 * 
 * 这个文件包含最基础的类型定义，不依赖任何其他模型文件。
 * 其他模型文件可以从这里导入基础类型，避免循环依赖。
 */

/**
 * 任务状态枚举
 * - active: 活动状态，正在进行中
 * - completed: 已完成
 * - archived: 已归档，不显示在主视图中但仍可搜索和恢复
 */
export type TaskStatus = 'active' | 'completed' | 'archived';

/**
 * 附件类型
 */
export type AttachmentType = 'image' | 'document' | 'link' | 'file';

/**
 * 附件模型
 */
export interface Attachment {
  id: string;
  type: AttachmentType;
  name: string;
  url: string;
  thumbnailUrl?: string;
  mimeType?: string;
  size?: number;
  createdAt: string;
  signedAt?: string;
}

/**
 * 连接模型（任务之间的关联）
 */
export interface Connection {
  id: string;
  source: string;
  target: string;
  title?: string;
  description?: string;
  deletedAt?: string | null;
}

/**
 * 任务模型
 */
export interface Task {
  id: string;
  title: string;
  content: string;
  stage: number | null;
  parentId: string | null;
  order: number;
  rank: number;
  status: TaskStatus;
  x: number;
  y: number;
  createdDate: string;
  updatedAt?: string;
  displayId: string;
  shortId?: string;
  hasIncompleteTask?: boolean;
  deletedAt?: string | null;
  deletedConnections?: Connection[];
  deletedMeta?: {
    parentId: string | null;
    stage: number | null;
    order: number;
    rank: number;
    x: number;
    y: number;
  };
  attachments?: Attachment[];
  tags?: string[];
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  dueDate?: string | null;
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
  updatedAt?: string;
  version?: number;
  viewState?: ViewState;
  flowchartUrl?: string;
  flowchartThumbnailUrl?: string;
}

/**
 * 视图状态（用于持久化流程图视口位置）
 */
export interface ViewState {
  scale?: number;
  position?: { x: number; y: number };
}
