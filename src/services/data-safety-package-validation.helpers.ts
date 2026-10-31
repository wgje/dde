import { getUnsafeTaskWriteFields } from '../utils/task-write-payload-integrity';

type UnknownRecord = Record<string, unknown>;

export function validateDataSafetyPackageContents(
  value: UnknownRecord,
  schemaVersion: string,
  errors: string[],
): void {
  validateDataSafetyPackageMetadata(value, schemaVersion, errors);
  validateDataSafetyPackageSections(value, errors);
}

function validateDataSafetyPackageMetadata(
  value: UnknownRecord,
  schemaVersion: string,
  errors: string[],
): void {
  if (value['schemaVersion'] !== schemaVersion) {
    errors.push(`schemaVersion must be ${schemaVersion}`);
  }
  if (typeof value['ownerUserId'] !== 'string' || value['ownerUserId'].length === 0) {
    errors.push('ownerUserId is required');
  }
  if (typeof value['exportedAt'] !== 'string' || Number.isNaN(Date.parse(value['exportedAt']))) {
    errors.push('exportedAt must be an ISO timestamp');
  }
}

function validateDataSafetyPackageSections(
  value: UnknownRecord,
  errors: string[],
): void {
  validateDataSafetyLocalData(value['localData'], errors);
  validateDataSafetyLocalState(value['localState'], value['ownerUserId'], errors);
  validateDataSafetySyncSnapshot(value['syncSnapshot'], errors);
  validateDataSafetyReplayPlan(value['replayPlan'], errors);
  validateDataSafetyIntegrity(value['integrity'], errors);
}

function validateDataSafetyLocalData(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('localData is required');
    return;
  }

  const projectIds = validateRestoreRecordArray(value, 'projects', 'id', errors);
  validateRestoreRecordArray(value, 'tasks', 'id', errors);
  validateRestoreRecordArray(value, 'connections', 'id', errors);
  validateRestoreRecordArray(value, 'syncCursors', 'key', errors);
  validateProjectScopedRestoreRecords(value, 'tasks', projectIds, errors);
  validateProjectScopedRestoreRecords(value, 'connections', projectIds, errors);
  if (Array.isArray(value['tasks'])) {
    value['tasks'].forEach((task, index) => {
      if (!isRecord(task) || typeof task['content'] !== 'string') {
        errors.push(`localData.tasks[${index}].content must be a string`);
      }
    });
  }
}

function validateDataSafetyLocalState(
  value: unknown,
  ownerUserId: unknown,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push('localState is required');
    return;
  }

  validateDataSafetyRetryQueue(value['retryQueue'], ownerUserId, errors);
  validateDataSafetyActionQueue(value['actionQueue'], errors);
  validateArray(value, 'deadLetters', errors);
  validateArray(value, 'conflicts', errors);
}

function validateDataSafetyActionQueue(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('actionQueue must be an array');
    return;
  }

  value.forEach((item, index) => {
    const prefix = `localState.actionQueue[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    for (const field of ['id', 'operationId', 'entityType', 'entityId'] as const) {
      if (!readString(item[field])) errors.push(`${prefix}.${field} is required`);
    }
    if (item['type'] !== 'create' && item['type'] !== 'update' && item['type'] !== 'delete') {
      errors.push(`${prefix}.type must be create, update, or delete`);
    }
    const payload = item['payload'];
    if (!isRecord(payload)) {
      errors.push(`${prefix}.payload must be an object`);
    } else if (item['entityType'] === 'task'
      && (item['type'] === 'create' || item['type'] === 'update')) {
      validateTaskWritePayload(payload['task'], `${prefix}.payload.task`, errors);
    }
    if (readNumber(item['timestamp']) === undefined) {
      errors.push(`${prefix}.timestamp must be a finite number`);
    }
    if (!Number.isInteger(item['retryCount']) || (item['retryCount'] as number) < 0) {
      errors.push(`${prefix}.retryCount must be a non-negative integer`);
    }
  });
}

function validateDataSafetyRetryQueue(
  value: unknown,
  ownerUserId: unknown,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push('retryQueue must be an array');
    return;
  }

  value.forEach((item, index) => {
    const prefix = `localState.retryQueue[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    for (const field of ['id', 'operationId', 'sourceUserId', 'type', 'operation'] as const) {
      if (!readString(item[field])) errors.push(`${prefix}.${field} is required`);
    }
    if (readString(item['sourceUserId'])
      && readString(ownerUserId)
      && item['sourceUserId'] !== ownerUserId) {
      errors.push(`${prefix}.sourceUserId must match ownerUserId`);
    }
    const data = item['data'];
    if (!isRecord(data) || !readString(data['id'])) {
      errors.push(`${prefix}.data.id is required`);
    }
    if (isRecord(data) && item['type'] === 'task' && item['operation'] === 'upsert') {
      validateTaskWritePayload(data, `${prefix}.data`, errors);
    }
    if (!Number.isInteger(item['retryCount']) || (item['retryCount'] as number) < 0) {
      errors.push(`${prefix}.retryCount must be a non-negative integer`);
    }
    if (readNumber(item['createdAt']) === undefined) {
      errors.push(`${prefix}.createdAt must be a finite number`);
    }
  });
}

function validateTaskWritePayload(
  value: unknown,
  prefix: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }

  for (const field of getUnsafeTaskWriteFields(value)) {
    errors.push(`${prefix}.${field} must be a valid task write field`);
  }
}

function validateDataSafetySyncSnapshot(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('syncSnapshot is required');
    return;
  }

  if (!isRecord(value['syncState'])) {
    errors.push('syncSnapshot.syncState is required');
  }
}

function validateDataSafetyIntegrity(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('integrity is required');
    return;
  }

  if (typeof value['checksum'] !== 'string') {
    errors.push('integrity.checksum is required');
  }
}

function validateDataSafetyReplayPlan(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('replayPlan is required');
    return;
  }

  validateArray(value, 'steps', errors);
  if (!isRecord(value['summary'])) {
    errors.push('replayPlan.summary is required');
  }
  if (typeof value['idempotencyKey'] !== 'string') {
    errors.push('replayPlan.idempotencyKey is required');
  }
}

function validateArray(record: UnknownRecord, key: string, errors: string[]): void {
  if (!Array.isArray(record[key])) {
    errors.push(`${key} must be an array`);
  }
}

function validateRestoreRecordArray(
  record: UnknownRecord,
  key: string,
  identifierKey: 'id' | 'key',
  errors: string[],
): Set<string> {
  const identifiers = new Set<string>();
  validateArray(record, key, errors);
  if (!Array.isArray(record[key])) return identifiers;
  record[key].forEach((value, index) => {
    if (!isRecord(value)
      || typeof value[identifierKey] !== 'string'
      || value[identifierKey].length === 0) {
      errors.push(`localData.${key}[${index}].${identifierKey} is required`);
      return;
    }
    identifiers.add(value[identifierKey]);
  });
  return identifiers;
}

function validateProjectScopedRestoreRecords(
  record: UnknownRecord,
  key: 'tasks' | 'connections',
  projectIds: ReadonlySet<string>,
  errors: string[],
): void {
  const values = record[key];
  if (!Array.isArray(values)) return;

  values.forEach((value, index) => {
    if (!isRecord(value)) return;
    const projectId = readString(value['projectId']);
    if (!projectId) {
      errors.push(`localData.${key}[${index}].projectId is required`);
      return;
    }
    if (!projectIds.has(projectId)) {
      errors.push(`localData.${key}[${index}].projectId must reference localData.projects`);
    }
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
