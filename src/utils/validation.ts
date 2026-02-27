import { Attachment, AttachmentType, Connection, Project, Task, TaskStatus } from '../models';
import { ATTACHMENT_CONFIG } from '../config/attachment.config';
import { nowISO } from './date';
import { utilLogger } from './standalone-logger';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUUID(str: string): boolean {
  return UUID_REGEX.test(str);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const ALLOWED_MIME_TYPES: Record<AttachmentType, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
  ],
  link: [],
  file: [],
};

const MAX_ATTACHMENT_SIZE = ATTACHMENT_CONFIG.MAX_FILE_SIZE;
const MAX_ATTACHMENTS_PER_TASK = ATTACHMENT_CONFIG.MAX_ATTACHMENTS_PER_TASK;

export function validateAttachment(attachment: Partial<Attachment>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!attachment.id || typeof attachment.id !== 'string') {
    errors.push('附件 ID 无效或缺失');
  }

  if (!attachment.name || typeof attachment.name !== 'string') {
    errors.push('附件名称无效或缺失');
  } else if (attachment.name.length > 255) {
    errors.push('附件名称过长（最多 255 字符）');
  }

  if (!attachment.url || typeof attachment.url !== 'string') {
    errors.push('附件 URL 无效或缺失');
  } else {
    try {
      new URL(attachment.url);
    } catch {
      if (!attachment.url.startsWith('/') && !attachment.url.startsWith('storage/')) {
        warnings.push('附件 URL 格式可能无效');
      }
    }
  }

  const validTypes: AttachmentType[] = ['image', 'document', 'link', 'file'];
  if (!attachment.type || !validTypes.includes(attachment.type)) {
    errors.push(`附件类型无效: ${String(attachment.type)}`);
  }

  if (attachment.type && attachment.mimeType) {
    const allowed = ALLOWED_MIME_TYPES[attachment.type];
    if (allowed.length > 0 && !allowed.includes(attachment.mimeType)) {
      warnings.push(`附件 MIME 类型 ${attachment.mimeType} 可能不受支持`);
    }
  }

  if (attachment.size !== undefined) {
    if (typeof attachment.size !== 'number' || attachment.size < 0) {
      errors.push('附件大小无效');
    } else if (attachment.size > MAX_ATTACHMENT_SIZE) {
      errors.push(`附件过大: ${(attachment.size / 1024 / 1024).toFixed(2)}MB（最多 10MB）`);
    }
  }

  if (!attachment.createdAt || typeof attachment.createdAt !== 'string') {
    warnings.push('附件缺少创建时间');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateTask(task: Partial<Task>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!task.id || typeof task.id !== 'string') {
    errors.push('任务 ID 无效或缺失');
  }

  if (task.title !== undefined && typeof task.title !== 'string') {
    errors.push('任务标题必须是字符串');
  }

  if (task.rank !== undefined) {
    if (typeof task.rank !== 'number' || !Number.isFinite(task.rank)) {
      errors.push(`任务 ${task.id} 的 rank 无效: ${String(task.rank)}`);
    } else if (task.rank < 0) {
      warnings.push(`任务 ${task.id} 的 rank 为负数`);
    } else if (task.rank > 1_000_000_000) {
      warnings.push(`任务 ${task.id} 的 rank 过大`);
    }
  }

  if (task.stage !== undefined && task.stage !== null) {
    if (typeof task.stage !== 'number' || task.stage < 1) {
      errors.push(`任务 ${task.id} 的 stage 无效: ${String(task.stage)}`);
    }
  }

  if (task.status !== undefined) {
    const validStatuses: TaskStatus[] = ['active', 'completed', 'archived'];
    if (!validStatuses.includes(task.status)) {
      errors.push(`任务 ${task.id} 的状态无效: ${String(task.status)}`);
    }
  }

  if (task.x !== undefined && (typeof task.x !== 'number' || !Number.isFinite(task.x))) {
    warnings.push(`任务 ${task.id} 的 X 坐标无效`);
  }
  if (task.y !== undefined && (typeof task.y !== 'number' || !Number.isFinite(task.y))) {
    warnings.push(`任务 ${task.id} 的 Y 坐标无效`);
  }

  if (task.attachments !== undefined) {
    if (!Array.isArray(task.attachments)) {
      errors.push(`任务 ${task.id} 的附件列表必须是数组`);
    } else {
      if (task.attachments.length > MAX_ATTACHMENTS_PER_TASK) {
        errors.push(`任务 ${task.id} 附件数量超限（最多 ${MAX_ATTACHMENTS_PER_TASK} 个）`);
      }

      for (let index = 0; index < task.attachments.length; index += 1) {
        const result = validateAttachment(task.attachments[index]);
        errors.push(...result.errors.map(error => `附件[${index}]: ${error}`));
        warnings.push(...result.warnings.map(warning => `附件[${index}]: ${warning}`));
      }

      const attachmentIds = new Set<string>();
      for (const attachment of task.attachments) {
        if (attachment.id && attachmentIds.has(attachment.id)) {
          errors.push(`任务 ${task.id} 存在重复的附件 ID: ${attachment.id}`);
        }
        if (attachment.id) attachmentIds.add(attachment.id);
      }
    }
  }

  if (task.tags !== undefined) {
    if (!Array.isArray(task.tags)) {
      errors.push(`任务 ${task.id} 的标签列表必须是数组`);
    } else {
      for (const tag of task.tags) {
        if (typeof tag !== 'string' || tag.length === 0) {
          errors.push(`任务 ${task.id} 包含无效标签`);
        }
      }
    }
  }

  if (task.priority !== undefined) {
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (!validPriorities.includes(task.priority)) {
      errors.push(`任务 ${task.id} 的优先级无效: ${String(task.priority)}`);
    }
  }

  if (task.dueDate !== undefined && task.dueDate !== null) {
    if (typeof task.dueDate !== 'string') {
      errors.push(`任务 ${task.id} 的截止日期格式无效`);
    } else if (Number.isNaN(new Date(task.dueDate).getTime())) {
      errors.push(`任务 ${task.id} 的截止日期无法解析`);
    }
  }

  if (task.expected_minutes !== undefined && task.expected_minutes !== null) {
    if (
      typeof task.expected_minutes !== 'number' ||
      !Number.isFinite(task.expected_minutes) ||
      task.expected_minutes <= 0
    ) {
      errors.push(`任务 ${task.id} 的预计时长无效`);
    }
  }

  if (task.cognitive_load !== undefined && task.cognitive_load !== null) {
    if (task.cognitive_load !== 'high' && task.cognitive_load !== 'low') {
      errors.push(`任务 ${task.id} 的认知负荷无效`);
    }
  }

  if (task.wait_minutes !== undefined && task.wait_minutes !== null) {
    if (
      typeof task.wait_minutes !== 'number' ||
      !Number.isFinite(task.wait_minutes) ||
      task.wait_minutes <= 0
    ) {
      errors.push(`任务 ${task.id} 的等待时长无效`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateConnection(conn: Connection, taskIds: Set<string>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!conn.source || typeof conn.source !== 'string') {
    errors.push('连接源 ID 无效');
  } else if (!taskIds.has(conn.source)) {
    errors.push(`连接源任务不存在: ${conn.source}`);
  }

  if (!conn.target || typeof conn.target !== 'string') {
    errors.push('连接目标 ID 无效');
  } else if (!taskIds.has(conn.target)) {
    errors.push(`连接目标任务不存在: ${conn.target}`);
  }

  if (conn.source === conn.target) {
    errors.push('连接不能指向自身');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateProject(project: Partial<Project>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!project.id || typeof project.id !== 'string') {
    errors.push('项目 ID 无效或缺失');
  }

  if (!project.name || typeof project.name !== 'string') {
    warnings.push('项目名称缺失');
  }

  if (!Array.isArray(project.tasks)) {
    errors.push('项目任务列表必须是数组');
  } else {
    const taskIds = new Set(project.tasks.map(task => task.id));

    if (taskIds.size !== project.tasks.length) {
      errors.push('存在重复的任务 ID');
    }

    for (const task of project.tasks) {
      const result = validateTask(task);
      errors.push(...result.errors);
      warnings.push(...result.warnings);

      if (task.parentId && !taskIds.has(task.parentId)) {
        errors.push(`任务 ${task.id} 的父任务不存在: ${task.parentId}`);
      }
    }

    if (project.connections === undefined || project.connections === null) {
      warnings.push('项目连接列表缺失，已初始化为空数组');
    } else if (!Array.isArray(project.connections)) {
      errors.push('项目连接列表必须是数组');
    } else {
      for (const connection of project.connections) {
        const result = validateConnection(connection, taskIds);
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      }
    }
  }

  if (project.version !== undefined && typeof project.version !== 'number') {
    warnings.push('项目版本号应为数字');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function sanitizeAttachment(attachment: unknown): Attachment {
  const raw = attachment as Record<string, unknown>;
  const validTypes: AttachmentType[] = ['image', 'document', 'link', 'file'];
  const type = validTypes.includes(raw.type as AttachmentType) ? (raw.type as AttachmentType) : 'file';

  const allowedProtocols = ['https:', 'http:', 'blob:'];
  const sanitizeUrl = (value: unknown): string => {
    const url = String(value || '');
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if (!allowedProtocols.includes(parsed.protocol)) return '';
    } catch {
      if (url.startsWith('javascript:') || url.startsWith('data:text/html') || url.startsWith('//')) return '';
    }
    return url;
  };

  return {
    id: String(raw.id || crypto.randomUUID()),
    type,
    name: String(raw.name || '未命名附件'),
    url: sanitizeUrl(raw.url),
    thumbnailUrl: typeof raw.thumbnailUrl === 'string' ? sanitizeUrl(raw.thumbnailUrl) : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
    size: typeof raw.size === 'number' && raw.size >= 0 ? raw.size : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowISO(),
  };
}

export function sanitizeTask(rawTask: unknown): Task {
  const task = rawTask as Record<string, unknown>;
  const fixes: string[] = [];

  const attachments = Array.isArray(task.attachments)
    ? task.attachments.slice(0, MAX_ATTACHMENTS_PER_TASK).map(sanitizeAttachment)
    : undefined;

  const tags = Array.isArray(task.tags)
    ? (task.tags as unknown[])
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;

  const validPriorities = ['low', 'medium', 'high', 'urgent'] as const;
  const rawPriority = task.priority as string | undefined;
  const priority =
    rawPriority && validPriorities.includes(rawPriority as 'low' | 'medium' | 'high' | 'urgent')
      ? (rawPriority as 'low' | 'medium' | 'high' | 'urgent')
      : undefined;

  let dueDate: string | null | undefined = undefined;
  if (task.dueDate === null) {
    dueDate = null;
  } else if (typeof task.dueDate === 'string' && !Number.isNaN(new Date(task.dueDate).getTime())) {
    dueDate = task.dueDate;
  }

  const expectedMinutes =
    typeof task.expected_minutes === 'number' && Number.isFinite(task.expected_minutes) && task.expected_minutes > 0
      ? Math.floor(task.expected_minutes)
      : null;

  const cognitiveLoad = task.cognitive_load === 'high' || task.cognitive_load === 'low'
    ? task.cognitive_load
    : null;

  const waitMinutes =
    typeof task.wait_minutes === 'number' && Number.isFinite(task.wait_minutes) && task.wait_minutes > 0
      ? Math.floor(task.wait_minutes)
      : null;

  if (!task.id) fixes.push('id');
  if (!task.title || typeof task.title !== 'string') fixes.push('title');
  if (typeof task.rank !== 'number' || !Number.isFinite(task.rank)) fixes.push('rank');
  if (typeof task.order !== 'number' || !Number.isFinite(task.order)) fixes.push('order');
  if (!task.status || !['active', 'completed', 'archived'].includes(String(task.status))) fixes.push('status');
  if (typeof task.x !== 'number' || !Number.isFinite(task.x)) fixes.push('x');
  if (typeof task.y !== 'number' || !Number.isFinite(task.y)) fixes.push('y');

  const isNgDevMode = Boolean((globalThis as { ngDevMode?: boolean }).ngDevMode);
  if (isNgDevMode && fixes.length > 0) {
    utilLogger.warn(`sanitizeTask: 任务 ${String(task.id || 'unknown')} 修复字段: ${fixes.join(', ')}`);
  }

  return {
    id: String(task.id || crypto.randomUUID()),
    title: String(task.title || '未命名任务'),
    content: String(task.content || ''),
    stage: typeof task.stage === 'number' ? task.stage : null,
    parentId: typeof task.parentId === 'string' ? task.parentId : null,
    order: typeof task.order === 'number' && Number.isFinite(task.order) ? task.order : 0,
    rank: typeof task.rank === 'number' && Number.isFinite(task.rank) ? task.rank : 10000,
    status: task.status === 'completed' ? 'completed' : task.status === 'archived' ? 'archived' : 'active',
    x: typeof task.x === 'number' && Number.isFinite(task.x) ? task.x : 0,
    y: typeof task.y === 'number' && Number.isFinite(task.y) ? task.y : 0,
    createdDate: typeof task.createdDate === 'string' ? task.createdDate : nowISO(),
    displayId: String(task.displayId || '?'),
    shortId: typeof task.shortId === 'string' ? task.shortId : undefined,
    hasIncompleteTask: Boolean(task.hasIncompleteTask),
    deletedAt: typeof task.deletedAt === 'string' ? task.deletedAt : null,
    attachments,
    tags,
    priority,
    dueDate,
    expected_minutes: expectedMinutes,
    cognitive_load: cognitiveLoad,
    wait_minutes: waitMinutes,
    parkingMeta: (task.parkingMeta as import('../models/parking').TaskParkingMeta | undefined) ?? undefined,
  };
}

export function sanitizeProject(rawProject: unknown): Project {
  const project = rawProject as Record<string, unknown>;
  const tasks = Array.isArray(project.tasks) ? (project.tasks as unknown[]).map(sanitizeTask) : [];

  const taskIds = new Set(tasks.map(task => task.id));
  const fixedTasks = tasks.map(task => {
    if (task.parentId && !taskIds.has(task.parentId)) return { ...task, parentId: null };
    if (task.parentId === task.id) return { ...task, parentId: null };
    return task;
  });

  const connections: Connection[] = Array.isArray(project.connections)
    ? (project.connections as unknown[])
        .filter((item): item is Record<string, unknown> => {
          const conn = item as Record<string, unknown>;
          return Boolean(conn && conn.source && conn.target);
        })
        .map(conn => ({
          id: conn.id ? String(conn.id) : crypto.randomUUID(),
          source: String(conn.source),
          target: String(conn.target),
          title: conn.title ? String(conn.title) : undefined,
          description: conn.description ? String(conn.description) : undefined,
          updatedAt: typeof conn.updatedAt === 'string' ? conn.updatedAt : undefined,
          deletedAt: conn.deletedAt ? String(conn.deletedAt) : undefined,
        }))
        .filter(conn => taskIds.has(conn.source) && taskIds.has(conn.target) && conn.source !== conn.target)
    : [];

  const rawViewState = project.viewState as Record<string, unknown> | undefined;
  const hasValidViewState =
    rawViewState &&
    typeof rawViewState.scale === 'number' && Number.isFinite(rawViewState.scale) &&
    typeof rawViewState.positionX === 'number' && Number.isFinite(rawViewState.positionX) &&
    typeof rawViewState.positionY === 'number' && Number.isFinite(rawViewState.positionY);

  const viewState = hasValidViewState
    ? {
        scale: Number(rawViewState.scale),
        positionX: Number(rawViewState.positionX),
        positionY: Number(rawViewState.positionY),
      }
    : undefined;

  return {
    id: String(project.id || crypto.randomUUID()),
    name: String(project.name || '未命名项目'),
    description: String(project.description || ''),
    createdDate: typeof project.createdDate === 'string' ? project.createdDate : nowISO(),
    tasks: fixedTasks,
    connections,
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : nowISO(),
    version: typeof project.version === 'number' ? project.version : 0,
    viewState,
    flowchartUrl: typeof project.flowchartUrl === 'string' ? project.flowchartUrl : undefined,
    flowchartThumbnailUrl:
      typeof project.flowchartThumbnailUrl === 'string' ? project.flowchartThumbnailUrl : undefined,
  };
}

export function detectCycles(tasks: Task[]): { hasCycle: boolean; cycleNodes: string[] } {
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const cycleNodes: string[] = [];

  for (const task of tasks) {
    if (!task.parentId) continue;

    const visited = new Set<string>();
    let current: string | null = task.parentId;

    while (current) {
      if (current === task.id) {
        cycleNodes.push(task.id);
        break;
      }
      if (visited.has(current)) break;
      visited.add(current);
      const parent = taskMap.get(current);
      current = parent?.parentId || null;
    }
  }

  return {
    hasCycle: cycleNodes.length > 0,
    cycleNodes,
  };
}

export function detectOrphans(tasks: Task[]): string[] {
  const taskIds = new Set(tasks.map(task => task.id));
  const orphans: string[] = [];

  for (const task of tasks) {
    if (task.parentId && !taskIds.has(task.parentId)) {
      orphans.push(task.id);
    }
  }

  return orphans;
}
