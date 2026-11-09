import type { DockLane } from '../models/parking-dock';
import type { ActiveProjectOwner } from '../services/project-state.service';

export interface TaskDragPayloadV1 {
  v: 1;
  type: 'task';
  taskId: string;
  projectId: string | null;
  projectOwner?: ActiveProjectOwner | null;
  source: 'text' | 'flow' | 'dock';
  laneHint?: DockLane | null;
  fromProjectId?: string | null;
}

const MIME_TASK = 'application/x-nanoflow-task';
const MIME_TASK_ID = 'text/task-id';
const MIME_TEXT = 'text/plain';
const MIME_JSON = 'application/json';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSource(value: unknown): TaskDragPayloadV1['source'] {
  return value === 'text' || value === 'flow' || value === 'dock' ? value : 'dock';
}

function normalizeLaneHint(value: unknown): DockLane | null {
  if (value === 'combo-select' || value === 'backup') return value;
  // legacy payload compatibility
  if (value === 'strong') return 'combo-select';
  if (value === 'weak') return 'backup';
  return null;
}

function normalizeProjectId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeTaskId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeProjectOwner(value: unknown): ActiveProjectOwner | null {
  if (!isPlainObject(value)) return null;
  const projectId = value['projectId'];
  const generation = value['generation'];
  if ((projectId !== null && (typeof projectId !== 'string' || projectId.length === 0))
    || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return null;
  return { projectId, generation };
}

function toPayloadFromUnknown(raw: unknown): TaskDragPayloadV1 | null {
  if (!isPlainObject(raw)) return null;

  const rawV = raw['v'];
  const rawType = raw['type'];
  const rawTaskId = raw['taskId'];

  if (rawV === 1 && rawType === 'task' && typeof rawTaskId === 'string' && rawTaskId.trim()) {
    const projectOwner = normalizeProjectOwner(raw['projectOwner']);
    return {
      v: 1,
      type: 'task',
      taskId: rawTaskId.trim(),
      projectId: projectOwner?.projectId ?? normalizeProjectId(raw['projectId']),
      projectOwner,
      source: normalizeSource(raw['source']),
      laneHint: normalizeLaneHint(raw['laneHint'] ?? raw['relationHint']),
      fromProjectId: normalizeProjectId(raw['fromProjectId'] ?? raw['projectId']),
    };
  }

  const legacyTaskId = normalizeTaskId(raw['id']);
  if (!legacyTaskId) return null;

  return {
    v: 1,
    type: 'task',
    taskId: legacyTaskId,
    projectId: normalizeProjectId(raw['projectId'] ?? raw['sourceProjectId']),
    projectOwner: null,
    source: normalizeSource(raw['source']),
    laneHint: normalizeLaneHint(raw['laneHint'] ?? raw['relationHint']),
    fromProjectId: normalizeProjectId(raw['fromProjectId'] ?? raw['projectId'] ?? raw['sourceProjectId']),
  };
}

function safeSetData(dataTransfer: DataTransfer, mime: string, value: string): void {
  try {
    dataTransfer.setData(mime, value);
  } catch {
    // Ignore unsupported/blocked mime writes in constrained browsers.
  }
}

function safeGetData(dataTransfer: DataTransfer, mime: string): string {
  try {
    return dataTransfer.getData(mime) ?? '';
  } catch {
    return '';
  }
}

function tryParseJson(raw: string): unknown {
  if (!raw) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  return parsed;
}

export function writeTaskDragPayload(dataTransfer: DataTransfer, payload: TaskDragPayloadV1): void {
  const taskId = payload.taskId.trim();
  if (!taskId) return;

  const projectOwner = normalizeProjectOwner(payload.projectOwner);
  const projectId = projectOwner?.projectId ?? normalizeProjectId(payload.projectId);
  const normalized: TaskDragPayloadV1 = {
    v: 1,
    type: 'task',
    taskId,
    projectId,
    projectOwner,
    source: payload.source,
    laneHint: normalizeLaneHint(payload.laneHint),
    fromProjectId: projectOwner?.projectId ?? normalizeProjectId(payload.fromProjectId ?? projectId),
  };

  const json = JSON.stringify(normalized);
  safeSetData(dataTransfer, MIME_TASK, json);
  safeSetData(dataTransfer, MIME_TASK_ID, normalized.taskId);
  safeSetData(dataTransfer, MIME_TEXT, normalized.taskId);
  safeSetData(dataTransfer, MIME_JSON, json);
}

/**
 * 在 dragover 事件期间检查 dataTransfer 是否包含任务拖拽类型。
 * 浏览器安全限制导致 dragover 期间无法通过 getData() 读取数据，
 * 但可以通过 dataTransfer.types 检查 MIME 类型是否存在。
 */
export function hasTaskDragTypes(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const types = dataTransfer.types;
  return types.includes(MIME_TASK) || types.includes(MIME_TASK_ID);
}

export function readTaskDragPayload(dataTransfer: DataTransfer): TaskDragPayloadV1 | null {
  const direct = toPayloadFromUnknown(tryParseJson(safeGetData(dataTransfer, MIME_TASK)));
  if (direct) return direct;

  const fromJson = toPayloadFromUnknown(tryParseJson(safeGetData(dataTransfer, MIME_JSON)));
  if (fromJson) return fromJson;

  const fromTaskId = normalizeTaskId(safeGetData(dataTransfer, MIME_TASK_ID));
  if (fromTaskId) {
    return {
      v: 1,
      type: 'task',
      taskId: fromTaskId,
      projectId: null,
      projectOwner: null,
      source: 'dock',
      laneHint: null,
      fromProjectId: null,
    };
  }

  const fromText = safeGetData(dataTransfer, MIME_TEXT);
  const textAsPayload = toPayloadFromUnknown(tryParseJson(fromText));
  if (textAsPayload) return textAsPayload;
  const textTaskId = normalizeTaskId(fromText);
  if (!textTaskId) return null;

  return {
    v: 1,
    type: 'task',
    taskId: textTaskId,
    projectId: null,
    projectOwner: null,
    source: 'dock',
    laneHint: null,
    fromProjectId: null,
  };
}
