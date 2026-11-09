import type { Project } from '../../../../models';

type UnknownRecord = Record<string, unknown>;

export type OfflineSnapshotProjectsValidationResult =
  | { valid: true; projects: Project[] }
  | { valid: false; errors: string[] };

const MAX_VALIDATION_ERRORS = 50;
const TASK_STATUSES = new Set(['active', 'completed', 'archived']);
const ATTACHMENT_TYPES = new Set(['image', 'document', 'link', 'file']);
const ATTENTION_LEVELS = new Set(['info', 'warning', 'blocker']);
const SCAN_STATUSES = new Set([
  'pending',
  'scanning',
  'clean',
  'threat_detected',
  'failed',
  'quarantined',
  'skipped',
]);
const TASK_NUMBER_FIELDS = ['order', 'rank', 'x', 'y'] as const;

interface ValidatedTaskState {
  id: string;
  parentId: string | null;
  deletedConnections: unknown[];
  prefix: string;
}

export function validateOfflineSnapshotProjects(
  value: unknown,
): OfflineSnapshotProjectsValidationResult {
  if (!Array.isArray(value)) {
    return { valid: false, errors: ['projects must be an array'] };
  }

  const errors: string[] = [];
  const projectIds = new Set<string>();
  const globalTaskIds = new Set<string>();
  const globalConnectionIds = new Set<string>();

  value.forEach((project, projectIndex) => {
    validateProject(
      project,
      projectIndex,
      projectIds,
      globalTaskIds,
      globalConnectionIds,
      errors,
    );
  });

  return errors.length === 0
    ? { valid: true, projects: value as Project[] }
    : { valid: false, errors };
}

function validateProject(
  value: unknown,
  projectIndex: number,
  projectIds: Set<string>,
  globalTaskIds: Set<string>,
  globalConnectionIds: Set<string>,
  errors: string[],
): void {
  const prefix = `projects[${projectIndex}]`;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object`);
    return;
  }

  const projectId = requireNonEmptyString(value, 'id', prefix, errors);
  if (projectId) {
    addUniqueId(projectIds, projectId, `${prefix}.id`, 'project', errors);
  }
  requireString(value, 'name', prefix, errors);
  requireString(value, 'description', prefix, errors);
  requireNonEmptyString(value, 'createdDate', prefix, errors);
  validateOptionalString(value, 'updatedAt', prefix, errors, true);
  validateOptionalString(value, 'deletedAt', prefix, errors, true);
  validateOptionalFiniteNumber(value, 'version', prefix, errors);
  validateOptionalBoolean(value, 'pendingSync', prefix, errors);
  validateOptionalEnum(value, 'syncSource', prefix, errors, new Set(['local-only', 'synced']));
  validateOptionalString(value, 'flowchartUrl', prefix, errors, false);
  validateOptionalString(value, 'flowchartThumbnailUrl', prefix, errors, false);
  validateViewState(value['viewState'], `${prefix}.viewState`, errors);

  validateProjectCollections(value, prefix, globalTaskIds, globalConnectionIds, errors);
}

function validateProjectCollections(
  value: UnknownRecord,
  prefix: string,
  globalTaskIds: Set<string>,
  globalConnectionIds: Set<string>,
  errors: string[],
): void {
  if (!Array.isArray(value['tasks'])) {
    addError(errors, `${prefix}.tasks must be an array`);
    return;
  }
  if (!Array.isArray(value['connections'])) {
    addError(errors, `${prefix}.connections must be an array`);
    return;
  }

  const { projectTaskIds, taskStates } = collectProjectTaskStates(
    value['tasks'],
    prefix,
    globalTaskIds,
    errors,
  );
  validateTaskParentReferences(taskStates, projectTaskIds, errors);
  validateConnectionCollection(
    value['connections'],
    `${prefix}.connections`,
    projectTaskIds,
    globalConnectionIds,
    errors,
  );
  validateDeletedConnectionCollections(taskStates, projectTaskIds, globalConnectionIds, errors);
}

function collectProjectTaskStates(
  tasks: unknown[],
  projectPrefix: string,
  globalTaskIds: Set<string>,
  errors: string[],
): { projectTaskIds: Set<string>; taskStates: ValidatedTaskState[] } {
  const projectTaskIds = new Set<string>();
  const taskStates: ValidatedTaskState[] = [];
  tasks.forEach((task, taskIndex) => {
    const prefix = `${projectPrefix}.tasks[${taskIndex}]`;
    const taskResult = validateTask(task, prefix, globalTaskIds, errors);
    if (!taskResult) return;
    projectTaskIds.add(taskResult.id);
    taskStates.push({ ...taskResult, prefix });
  });
  return { projectTaskIds, taskStates };
}

function validateTaskParentReferences(
  taskStates: ValidatedTaskState[],
  projectTaskIds: ReadonlySet<string>,
  errors: string[],
): void {
  for (const task of taskStates) {
    if (task.parentId && !projectTaskIds.has(task.parentId)) {
      addError(errors, `${task.prefix}.parentId references a task outside its project`);
    }
    if (task.parentId === task.id) {
      addError(errors, `${task.prefix}.parentId cannot reference itself`);
    }
  }
}

function validateConnectionCollection(
  connections: unknown[],
  prefix: string,
  projectTaskIds: ReadonlySet<string>,
  globalConnectionIds: Set<string>,
  errors: string[],
): void {
  connections.forEach((connection, index) => {
    validateConnection(
      connection,
      `${prefix}[${index}]`,
      projectTaskIds,
      globalConnectionIds,
      errors,
    );
  });
}

function validateDeletedConnectionCollections(
  taskStates: ValidatedTaskState[],
  projectTaskIds: ReadonlySet<string>,
  globalConnectionIds: Set<string>,
  errors: string[],
): void {
  for (const task of taskStates) {
    validateConnectionCollection(
      task.deletedConnections,
      `${task.prefix}.deletedConnections`,
      projectTaskIds,
      globalConnectionIds,
      errors,
    );
  }
}

function validateTask(
  value: unknown,
  prefix: string,
  globalTaskIds: Set<string>,
  errors: string[],
): { id: string; parentId: string | null; deletedConnections: unknown[] } | null {
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object`);
    return null;
  }

  const identity = validateTaskRequiredFields(value, prefix, globalTaskIds, errors);
  const deletedConnections = validateTaskOptionalFields(value, prefix, errors);
  return identity ? { ...identity, deletedConnections } : null;
}

