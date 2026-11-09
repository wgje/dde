import type { Connection, Task } from '../models';

export interface RemoteVersionConflictEvidence {
  code: string;
  message: string;
  details?: unknown;
  remoteEntity?: Task | Connection;
  reason: 'remote-newer' | 'remote-tombstone';
}

export function resolveRemoteVersionConflictEvidence(
  error: unknown,
  supportedCodes: readonly string[],
): RemoteVersionConflictEvidence | null {
  const supportedCodeSet = new Set(supportedCodes);
  const candidates = collectErrorCandidates(error);

  for (const candidate of candidates) {
    const code = readStringProperty(candidate, 'code');
    if (code && supportedCodeSet.has(code)) {
      const details = readUnknownProperty(candidate, 'details') ?? readUnknownProperty(error, 'context');
      return {
        code,
        message: resolveErrorMessage(error),
        details,
        remoteEntity: resolveRemoteEntity(details) ?? resolveRemoteEntity(candidate),
        reason: code.includes('TOMBSTONE') ? 'remote-tombstone' : 'remote-newer',
      };
    }
  }

  return null;
}

function collectErrorCandidates(error: unknown): unknown[] {
  const candidates = [error];
  const originalError = readUnknownProperty(error, 'originalError');
  if (originalError) {
    candidates.push(originalError);
  }
  const cause = readUnknownProperty(error, 'cause');
  if (cause) {
    candidates.push(cause);
  }
  return candidates;
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  const message = readStringProperty(error, 'message');
  return message ?? String(error ?? 'Version conflict');
}

function readStringProperty(value: unknown, property: string): string | undefined {
  const propertyValue = readUnknownProperty(value, property);
  return typeof propertyValue === 'string' && propertyValue.length > 0
    ? propertyValue
    : undefined;
}

function resolveRemoteEntity(value: unknown): Task | Connection | undefined {
  const remoteEntity = readUnknownProperty(value, 'remoteEntity')
    ?? readUnknownProperty(value, 'remoteTask')
    ?? readUnknownProperty(value, 'remoteConnection')
    ?? readUnknownProperty(value, 'remote');
  return isRemoteConflictEntity(remoteEntity) ? remoteEntity : undefined;
}

function readUnknownProperty(value: unknown, property: string): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return (value as Record<string, unknown>)[property];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRemoteConflictEntity(value: unknown): value is Task | Connection {
  return isObjectRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0;
}
