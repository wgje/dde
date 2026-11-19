import {
  compareOfflineSyncCommandOrder,
  type HybridLogicalClock,
  type JsonObject,
  type JsonValue,
  type OfflineSyncCommandEnvelope,
} from './offline-sync-command-envelope';

export interface OfflineSyncFieldVersion {
  readonly logicalClock: HybridLogicalClock;
  readonly deviceId: string;
  readonly operationId: string;
  /** Full accepted command retained so later conflicts can preserve both sides. */
  readonly command?: OfflineSyncCommandEnvelope;
}

export interface OfflineSyncTombstone {
  readonly logicalClock: HybridLogicalClock;
  readonly deviceId: string;
  readonly operationId: string;
  /** Full delete command retained as durable tombstone evidence. */
  readonly command?: OfflineSyncCommandEnvelope;
}

export interface OfflineSyncProjectionState {
  readonly fields: JsonObject;
  readonly fieldVersions: Readonly<Record<string, OfflineSyncFieldVersion>>;
  readonly tombstone?: OfflineSyncTombstone;
}

export interface OfflineSyncConflictEvidence {
  readonly entityId: string;
  readonly field?: string;
  readonly losingOperationId: string;
  readonly winningOperationId: string;
  readonly losingValue?: JsonValue;
  readonly winningValue?: JsonValue;
  /** Full operation snapshots for forensic export/replay, not just the winner/loser IDs. */
  readonly losingCommand?: OfflineSyncCommandEnvelope;
  readonly winningCommand?: OfflineSyncCommandEnvelope;
  readonly losingVersion: OfflineSyncFieldVersion;
  readonly winningVersion: OfflineSyncFieldVersion;
  readonly reason: 'older-field-write' | 'tombstone-wins' | 'edit-blocked-by-tombstone' | 'restore-wins';
}

export interface OfflineSyncReconcileResult {
  readonly state: OfflineSyncProjectionState;
  readonly appliedFields: readonly string[];
  readonly applied: boolean;
  readonly evidence: readonly OfflineSyncConflictEvidence[];
}

function commandVersion(command: OfflineSyncCommandEnvelope): OfflineSyncFieldVersion {
  return {
    logicalClock: command.logicalClock,
    deviceId: command.deviceId,
    operationId: command.operationId,
    command,
  };
}

function compareVersion(
  left: OfflineSyncFieldVersion,
  right: OfflineSyncFieldVersion,
): number {
  return compareOfflineSyncCommandOrder(left, right);
}

function isDeleteCommand(command: OfflineSyncCommandEnvelope): boolean {
  return command.command.endsWith('.delete') || command.command.endsWith('.permanently_delete');
}

function isRestoreCommand(command: OfflineSyncCommandEnvelope): boolean {
  return command.command.endsWith('.restore');
}

function cloneFields(fields: JsonObject): Record<string, JsonValue> {
  return { ...fields };
}

function cloneFieldVersions(
  versions: Readonly<Record<string, OfflineSyncFieldVersion>>,
): Record<string, OfflineSyncFieldVersion> {
  return { ...versions };
}

export function createEmptyOfflineSyncProjectionState(
  fields: JsonObject = {},
): OfflineSyncProjectionState {
  return { fields, fieldVersions: {} };
}

/**
 * Apply one command deterministically. Older arrivals are retained as evidence,
 * while a tombstone blocks ordinary edits until an explicit restore command.
 */
function evidenceForTombstone(
  command: OfflineSyncCommandEnvelope,
  reason: OfflineSyncConflictEvidence['reason'],
  tombstone: OfflineSyncTombstone,
  losingValue?: JsonValue,
  winningValue?: JsonValue,
): OfflineSyncConflictEvidence {
  return {
    entityId: command.entityId,
    losingOperationId: command.operationId,
    winningOperationId: tombstone.operationId,
    losingValue,
    winningValue,
    losingCommand: command,
    winningCommand: tombstone.command,
    losingVersion: commandVersion(command),
    winningVersion: tombstone,
    reason,
  };
}

function evidenceForFieldReplacement(
  entityId: string,
  field: string,
  losingVersion: OfflineSyncFieldVersion,
  winningCommand: OfflineSyncCommandEnvelope,
  losingValue: JsonValue | undefined,
  winningValue?: JsonValue,
): OfflineSyncConflictEvidence {
  return {
    entityId,
    field,
    losingOperationId: losingVersion.operationId,
    winningOperationId: winningCommand.operationId,
    losingValue,
    winningValue,
    losingCommand: losingVersion.command,
    winningCommand,
    losingVersion,
    winningVersion: commandVersion(winningCommand),
    reason: 'older-field-write',
  };
}

