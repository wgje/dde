import {
  Attachment,
  AttachmentType,
  Connection,
  Project,
  Task,
  TaskAttentionItem,
  TaskAttentionLevel,
  TaskAttentionMeta,
  TaskStatus,
} from '../models';
import { ATTACHMENT_CONFIG } from '../config/attachment.config';
import { AttachmentScanMetadata, SCAN_STATUS, ScanStatus } from '../config/virus-scan.config';
import { TASK_PRIORITY_LIST } from '../config/task.config';
import { nowISO } from './date';
import { sanitizePlannerFields } from './planner-fields';
import { sanitizeParkingMeta } from './parking-meta-sanitizer';
import { utilLogger } from './standalone-logger';
import { resolveTaskCompletionTimestamp } from './task-completion-time';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTACHMENT_SIZE = ATTACHMENT_CONFIG.MAX_FILE_SIZE;
const MAX_ATTACHMENTS_PER_TASK = ATTACHMENT_CONFIG.MAX_ATTACHMENTS_PER_TASK;

/** M-2: 模块级 URL 清洗函数，用于所有 URL 类型字段 */
const URL_ALLOWED_PROTOCOLS = ['https:', 'http:', 'blob:'];
/** 危险协议黑名单：阻止 XSS 注入向量 */
const URL_DANGEROUS_PROTOCOLS = /^(javascript|data|vbscript):/i;
function sanitizeUrlValue(value: unknown): string {
  const url = String(value || '');
  if (!url) return '';
  // 先行拦截危险协议（XSS 防护）
  if (URL_DANGEROUS_PROTOCOLS.test(url.trim())) return '';
  try {
    const parsed = new URL(url);
    if (!URL_ALLOWED_PROTOCOLS.includes(parsed.protocol)) return '';
  } catch {
    // 非标准 URL（相对路径等）：只放行安全前缀，阻止路径穿越
    if (!/^https?:\/\/|^blob:https?:|^\/(?!\/)|^storage\//.test(url)) return '';
    if (url.includes('..')) return '';
  }
  return url;
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

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface ValidationAccumulator {
  errors: string[];
  warnings: string[];
}

function toValidationResult({ errors, warnings }: ValidationAccumulator): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export function isValidUUID(str: string): boolean {
  return UUID_REGEX.test(str);
}

function isAttachmentType(value: unknown): value is AttachmentType {
  return value === 'image' || value === 'document' || value === 'link' || value === 'file';
}

function isScanStatus(value: unknown): value is ScanStatus {
  return Object.values(SCAN_STATUS).includes(value as ScanStatus);
}

function validateAttachmentIdentity(attachment: Partial<Attachment>, errors: string[]): void {
  if (!attachment.id || typeof attachment.id !== 'string') {
    errors.push('附件 ID 无效或缺失');
  }

  if (!attachment.name || typeof attachment.name !== 'string') {
    errors.push('附件名称无效或缺失');
  } else if (attachment.name.length > 255) {
    errors.push('附件名称过长（最大 255 字符）');
  }
}

function validateAttachmentUrl(attachment: Partial<Attachment>, errors: string[], warnings: string[]): void {
  if (!attachment.url || typeof attachment.url !== 'string') {
    errors.push('附件 URL 无效或缺失');
    return;
  }

  try {
    new URL(attachment.url);
  } catch {
    if (!attachment.url.startsWith('/') && !attachment.url.startsWith('storage/')) {
      warnings.push('附件 URL 格式可能无效');
    }
  }
}

function validateAttachmentTypeAndMime(attachment: Partial<Attachment>, errors: string[], warnings: string[]): void {
  if (!isAttachmentType(attachment.type)) {
    errors.push(`附件类型无效: ${String(attachment.type)}`);
    return;
  }

  if (!attachment.mimeType) {
    return;
  }

  const allowed = ALLOWED_MIME_TYPES[attachment.type];
  if (allowed.length > 0 && !allowed.includes(attachment.mimeType)) {
    warnings.push(`附件 MIME 类型 ${attachment.mimeType} 可能不受支持`);
  }
}

function validateAttachmentSize(attachment: Partial<Attachment>, errors: string[]): void {
  if (attachment.size === undefined) {
    return;
  }

  if (typeof attachment.size !== 'number' || attachment.size < 0) {
    errors.push('附件大小无效');
  } else if (attachment.size > MAX_ATTACHMENT_SIZE) {
    errors.push(`附件过大: ${(attachment.size / 1024 / 1024).toFixed(2)}MB（最大 10MB）`);
  }
}

export function validateAttachment(attachment: Partial<Attachment>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  validateAttachmentIdentity(attachment, errors);
  validateAttachmentUrl(attachment, errors, warnings);
  validateAttachmentTypeAndMime(attachment, errors, warnings);
  validateAttachmentSize(attachment, errors);

  if (!attachment.createdAt || typeof attachment.createdAt !== 'string') {
    warnings.push('附件缺少创建时间');
  }

  return toValidationResult({ errors, warnings });
}

function validateTaskIdentity(task: Partial<Task>, errors: string[]): void {
  if (!task.id || typeof task.id !== 'string') {
    errors.push('任务 ID 无效或缺失');
  }

  if (task.title !== undefined && typeof task.title !== 'string') {
    errors.push('任务标题必须是字符串');
  }
}

function validateTaskRankAndStage(task: Partial<Task>, errors: string[], warnings: string[]): void {
  if (task.rank !== undefined) {
    if (typeof task.rank !== 'number' || !Number.isFinite(task.rank)) {
      errors.push(`任务 ${task.id} 的 rank 无效: ${String(task.rank)}`);
    } else if (task.rank < 0) {
      warnings.push(`任务 ${task.id} 的 rank 为负数`);
    } else if (task.rank > 1_000_000_000) {
      warnings.push(`任务 ${task.id} 的 rank 过大`);
    }
  }

  if (task.stage !== undefined && task.stage !== null && (typeof task.stage !== 'number' || task.stage < 1)) {
    errors.push(`任务 ${task.id} 的 stage 无效: ${String(task.stage)}`);
  }
}

function validateTaskStatusAndPosition(task: Partial<Task>, errors: string[], warnings: string[]): void {
  const validStatuses: TaskStatus[] = ['active', 'completed', 'archived'];

  if (task.status !== undefined && !validStatuses.includes(task.status)) {
    errors.push(`任务 ${task.id} 的状态无效: ${String(task.status)}`);
  }

  if (task.x !== undefined && (typeof task.x !== 'number' || !Number.isFinite(task.x))) {
    warnings.push(`任务 ${task.id} 的 X 坐标无效`);
  }

  if (task.y !== undefined && (typeof task.y !== 'number' || !Number.isFinite(task.y))) {
    warnings.push(`任务 ${task.id} 的 Y 坐标无效`);
  }
}

function validateTaskStringFields(task: Partial<Task>, errors: string[], warnings: string[]): void {
  if (task.parentId !== undefined && task.parentId !== null && typeof task.parentId !== 'string') {
    errors.push(`任务 ${task.id} 的 parentId 无效`);
  }

  if (task.createdDate !== undefined && typeof task.createdDate !== 'string') {
    warnings.push(`任务 ${task.id} 的 createdDate 无效`);
  }

  if (task.updatedAt !== undefined && task.updatedAt !== null && typeof task.updatedAt !== 'string') {
    warnings.push(`任务 ${task.id} 的 updatedAt 无效`);
  }

  if (task.deletedAt !== undefined && task.deletedAt !== null && typeof task.deletedAt !== 'string') {
    warnings.push(`任务 ${task.id} 的 deletedAt 无效`);
  }

  if (task.shortId !== undefined && task.shortId !== null && typeof task.shortId !== 'string') {
    warnings.push(`任务 ${task.id} 的 shortId 无效`);
  }
}

function validateTaskCollections(task: Partial<Task>, errors: string[], warnings: string[]): void {
  if (task.attachments !== undefined) {
    if (!Array.isArray(task.attachments)) {
      errors.push(`任务 ${task.id} 的 attachments 必须为数组`);
    } else {
      for (const attachment of task.attachments) {
        const result = validateAttachment(attachment);
        errors.push(...result.errors);
        warnings.push(...result.warnings);
      }
    }
  }

  if (task.tags !== undefined) {
    if (!Array.isArray(task.tags)) {
      errors.push(`任务 ${task.id} 的 tags 必须为数组`);
    } else {
      for (const tag of task.tags) {
        if (typeof tag !== 'string' || tag.length === 0) {
          errors.push(`任务 ${task.id} 包含无效标签`);
        }
      }
    }
  }
}

function validateTaskPriorityAndDueDate(task: Partial<Task>, errors: string[]): void {
  if (task.priority !== undefined && !TASK_PRIORITY_LIST.includes(task.priority)) {
    errors.push(`任务 ${task.id} 的优先级无效: ${String(task.priority)}`);
  }

  if (task.dueDate !== undefined && task.dueDate !== null) {
    if (typeof task.dueDate !== 'string') {
      errors.push(`任务 ${task.id} 的截止日期格式无效`);
    } else if (Number.isNaN(new Date(task.dueDate).getTime())) {
      errors.push(`任务 ${task.id} 的截止日期无法解析`);
    }
  }
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validateTaskPlannerFields(task: Partial<Task>, errors: string[]): void {
  if (task.expected_minutes !== undefined && task.expected_minutes !== null && !isPositiveFiniteNumber(task.expected_minutes)) {
    errors.push(`任务 ${task.id} 的预计时长无效`);
  }

  if (task.cognitive_load !== undefined && task.cognitive_load !== null) {
    if (task.cognitive_load !== 'high' && task.cognitive_load !== 'low') {
      errors.push(`任务 ${task.id} 的认知负荷无效`);
    }
  }

  if (task.wait_minutes !== undefined && task.wait_minutes !== null && !isPositiveFiniteNumber(task.wait_minutes)) {
    errors.push(`任务 ${task.id} 的等待时长无效`);
  }

  if (
    typeof task.expected_minutes === 'number' &&
    Number.isFinite(task.expected_minutes) &&
    typeof task.wait_minutes === 'number' &&
    Number.isFinite(task.wait_minutes) &&
    task.wait_minutes > task.expected_minutes
  ) {
    errors.push(`任务 ${task.id} 的等待时长不能超过预计时长`);
  }
}

export function validateTask(task: Partial<Task>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  validateTaskIdentity(task, errors);
  validateTaskRankAndStage(task, errors, warnings);
  validateTaskStatusAndPosition(task, errors, warnings);
  validateTaskStringFields(task, errors, warnings);
  validateTaskCollections(task, errors, warnings);
  validateTaskPriorityAndDueDate(task, errors);
  validateTaskPlannerFields(task, errors);

  return toValidationResult({ errors, warnings });
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
      warnings.push('项目连接列表缺失，已视为无连接');
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
  const type = isAttachmentType(raw.type) ? raw.type : 'file';

  const _allowedProtocols = ['https:', 'http:', 'blob:'];
  const sanitizeUrl = (value: unknown): string => sanitizeUrlValue(value);
  const sanitized: Attachment = {
    id: String(raw.id || crypto.randomUUID()),
    type,
    name: String(raw.name || '未命名附件'),
    url: sanitizeUrl(raw.url),
    thumbnailUrl: typeof raw.thumbnailUrl === 'string' ? sanitizeUrl(raw.thumbnailUrl) : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
    size: typeof raw.size === 'number' && raw.size >= 0 ? raw.size : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowISO(),
    signedAt: typeof raw.signedAt === 'string' ? raw.signedAt : undefined,
    deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : undefined,
  };

  const scanMetadata = sanitizeAttachmentScanMetadata(raw.scanMetadata);
  if (scanMetadata) {
    sanitized.scanMetadata = scanMetadata;
  }

  return sanitized;
}

function sanitizeAttachmentScanMetadata(value: unknown): AttachmentScanMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadata: AttachmentScanMetadata = {};
  if (typeof value.fileId === 'string' && value.fileId.length > 0) {
    metadata.fileId = value.fileId;
  }
  if (typeof value.fileHash === 'string' && value.fileHash.length > 0) {
    metadata.fileHash = value.fileHash;
  }
  if (isScanStatus(value.scanStatus)) {
    metadata.scanStatus = value.scanStatus;
  }
  if (typeof value.lastScannedAt === 'string') {
    metadata.lastScannedAt = value.lastScannedAt;
  }
  if (isRecord(value.threat)) {
    const threat = value.threat;
    if (typeof threat.name === 'string' && typeof threat.description === 'string' && typeof threat.detectedAt === 'string') {
      metadata.threat = {
        name: threat.name,
        description: threat.description,
        detectedAt: threat.detectedAt,
      };
    }
  }
  if (Array.isArray(value.scanHistory)) {
    const scanHistory = value.scanHistory
      .filter(isRecord)
      .map(entry => sanitizeScanHistoryEntry(entry))
      .filter((entry): entry is NonNullable<AttachmentScanMetadata['scanHistory']>[number] => entry !== null)
      .slice(0, 5);
    if (scanHistory.length > 0) {
      metadata.scanHistory = scanHistory;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function sanitizeScanHistoryEntry(
  entry: Record<string, unknown>,
): NonNullable<AttachmentScanMetadata['scanHistory']>[number] | null {
  if (
    typeof entry.scannedAt !== 'string' ||
    !isScanStatus(entry.status) ||
    typeof entry.scanner !== 'string'
  ) {
    return null;
  }

  return {
    scannedAt: entry.scannedAt,
    status: entry.status,
    scanner: entry.scanner,
  };
}

function sanitizeTaskAttachments(task: Record<string, unknown>): Attachment[] | undefined {
  return Array.isArray(task.attachments)
    ? task.attachments.slice(0, MAX_ATTACHMENTS_PER_TASK).map(sanitizeAttachment)
    : undefined;
}

function sanitizeTaskTags(task: Record<string, unknown>): string[] | undefined {
  return Array.isArray(task.tags)
    ? (task.tags as unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;
}

function sanitizeTaskPriority(task: Record<string, unknown>): Task['priority'] {
  const rawPriority = task.priority as string | undefined;
  return rawPriority && TASK_PRIORITY_LIST.includes(rawPriority as (typeof TASK_PRIORITY_LIST)[number])
    ? (rawPriority as (typeof TASK_PRIORITY_LIST)[number])
    : undefined;
}

function sanitizeTaskDueDate(task: Record<string, unknown>): string | null | undefined {
  if (task.dueDate === null) {
    return null;
  }

  if (typeof task.dueDate === 'string' && !Number.isNaN(new Date(task.dueDate).getTime())) {
    return task.dueDate;
  }

  return undefined;
}

function sanitizeTaskAttentionLevel(value: unknown): TaskAttentionLevel {
  return value === 'warning' || value === 'blocker' ? value : 'info';
}

function sanitizeTaskAttentionItem(value: unknown, now: string): TaskAttentionItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (!text) {
    return null;
  }

  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : crypto.randomUUID(),
    text,
    level: sanitizeTaskAttentionLevel(value.level),
    done: typeof value.done === 'boolean' ? value.done : false,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
  };
}

function sanitizeAttentionMeta(value: unknown): TaskAttentionMeta | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }

  const now = nowISO();
  const items = value.items
    .map(item => sanitizeTaskAttentionItem(item, now))
    .filter((item): item is TaskAttentionItem => item !== null);

  if (items.length === 0) {
    return null;
  }

  return {
    items,
    pinned: typeof value.pinned === 'boolean' ? value.pinned : false,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
  };
}

function collectSanitizeTaskFixes(task: Record<string, unknown>, plannerAdjusted: boolean): string[] {
  const fixes: string[] = [];

  if (!task.id) fixes.push('id');
  if (!task.title || typeof task.title !== 'string') fixes.push('title');
  if (typeof task.rank !== 'number' || !Number.isFinite(task.rank)) fixes.push('rank');
  if (typeof task.order !== 'number' || !Number.isFinite(task.order)) fixes.push('order');
  if (!task.status || !['active', 'completed', 'archived'].includes(String(task.status))) fixes.push('status');
  if (typeof task.x !== 'number' || !Number.isFinite(task.x)) fixes.push('x');
  if (typeof task.y !== 'number' || !Number.isFinite(task.y)) fixes.push('y');
  if (plannerAdjusted) fixes.push('planner');

  return fixes;
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  if (value === 'completed') {
    return 'completed';
  }

  return value === 'archived' ? 'archived' : 'active';
}

function resolveSanitizedTaskCompletion(task: Record<string, unknown>, normalizedStatus: TaskStatus): {
  createdDate: string;
  updatedAt: string | undefined;
  completedAt: string | null;
} {
  const createdDate = typeof task.createdDate === 'string' ? task.createdDate : nowISO();
  const updatedAt = typeof task.updatedAt === 'string' ? task.updatedAt : undefined;
  const rawCompletedAt = typeof task.completedAt === 'string' ? task.completedAt : null;
  const completedAt = normalizedStatus === 'completed'
    ? resolveTaskCompletionTimestamp({ completedAt: rawCompletedAt, updatedAt, createdDate })
    : null;

  return { createdDate, updatedAt, completedAt };
}

function warnSanitizeTaskFixes(task: Record<string, unknown>, fixes: string[]): void {
  const isNgDevMode = Boolean((globalThis as { ngDevMode?: boolean }).ngDevMode);
  if (isNgDevMode && fixes.length > 0) {
    utilLogger.warn(`sanitizeTask: task ${String(task.id || 'unknown')} fixed fields: ${fixes.join(', ')}`);
  }
}

export function sanitizeTask(rawTask: unknown): Task {
  const task = rawTask as Record<string, unknown>;
  const plannerFields = sanitizePlannerFields({
    expectedMinutes: task.expected_minutes,
    waitMinutes: task.wait_minutes,
    cognitiveLoad: task.cognitive_load,
  });
  const normalizedStatus = normalizeTaskStatus(task.status);
  // 兼容 completed_at 字段上线前的本地缓存，同时避免把后续同步/修复时钟固化为完成时间。
  const { createdDate, updatedAt, completedAt } = resolveSanitizedTaskCompletion(task, normalizedStatus);

  warnSanitizeTaskFixes(task, collectSanitizeTaskFixes(task, plannerFields.adjusted));

  return {
    id: String(task.id || crypto.randomUUID()),
    title: String(task.title || '未命名任务'),
    content: String(task.content || ''),
    stage: typeof task.stage === 'number' ? task.stage : null,
    parentId: typeof task.parentId === 'string' ? task.parentId : null,
    order: typeof task.order === 'number' && Number.isFinite(task.order) ? task.order : 0,
    rank: typeof task.rank === 'number' && Number.isFinite(task.rank) ? task.rank : 10000,
    status: normalizedStatus,
    x: typeof task.x === 'number' && Number.isFinite(task.x) ? task.x : 0,
    y: typeof task.y === 'number' && Number.isFinite(task.y) ? task.y : 0,
    createdDate,
    updatedAt,
    completedAt,
    displayId: String(task.displayId || '?'),
    shortId: typeof task.shortId === 'string' ? task.shortId : undefined,
    hasIncompleteTask: Boolean(task.hasIncompleteTask),
    deletedAt: typeof task.deletedAt === 'string' ? task.deletedAt : null,
    attachments: sanitizeTaskAttachments(task),
    tags: sanitizeTaskTags(task),
    priority: sanitizeTaskPriority(task),
    dueDate: sanitizeTaskDueDate(task),
    expected_minutes: plannerFields.expectedMinutes,
    cognitive_load: plannerFields.cognitiveLoad,
    wait_minutes: plannerFields.waitMinutes,
    parkingMeta: sanitizeParkingMeta(task.parkingMeta),
    attentionMeta: sanitizeAttentionMeta(task.attentionMeta),
  };
}

function sanitizeProjectTasks(rawTasks: unknown): Task[] {
  return Array.isArray(rawTasks) ? rawTasks.map(sanitizeTask) : [];
}

function repairTaskParents(tasks: Task[]): Task[] {
  const taskIds = new Set(tasks.map(task => task.id));

  return tasks.map(task => {
    if (task.parentId && !taskIds.has(task.parentId)) return { ...task, parentId: null };
    if (task.parentId === task.id) return { ...task, parentId: null };
    return task;
  });
}

function sanitizeProjectConnections(rawConnections: unknown, taskIds: Set<string>): Connection[] {
  if (!Array.isArray(rawConnections)) {
    return [];
  }

  return rawConnections
    .filter(isRecord)
    .filter(conn => Boolean(conn.source && conn.target))
    .map(conn => ({
      id: conn.id ? String(conn.id) : crypto.randomUUID(),
      source: String(conn.source),
      target: String(conn.target),
      title: conn.title ? String(conn.title) : undefined,
      description: conn.description ? String(conn.description) : undefined,
      updatedAt: typeof conn.updatedAt === 'string' ? conn.updatedAt : undefined,
      deletedAt: conn.deletedAt ? String(conn.deletedAt) : undefined,
    }))
    .filter(conn => taskIds.has(conn.source) && taskIds.has(conn.target) && conn.source !== conn.target);
}

function sanitizeProjectViewState(value: unknown): Project['viewState'] {
  if (
    !isRecord(value) ||
    typeof value.scale !== 'number' ||
    !Number.isFinite(value.scale) ||
    typeof value.positionX !== 'number' ||
    !Number.isFinite(value.positionX) ||
    typeof value.positionY !== 'number' ||
    !Number.isFinite(value.positionY)
  ) {
    return undefined;
  }

  return {
    scale: Number(value.scale),
    positionX: Number(value.positionX),
    positionY: Number(value.positionY),
  };
}

export function sanitizeProject(rawProject: unknown): Project {
  const project = rawProject as Record<string, unknown>;
  const tasks = sanitizeProjectTasks(project.tasks);
  const taskIds = new Set(tasks.map(task => task.id));

  return {
    id: String(project.id || crypto.randomUUID()),
    name: String(project.name || '未命名项目'),
    description: String(project.description || ''),
    createdDate: typeof project.createdDate === 'string' ? project.createdDate : nowISO(),
    tasks: repairTaskParents(tasks),
    connections: sanitizeProjectConnections(project.connections, taskIds),
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : nowISO(),
    version: typeof project.version === 'number' ? project.version : 0,
    viewState: sanitizeProjectViewState(project.viewState),
    flowchartUrl: typeof project.flowchartUrl === 'string' ? sanitizeUrlValue(project.flowchartUrl) : undefined,
    flowchartThumbnailUrl:
      typeof project.flowchartThumbnailUrl === 'string' ? sanitizeUrlValue(project.flowchartThumbnailUrl) : undefined,
  };
}

export function detectCycles(tasks: Task[]): { hasCycle: boolean; cycleNodes: string[] } {
  const taskMap = new Map(tasks.map(task => [task.id, task] as const));
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
