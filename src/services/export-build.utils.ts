import type { Project, Task, Connection } from '../models';
import type {
  ExternalSourceLink,
  ExternalSourceRole,
  ExternalSourceType,
} from '../app/core/external-sources/external-source.model';

// ============================================
// 导出配置
// ============================================

export const EXPORT_CONFIG = {
  /** 导出格式版本 */
  FORMAT_VERSION: '2.1',

  /** 默认文件名前缀 */
  FILENAME_PREFIX: 'nanoflow-backup',

  /** 导出文件 MIME 类型 */
  MIME_TYPE: 'application/json',

  /** 是否格式化 JSON（便于人类阅读） */
  PRETTY_PRINT: true,

  /** 缩进空格数 */
  INDENT_SPACES: 2,

  /** 是否包含附件元数据 */
  INCLUDE_ATTACHMENT_METADATA: true,

  /** 是否包含已删除项目（回收站中的任务和连接） */
  INCLUDE_DELETED_ITEMS: true,

  /** 是否移除敏感字段 */
  SANITIZE_SENSITIVE_FIELDS: true,

  /** 敏感字段列表 */
  SENSITIVE_FIELDS: ['ownerId', 'userId'] as readonly string[],

  /** 导出提醒间隔（毫秒）- 7 天 */
  REMINDER_INTERVAL: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * 导出元数据
 */
export interface ExportMetadata {
  /** 导出时间 */
  exportedAt: string;
  /** 格式版本 */
  version: string;
  /** 应用版本 */
  appVersion: string;
  /** 项目数量 */
  projectCount: number;
  /** 任务数量 */
  taskCount: number;
  /** 连接数量 */
  connectionCount: number;
  /** 附件数量 */
  attachmentCount: number;
  /** 校验和 */
  checksum: string;
  /** 导出类型 */
  exportType: 'full' | 'single-project' | 'selected';
}

/**
 * 导出数据结构
 */
export interface ExportData {
  /** 元数据 */
  metadata: ExportMetadata;
  /** 项目列表 */
  projects: ExportProject[];
}

export interface ExportExternalSourceLink {
  id: string;
  sourceType: ExternalSourceType;
  targetId: string;
  uri: string;
  label?: string;
  hpath?: string;
  role?: ExternalSourceRole;
  sortOrder: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 导出项目结构（清理后的项目）
 */
export interface ExportProject {
  id: string;
  name: string;
  description: string;
  tasks: ExportTask[];
  connections: ExportConnection[];
  createdAt?: string;
  updatedAt?: string;
  viewState?: {
    scale: number;
    positionX: number;
    positionY: number;
  };
  /** 流程图图片 URL */
  flowchartUrl?: string;
  /** 流程图缩略图 URL */
  flowchartThumbnailUrl?: string;
  /** 数据版本号 */
  version?: number;
}

/**
 * 导出任务结构
 */
export interface ExportTask {
  id: string;
  title: string;
  content: string;
  stage: number | null;
  parentId: string | null;
  order: number;
  rank: number;
  status: string;
  x: number;
  y: number;
  displayId: string;
  shortId?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  attachments?: ExportAttachment[];
  /** 标签列表 */
  tags?: string[];
  /** 优先级 */
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  /** 截止日期 */
  dueDate?: string | null;
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;
  /** 是否包含未完成待办项 */
  hasIncompleteTask?: boolean;
  /** 软删除时间戳（回收站中的任务） */
  deletedAt?: string | null;
  /** 停泊元数据（A3.11：导出时清除 contextSnapshot） */
  parkingMeta?: import('../models/parking').TaskParkingMeta | null;
  /** 任务僚机注意事项元数据 */
  attentionMeta?: import('../models').TaskAttentionMeta | null;
  /** 外部知识锚点指针（不包含 token / 正文缓存） */
  externalSourceLinks?: ExportExternalSourceLink[];
}

/**
 * 导出连接结构
 */
export interface ExportConnection {
  id: string;
  source: string;
  target: string;
  title?: string;
  description?: string;
  /** LWW 同步时间戳；灾备/恢复必须保留，避免连接恢复后失去冲突判定依据 */
  updatedAt?: string;
  /** 软删除时间戳（回收站中的连接） */
  deletedAt?: string | null;
}

/**
 * 导出附件元数据
 */
export interface ExportAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** 附件 URL（注意：Signed URL 可能过期） */
  url?: string;
  createdAt?: string;
  /** 附件类型 */
  type?: 'image' | 'document' | 'link' | 'file';
  /** 缩略图 URL（图片类型） */
  thumbnailUrl?: string;
}

/**
 * 导出结果
 */
export interface ExportResult {
  success: boolean;
  error?: string;
  blob?: Blob;
  filename?: string;
  metadata?: ExportMetadata;
  /** 导出耗时（毫秒） */
  durationMs?: number;
}

export interface ExportStats {
  taskCount: number;
  connectionCount: number;
  attachmentCount: number;
}

/**
 * 导出进度
 */
export interface ExportProgress {
  /** 当前阶段 */
  stage: 'preparing' | 'processing' | 'generating' | 'complete';
  /** 进度百分比 (0-100) */
  percentage: number;
  /** 当前处理项 */
  currentItem?: string;
}

export function collectExportStats(projects: Project[]): ExportStats {
  return projects.reduce<ExportStats>(
    (stats, project) => ({
      taskCount: stats.taskCount + (project.tasks?.length ?? 0),
      connectionCount: stats.connectionCount + (project.connections?.length ?? 0),
      attachmentCount: stats.attachmentCount + countProjectAttachments(project),
    }),
    { taskCount: 0, connectionCount: 0, attachmentCount: 0 },
  );
}

export function sanitizeProjectForExport(
  project: Project,
  activeLinksForTask: (taskId: string) => ExternalSourceLink[],
): ExportProject {
  const taskFilter = EXPORT_CONFIG.INCLUDE_DELETED_ITEMS
    ? () => true
    : (task: Task) => !task.deletedAt;
  const connectionFilter = EXPORT_CONFIG.INCLUDE_DELETED_ITEMS
    ? () => true
    : (connection: Connection) => !connection.deletedAt;

  return {
    id: project.id,
    name: project.name,
    description: project.description ?? '',
    tasks: (project.tasks ?? [])
      .filter(taskFilter)
      .map(task => sanitizeTaskForExport(task, activeLinksForTask)),
    connections: (project.connections ?? [])
      .filter(connectionFilter)
      .map(sanitizeConnectionForExport),
    createdAt: project.createdDate,
    updatedAt: project.updatedAt,
    viewState: project.viewState,
    flowchartUrl: project.flowchartUrl,
    flowchartThumbnailUrl: project.flowchartThumbnailUrl,
    version: project.version,
  };
}

export function buildExportData(
  projectCount: number,
  exportProjects: ExportProject[],
  stats: ExportStats,
  exportType: ExportMetadata['exportType'],
  exportedAt = new Date().toISOString(),
): ExportData {
  return {
    metadata: {
      exportedAt,
      version: EXPORT_CONFIG.FORMAT_VERSION,
      appVersion: '1.0.0',
      projectCount,
      taskCount: stats.taskCount,
      connectionCount: stats.connectionCount,
      attachmentCount: stats.attachmentCount,
      checksum: '',
      exportType,
    },
    projects: exportProjects,
  };
}

export function createExportBlobResult(
  exportData: ExportData,
  filename: string,
  startTime: number,
  now = Date.now(),
): ExportResult {
  return {
    success: true,
    blob: new Blob([stringifyExportData(exportData)], { type: EXPORT_CONFIG.MIME_TYPE }),
    filename,
    metadata: exportData.metadata,
    durationMs: now - startTime,
  };
}

export function generateExportFilename(
  exportType: ExportMetadata['exportType'],
  date = new Date(),
): string {
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = date.toISOString().slice(11, 19).replace(/:/g, '');
  const typeSuffix = exportType === 'single-project'
    ? '-project'
    : exportType === 'selected'
      ? '-selected'
      : '';

  return `${EXPORT_CONFIG.FILENAME_PREFIX}${typeSuffix}-${dateStr}-${timeStr}.json`;
}

function countProjectAttachments(project: Project): number {
  return (project.tasks ?? []).reduce(
    (count, task) => count + (task.attachments?.length ?? 0),
    0,
  );
}

function sanitizeTaskForExport(
  task: Task,
  activeLinksForTask: (taskId: string) => ExternalSourceLink[],
): ExportTask {
  const exportTask: ExportTask = {
    id: task.id,
    title: task.title,
    content: task.content ?? '',
    stage: task.stage,
    parentId: task.parentId,
    order: task.order ?? 0,
    rank: task.rank ?? 10000,
    status: task.status ?? 'active',
    x: task.x ?? 0,
    y: task.y ?? 0,
    displayId: task.displayId ?? '',
    shortId: task.shortId,
    createdAt: task.createdDate,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
    tags: task.tags,
    priority: task.priority,
    dueDate: task.dueDate,
    expected_minutes: task.expected_minutes ?? null,
    cognitive_load: task.cognitive_load ?? null,
    wait_minutes: task.wait_minutes ?? null,
    hasIncompleteTask: task.hasIncompleteTask,
    deletedAt: task.deletedAt,
    parkingMeta: task.parkingMeta ? {
      ...task.parkingMeta,
      contextSnapshot: null,
    } : null,
    attentionMeta: task.attentionMeta ?? null,
    externalSourceLinks: exportExternalSourceLinks(task.id, activeLinksForTask),
  };

  if (EXPORT_CONFIG.INCLUDE_ATTACHMENT_METADATA && task.attachments?.length) {
    exportTask.attachments = task.attachments
      .filter(attachment => !attachment.deletedAt)
      .map(sanitizeAttachmentForExport);
  }

  return exportTask;
}

function sanitizeAttachmentForExport(
  attachment: NonNullable<Task['attachments']>[number],
): ExportAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size ?? 0,
    mimeType: attachment.mimeType ?? 'application/octet-stream',
    url: attachment.url,
    createdAt: attachment.createdAt,
    type: attachment.type,
    thumbnailUrl: attachment.thumbnailUrl,
  };
}

function exportExternalSourceLinks(
  taskId: string,
  activeLinksForTask: (taskId: string) => ExternalSourceLink[],
): ExportExternalSourceLink[] | undefined {
  const links = activeLinksForTask(taskId);
  if (links.length === 0) return undefined;
  return links.map(toExportExternalSourceLink);
}

function toExportExternalSourceLink(link: ExternalSourceLink): ExportExternalSourceLink {
  return {
    id: link.id,
    sourceType: link.sourceType,
    targetId: link.targetId,
    uri: link.uri,
    label: link.label,
    hpath: link.hpath,
    role: link.role,
    sortOrder: link.sortOrder,
    deletedAt: link.deletedAt,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

function sanitizeConnectionForExport(connection: Connection): ExportConnection {
  return {
    id: connection.id,
    source: connection.source,
    target: connection.target,
    title: connection.title,
    description: connection.description,
    updatedAt: connection.updatedAt,
    deletedAt: connection.deletedAt,
  };
}

function stringifyExportData(exportData: ExportData): string {
  return EXPORT_CONFIG.PRETTY_PRINT
    ? JSON.stringify(exportData, null, EXPORT_CONFIG.INDENT_SPACES)
    : JSON.stringify(exportData);
}