function reconcileDeleteCommand(
  current: OfflineSyncProjectionState,
  command: OfflineSyncCommandEnvelope,
  incomingVersion: OfflineSyncFieldVersion,
): OfflineSyncReconcileResult {
  if (current.tombstone && compareVersion(incomingVersion, current.tombstone) <= 0) {
    return {
      state: current,
      appliedFields: [],
      applied: false,
      evidence: [evidenceForTombstone(command, 'older-field-write', current.tombstone)],
    };
  }
  const evidence = Object.entries(current.fieldVersions).map(([field, version]) =>
    evidenceForFieldReplacement(
      command.entityId,
      field,
      version,
      command,
      current.fields[field],
      undefined,
    ),
  );
  return {
    state: {
      fields: cloneFields(current.fields),
      fieldVersions: cloneFieldVersions(current.fieldVersions),
      tombstone: incomingVersion,
    },
    appliedFields: [],
    applied: true,
    evidence,
  };
}

function reconcileTombstonedCommand(
  current: OfflineSyncProjectionState,
  command: OfflineSyncCommandEnvelope,
): OfflineSyncReconcileResult | null {
  if (!current.tombstone || isRestoreCommand(command)) return null;
  return {
    state: current,
    appliedFields: [],
    applied: false,
    evidence: [evidenceForTombstone(command, 'edit-blocked-by-tombstone', current.tombstone)],
  };
}

function reconcileRestoreCommand(
  current: OfflineSyncProjectionState,
  command: OfflineSyncCommandEnvelope,
  incomingVersion: OfflineSyncFieldVersion,
): OfflineSyncReconcileResult | null {
  if (!current.tombstone || compareVersion(incomingVersion, current.tombstone) > 0) return null;
  return {
    state: current,
    appliedFields: [],
    applied: false,
    evidence: [evidenceForTombstone(command, 'tombstone-wins', current.tombstone)],
  };
}

interface FieldPatchResult {
  readonly fields: Record<string, JsonValue>;
  readonly fieldVersions: Record<string, OfflineSyncFieldVersion>;
  readonly appliedFields: readonly string[];
  readonly evidence: readonly OfflineSyncConflictEvidence[];
}

function applyFieldPatch(
  current: OfflineSyncProjectionState,
  command: OfflineSyncCommandEnvelope,
  incomingVersion: OfflineSyncFieldVersion,
): FieldPatchResult {
  const fields = cloneFields(current.fields);
  const fieldVersions = cloneFieldVersions(current.fieldVersions);
  const evidence: OfflineSyncConflictEvidence[] = [];
  const appliedFields: string[] = [];
  for (const [field, value] of Object.entries(command.normalizedResultPatch)) {
    const previousVersion = fieldVersions[field];
    if (previousVersion && compareVersion(incomingVersion, previousVersion) <= 0) {
      evidence.push({
        entityId: command.entityId,
        field,
        losingOperationId: command.operationId,
        winningOperationId: previousVersion.operationId,
        losingValue: value,
        winningValue: fields[field],
        losingCommand: command,
        winningCommand: previousVersion.command,
        losingVersion: incomingVersion,
        winningVersion: previousVersion,
        reason: 'older-field-write',
      });
      continue;
    }
    if (previousVersion) {
      evidence.push(evidenceForFieldReplacement(
        command.entityId,
        field,
        previousVersion,
        command,
        fields[field],
        value,
      ));
    }
    fields[field] = value;
    fieldVersions[field] = incomingVersion;
    appliedFields.push(field);
  }
  return { fields, fieldVersions, appliedFields, evidence };
}

export function reconcileOfflineSyncCommand(
  current: OfflineSyncProjectionState,
  command: OfflineSyncCommandEnvelope,
): OfflineSyncReconcileResult {
  const incomingVersion = commandVersion(command);
  if (isDeleteCommand(command)) return reconcileDeleteCommand(current, command, incomingVersion);
  const blocked = reconcileTombstonedCommand(current, command);
  if (blocked) return blocked;
  const blockedRestore = reconcileRestoreCommand(current, command, incomingVersion);
  if (blockedRestore) return blockedRestore;

  const patch = applyFieldPatch(current, command, incomingVersion);
  const restoreEvidence = isRestoreCommand(command) && current.tombstone
    ? [{
      entityId: command.entityId,
      losingOperationId: current.tombstone.operationId,
      winningOperationId: command.operationId,
      losingCommand: current.tombstone.command,
      winningCommand: command,
      losingVersion: current.tombstone,
      winningVersion: incomingVersion,
      reason: 'restore-wins' as const,
    }]
    : [];
  return {
    state: {
      fields: patch.fields,
      fieldVersions: patch.fieldVersions,
      ...(isRestoreCommand(command) ? {} : current.tombstone ? { tombstone: current.tombstone } : {}),
    },
    appliedFields: patch.appliedFields,
    applied: patch.appliedFields.length > 0 || isRestoreCommand(command),
    evidence: [...patch.evidence, ...restoreEvidence],
  };
}