function validateTaskRequiredFields(
  value: UnknownRecord,
  prefix: string,
  globalTaskIds: Set<string>,
  errors: string[],
): { id: string; parentId: string | null } | null {
  const id = requireNonEmptyString(value, 'id', prefix, errors);
  if (id) {
    addUniqueId(globalTaskIds, id, `${prefix}.id`, 'task', errors);
  }
  requireString(value, 'title', prefix, errors);
  requireString(value, 'content', prefix, errors);
  requireString(value, 'displayId', prefix, errors);
  requireNonEmptyString(value, 'createdDate', prefix, errors);

  for (const field of TASK_NUMBER_FIELDS) {
    requireFiniteNumber(value, field, prefix, errors);
  }

  const stage = value['stage'];
  if (stage !== null && (!Number.isInteger(stage) || (stage as number) < 1)) {
    addError(errors, `${prefix}.stage must be null or a positive integer`);
  }

  const parentId = value['parentId'];
  if (parentId !== null && (typeof parentId !== 'string' || parentId.length === 0)) {
    addError(errors, `${prefix}.parentId must be null or a non-empty string`);
  }

  if (!TASK_STATUSES.has(String(value['status']))) {
    addError(errors, `${prefix}.status is invalid`);
  }

  return id && (parentId === null || typeof parentId === 'string')
    ? { id, parentId }
    : null;
}

function validateTaskOptionalFields(
  value: UnknownRecord,
  prefix: string,
  errors: string[],
): unknown[] {
  validateOptionalString(value, 'updatedAt', prefix, errors, false);
  validateOptionalString(value, 'completedAt', prefix, errors, true);
  validateOptionalString(value, 'deletedAt', prefix, errors, true);
  validateOptionalString(value, 'shortId', prefix, errors, true);
  validateOptionalString(value, 'dueDate', prefix, errors, true);
  validateOptionalBoolean(value, 'hasIncompleteTask', prefix, errors);
  validateOptionalStringArray(value, 'tags', prefix, errors);
  validateAttachments(value['attachments'], `${prefix}.attachments`, errors);
  const deletedConnections = validateDeletedConnections(
    value['deletedConnections'],
    `${prefix}.deletedConnections`,
    errors,
  );
  validateDeletedMeta(value['deletedMeta'], `${prefix}.deletedMeta`, errors);
  validateParkingMeta(value['parkingMeta'], `${prefix}.parkingMeta`, errors);
  validateAttentionMeta(value['attentionMeta'], `${prefix}.attentionMeta`, errors);
  validateOptionalEnum(value, 'priority', prefix, errors, new Set(['low', 'medium', 'high', 'urgent']));
  validateOptionalEnum(value, 'cognitive_load', prefix, errors, new Set(['high', 'low']), true);
  validateOptionalFiniteNumber(value, 'expected_minutes', prefix, errors, true);
  validateOptionalFiniteNumber(value, 'wait_minutes', prefix, errors, true);
  return deletedConnections;
}

function validateConnection(
  value: unknown,
  prefix: string,
  projectTaskIds: ReadonlySet<string>,
  globalConnectionIds: Set<string>,
  errors: string[],
): void {
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object`);
    return;
  }

  const id = requireNonEmptyString(value, 'id', prefix, errors);
  if (id) {
    addUniqueId(globalConnectionIds, id, `${prefix}.id`, 'connection', errors);
  }
  const source = requireNonEmptyString(value, 'source', prefix, errors);
  const target = requireNonEmptyString(value, 'target', prefix, errors);
  if (source && !projectTaskIds.has(source)) {
    addError(errors, `${prefix}.source references a task outside its project`);
  }
  if (target && !projectTaskIds.has(target)) {
    addError(errors, `${prefix}.target references a task outside its project`);
  }
  if (source && target && source === target) {
    addError(errors, `${prefix} cannot connect a task to itself`);
  }

  validateOptionalString(value, 'title', prefix, errors, false);
  validateOptionalString(value, 'description', prefix, errors, false);
  validateOptionalString(value, 'updatedAt', prefix, errors, false);
  validateOptionalString(value, 'deletedAt', prefix, errors, true);
}

function validateViewState(value: unknown, prefix: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object`);
    return;
  }
  requireFiniteNumber(value, 'scale', prefix, errors);
  requireFiniteNumber(value, 'positionX', prefix, errors);
  requireFiniteNumber(value, 'positionY', prefix, errors);
}

function validateAttachments(value: unknown, prefix: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    addError(errors, `${prefix} must be an array`);
    return;
  }

  value.forEach((attachment, index) => {
    const attachmentPrefix = `${prefix}[${index}]`;
    if (!isRecord(attachment)) {
      addError(errors, `${attachmentPrefix} must be an object`);
      return;
    }
    requireNonEmptyString(attachment, 'id', attachmentPrefix, errors);
    requireString(attachment, 'name', attachmentPrefix, errors);
    requireString(attachment, 'url', attachmentPrefix, errors);
    requireNonEmptyString(attachment, 'createdAt', attachmentPrefix, errors);
    if (typeof attachment['type'] !== 'string' || !ATTACHMENT_TYPES.has(attachment['type'])) {
      addError(errors, `${attachmentPrefix}.type is invalid`);
    }
    validateOptionalString(attachment, 'thumbnailUrl', attachmentPrefix, errors, false);
    validateOptionalString(attachment, 'mimeType', attachmentPrefix, errors, false);
    validateOptionalString(attachment, 'signedAt', attachmentPrefix, errors, false);
    validateOptionalString(attachment, 'deletedAt', attachmentPrefix, errors, false);
    validateOptionalFiniteNumber(attachment, 'size', attachmentPrefix, errors);
    validateAttachmentScanMetadata(
      attachment['scanMetadata'],
      `${attachmentPrefix}.scanMetadata`,
      errors,
    );
  });
}

function validateAttachmentScanMetadata(value: unknown, prefix: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object`);
    return;
  }
  validateOptionalString(value, 'fileId', prefix, errors, false);
  validateOptionalString(value, 'lastScannedAt', prefix, errors, false);
  validateOptionalString(value, 'fileHash', prefix, errors, false);
  validateOptionalEnum(value, 'scanStatus', prefix, errors, SCAN_STATUSES);

  const threat = value['threat'];
  if (threat !== undefined) {
    if (!isRecord(threat)) {
      addError(errors, `${prefix}.threat must be an object`);
    } else {
      requireString(threat, 'name', `${prefix}.threat`, errors);
      requireString(threat, 'description', `${prefix}.threat`, errors);
      requireNonEmptyString(threat, 'detectedAt', `${prefix}.threat`, errors);
    }
  }

  const history = value['scanHistory'];
  if (history !== undefined) {
    if (!Array.isArray(history)) {
      addError(errors, `${prefix}.scanHistory must be an array`);
    } else {
      history.forEach((entry, index) => {
        const entryPrefix = `${prefix}.scanHistory[${index}]`;
        if (!isRecord(entry)) {
          addError(errors, `${entryPrefix} must be an object`);
          return;
        }
        requireNonEmptyString(entry, 'scannedAt', entryPrefix, errors);
        requireString(entry, 'scanner', entryPrefix, errors);
        if (typeof entry['status'] !== 'string' || !SCAN_STATUSES.has(entry['status'])) {
          addError(errors, `${entryPrefix}.status is invalid`);
        }
      });
    }
  }
}

function validateDeletedConnections(value: unknown, prefix: string, errors: string[]): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    addError(errors, `${prefix} must be an array`);
    return [];
  }
  return value;
}

function validateDeletedMeta(value: unknown, prefix: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object`);
    return;
  }

  const parentId = value['parentId'];
  if (parentId !== null && (typeof parentId !== 'string' || parentId.length === 0)) {
    addError(errors, `${prefix}.parentId must be null or a non-empty string`);
  }
  const stage = value['stage'];
  if (stage !== null && (!Number.isInteger(stage) || (stage as number) < 1)) {
    addError(errors, `${prefix}.stage must be null or a positive integer`);
  }
  for (const field of TASK_NUMBER_FIELDS) {
    requireFiniteNumber(value, field, prefix, errors);
  }
  validateParkingMeta(value['parkingMeta'], `${prefix}.parkingMeta`, errors);
}

function validateParkingMeta(value: unknown, prefix: string, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object or null`);
    return;
  }
  if (value['state'] !== 'focused' && value['state'] !== 'parked') {
    addError(errors, `${prefix}.state is invalid`);
  }
  validateNullableStringField(value, 'parkedAt', prefix, errors);
  validateNullableStringField(value, 'lastVisitedAt', prefix, errors);
  if (typeof value['pinned'] !== 'boolean') {
    addError(errors, `${prefix}.pinned must be a boolean`);
  }
  validateParkingContextSnapshot(value['contextSnapshot'], `${prefix}.contextSnapshot`, errors);
  validateParkingReminder(value['reminder'], `${prefix}.reminder`, errors);
}

function validateParkingContextSnapshot(value: unknown, prefix: string, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object or null`);
    return;
  }
  requireNonEmptyString(value, 'savedAt', prefix, errors);
  requireString(value, 'contentHash', prefix, errors);
  if (value['viewMode'] !== 'text' && value['viewMode'] !== 'flow') {
    addError(errors, `${prefix}.viewMode is invalid`);
  }
  validateCursorPosition(value['cursorPosition'], `${prefix}.cursorPosition`, errors);
  validateScrollAnchor(value['scrollAnchor'], `${prefix}.scrollAnchor`, errors);
  validateStructuralAnchor(value['structuralAnchor'], `${prefix}.structuralAnchor`, errors);
  validateFlowViewport(value['flowViewport'], `${prefix}.flowViewport`, errors);
}

function validateCursorPosition(value: unknown, prefix: string, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object or null`);
    return;
  }
  requireFiniteNumber(value, 'line', prefix, errors);
  requireFiniteNumber(value, 'column', prefix, errors);
}

function validateScrollAnchor(value: unknown, prefix: string, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object or null`);
    return;
  }
  if (value['anchorType'] !== 'heading' && value['anchorType'] !== 'line') {
    addError(errors, `${prefix}.anchorType is invalid`);
  }
  requireFiniteNumber(value, 'anchorIndex', prefix, errors);
  requireFiniteNumber(value, 'scrollPercent', prefix, errors);
  validateOptionalFiniteNumber(value, 'anchorOffset', prefix, errors);
}

function validateStructuralAnchor(value: unknown, prefix: string, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object or null`);
    return;
  }
  if (!new Set(['heading', 'gojs-node', 'line', 'fallback']).has(String(value['type']))) {
    addError(errors, `${prefix}.type is invalid`);
  }
  requireString(value, 'label', prefix, errors);
  validateOptionalFiniteNumber(value, 'line', prefix, errors);
}

function validateFlowViewport(value: unknown, prefix: string, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object or null`);
    return;
  }
  requireFiniteNumber(value, 'scale', prefix, errors);
  validateNullableStringField(value, 'selectedNodeId', prefix, errors);
}

function validateParkingReminder(value: unknown, prefix: string, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object or null`);
    return;
  }
  requireNonEmptyString(value, 'reminderAt', prefix, errors);
  requireFiniteNumber(value, 'snoozeCount', prefix, errors);
  requireFiniteNumber(value, 'maxSnoozeCount', prefix, errors);
}

function validateAttentionMeta(value: unknown, prefix: string, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    addError(errors, `${prefix} must be an object or null`);
    return;
  }
  if (!Array.isArray(value['items'])) {
    addError(errors, `${prefix}.items must be an array`);
  } else {
    value['items'].forEach((item, index) => {
      const itemPrefix = `${prefix}.items[${index}]`;
      if (!isRecord(item)) {
        addError(errors, `${itemPrefix} must be an object`);
        return;
      }
      requireNonEmptyString(item, 'id', itemPrefix, errors);
      requireString(item, 'text', itemPrefix, errors);
      if (typeof item['level'] !== 'string' || !ATTENTION_LEVELS.has(item['level'])) {
        addError(errors, `${itemPrefix}.level is invalid`);
      }
      if (typeof item['done'] !== 'boolean') {
        addError(errors, `${itemPrefix}.done must be a boolean`);
      }
      requireNonEmptyString(item, 'createdAt', itemPrefix, errors);
      requireNonEmptyString(item, 'updatedAt', itemPrefix, errors);
    });
  }
  validateOptionalBoolean(value, 'pinned', prefix, errors);
  validateOptionalString(value, 'updatedAt', prefix, errors, false);
}

function validateNullableStringField(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
): void {
  const fieldValue = value[field];
  if (fieldValue !== null && typeof fieldValue !== 'string') {
    addError(errors, `${prefix}.${field} must be a string or null`);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
): string | null {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'string') {
    addError(errors, `${prefix}.${field} must be a string`);
    return null;
  }
  return fieldValue;
}

function requireNonEmptyString(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
): string | null {
  const fieldValue = requireString(value, field, prefix, errors);
  if (fieldValue !== null && fieldValue.length === 0) {
    addError(errors, `${prefix}.${field} must not be empty`);
    return null;
  }
  return fieldValue;
}

function requireFiniteNumber(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
): void {
  if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) {
    addError(errors, `${prefix}.${field} must be a finite number`);
  }
}

function validateOptionalString(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
  nullable: boolean,
): void {
  const fieldValue = value[field];
  if (fieldValue === undefined || (nullable && fieldValue === null)) return;
  if (typeof fieldValue !== 'string') {
    addError(errors, `${prefix}.${field} must be a string${nullable ? ' or null' : ''}`);
  }
}

function validateOptionalFiniteNumber(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
  nullable = false,
): void {
  const fieldValue = value[field];
  if (fieldValue === undefined || (nullable && fieldValue === null)) return;
  if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
    addError(errors, `${prefix}.${field} must be a finite number${nullable ? ' or null' : ''}`);
  }
}

function validateOptionalBoolean(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
): void {
  if (value[field] !== undefined && typeof value[field] !== 'boolean') {
    addError(errors, `${prefix}.${field} must be a boolean`);
  }
}

function validateOptionalStringArray(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
): void {
  const fieldValue = value[field];
  if (fieldValue === undefined) return;
  if (!Array.isArray(fieldValue) || fieldValue.some(item => typeof item !== 'string')) {
    addError(errors, `${prefix}.${field} must be an array of strings`);
  }
}

function validateOptionalEnum(
  value: UnknownRecord,
  field: string,
  prefix: string,
  errors: string[],
  allowed: ReadonlySet<string>,
  nullable = false,
): void {
  const fieldValue = value[field];
  if (fieldValue === undefined || (nullable && fieldValue === null)) return;
  if (typeof fieldValue !== 'string' || !allowed.has(fieldValue)) {
    addError(errors, `${prefix}.${field} is invalid`);
  }
}

function addUniqueId(
  ids: Set<string>,
  id: string,
  prefix: string,
  entityType: string,
  errors: string[],
): void {
  if (ids.has(id)) {
    addError(errors, `${prefix} duplicates another ${entityType} id`);
    return;
  }
  ids.add(id);
}

function addError(errors: string[], error: string): void {
  if (errors.length < MAX_VALIDATION_ERRORS) {
    errors.push(error);
  }
}
