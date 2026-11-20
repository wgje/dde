export const OFFLINE_COMMAND_STORE_SCHEMA_VERSION = 1 as const;
export const OFFLINE_COMMAND_STORE_DB_NAME = 'nanoflow-offline-command-store';
export const OFFLINE_COMMAND_STORE_DB_VERSION = 2;

export const OFFLINE_COMMAND_STORE_NAMES = {
  projections: 'projections',
  commands: 'commands',
  audits: 'audits',
  quarantine: 'quarantine',
  conflictEvidence: 'conflict_evidence',
} as const;

export type OfflineCommandStoreCommandStatus =
  | 'pending'
  | 'sent'
  | 'acked'
  | 'unknown'
  | 'superseded'
  | 'rejected';

export interface OfflineProjectionRecord<T = unknown> {
  key: string;
  ownerUserId: string;
  entityType: string;
  entityId: string;
  value: T;
  version: number;
  updatedAt: string;
  tombstone?: boolean;
  schemaVersion: typeof OFFLINE_COMMAND_STORE_SCHEMA_VERSION;
}

export interface OfflineCommandRecord<T = unknown> {
  key: string;
  ownerUserId: string;
  operationId: string;
  entityType: string;
  entityId: string;
  command: T;
  status: OfflineCommandStoreCommandStatus;
  createdAt: string;
  updatedAt: string;
  schemaVersion: typeof OFFLINE_COMMAND_STORE_SCHEMA_VERSION;
}

export interface OfflineAuditRecord {
  key: string;
  ownerUserId: string;
  operationId: string;
  entityType: string;
  entityId: string;
  operation: string;
  localTimestamp: string;
  updatedAtBaseline?: string;
  queueResult?: string;
  conflictDecision?: string;
  conflictEvidenceKeys?: string[];
  lastSyncTimeEffect?: string;
  /** Remote replay outcome retained for explainability and unknown-outcome recovery. */
  remoteDecision?: string;
  /** Raw remote response retained as JSON-safe evidence. */
  remoteResponse?: unknown;
  /** Server timestamp returned by an acknowledged replay, when available. */
  serverUpdatedAt?: string;
  schemaVersion: typeof OFFLINE_COMMAND_STORE_SCHEMA_VERSION;
}

export interface OfflineConflictEvidenceRecord<T = unknown> {
  key: string;
  ownerUserId: string;
  conflictId: string;
  entityType: string;
  entityId: string;
  losingOperationId: string;
  winningOperationId: string;
  evidence: T;
  capturedAt: string;
  schemaVersion: typeof OFFLINE_COMMAND_STORE_SCHEMA_VERSION;
}

export interface OfflineQuarantineRecord {
  key: string;
  ownerUserId: string | null;
  reason: string;
  raw: unknown;
  quarantinedAt: string;
  schemaVersion: typeof OFFLINE_COMMAND_STORE_SCHEMA_VERSION;
}

export interface OfflineCommandStoreWrite<TCommand = unknown, TProjection = unknown> {
  ownerUserId: string;
  projection: Omit<OfflineProjectionRecord<TProjection>, 'key' | 'schemaVersion'> & {
    key?: string;
  };
  command: Omit<OfflineCommandRecord<TCommand>, 'key' | 'schemaVersion'> & {
    key?: string;
  };
  audit: Omit<OfflineAuditRecord, 'key' | 'schemaVersion'> & { key?: string };
  conflictEvidence?: Array<Omit<OfflineConflictEvidenceRecord, 'key' | 'schemaVersion'> & { key?: string }>;
}

export interface OfflineCommandStoreExport<TCommand = unknown, TProjection = unknown> {
  schemaVersion: typeof OFFLINE_COMMAND_STORE_SCHEMA_VERSION;
  ownerUserId: string;
  projections: Array<OfflineProjectionRecord<TProjection>>;
  commands: Array<OfflineCommandRecord<TCommand>>;
  audits: Array<OfflineAuditRecord>;
  quarantine: Array<OfflineQuarantineRecord>;
  /** Absent in pre-evidence exports; restore must preserve current evidence when omitted. */
  conflictEvidence?: Array<OfflineConflictEvidenceRecord>;
}

export interface OfflineCommandReplayUpdate {
  readonly ownerUserId: string;
  readonly operationId: string;
  readonly status: OfflineCommandStoreCommandStatus;
  readonly updatedAt?: string;
  readonly decision?: string;
  readonly rawResponse?: unknown;
  readonly serverUpdatedAt?: string;
  readonly lastSyncTimeEffect?: string;
}

export interface OfflineCommandStoreOptions {
  dbName?: string;
  dbVersion?: number;
  storage?: Storage;
  indexedDb?: IDBFactory;
  now?: () => string;
  idFactory?: () => string;
}

export interface OfflineCommandStore {
  init(): Promise<void>;
  commitLocalChange<TCommand, TProjection>(
    input: OfflineCommandStoreWrite<TCommand, TProjection>,
  ): Promise<void>;
  getProjection<TProjection>(ownerUserId: string, key: string): Promise<OfflineProjectionRecord<TProjection> | null>;
  putProjection<TProjection>(record: Omit<OfflineProjectionRecord<TProjection>, 'schemaVersion'>): Promise<void>;
  listProjections<TProjection>(ownerUserId: string): Promise<Array<OfflineProjectionRecord<TProjection>>>;
  listCommands<TCommand>(
    ownerUserId: string,
    status?: OfflineCommandStoreCommandStatus,
  ): Promise<Array<OfflineCommandRecord<TCommand>>>;
  /** Atomically records remote replay status on the command and its audit row. */
  updateReplayResult<TCommand>(update: OfflineCommandReplayUpdate): Promise<OfflineCommandRecord<TCommand> | null>;
  getAudit(ownerUserId: string, operationId: string): Promise<OfflineAuditRecord | null>;
  quarantine(input: Omit<OfflineQuarantineRecord, 'key' | 'schemaVersion'> & { key?: string }): Promise<void>;
  listConflictEvidence(ownerUserId: string): Promise<Array<OfflineConflictEvidenceRecord>>;
  exportOwner<TCommand, TProjection>(ownerUserId: string): Promise<OfflineCommandStoreExport<TCommand, TProjection>>;
  restoreOwner<TCommand, TProjection>(payload: OfflineCommandStoreExport<TCommand, TProjection>): Promise<void>;
}

function projectionKey(ownerUserId: string, entityType: string, entityId: string): string {
  return `${ownerUserId}:projection:${entityType}:${entityId}`;
}

function commandKey(ownerUserId: string, operationId: string): string {
  return `${ownerUserId}:command:${operationId}`;
}

function auditKey(ownerUserId: string, operationId: string): string {
  return `${ownerUserId}:audit:${operationId}`;
}

function quarantineKey(ownerUserId: string | null, idFactory: () => string): string {
  return `${ownerUserId ?? 'unknown'}:quarantine:${idFactory()}`;
}

function isQuarantineVisibleToOwner(record: OfflineQuarantineRecord, ownerUserId: string): boolean {
  return record.ownerUserId === null || record.ownerUserId === ownerUserId;
}

function conflictEvidenceKey(ownerUserId: string, conflictId: string): string {
  return `${ownerUserId}:conflict:${conflictId}`;
}

function withSchemaVersion<T extends object>(value: T): T & { schemaVersion: typeof OFFLINE_COMMAND_STORE_SCHEMA_VERSION } {
  return { ...value, schemaVersion: OFFLINE_COMMAND_STORE_SCHEMA_VERSION };
}

function assertOwnerConsistency<TCommand, TProjection>(input: OfflineCommandStoreWrite<TCommand, TProjection>): void {
  if (input.projection.ownerUserId !== input.ownerUserId
    || input.command.ownerUserId !== input.ownerUserId
    || input.audit.ownerUserId !== input.ownerUserId
    || (input.conflictEvidence ?? []).some(item => item.ownerUserId !== input.ownerUserId)) {
    throw new Error('Offline command store owner mismatch');
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function operationIdentity(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return stableJson(value);
  const record = { ...(value as Record<string, unknown>) };
  delete record.status;
  delete record.decision;
  delete record.rawResponse;
  delete record.serverUpdatedAt;
  return stableJson(record);
}

function assertOperationIdempotent<T>(
  existing: OfflineCommandRecord<T>,
  incoming: OfflineCommandRecord<T>,
): void {
  if (existing.ownerUserId !== incoming.ownerUserId
    || existing.operationId !== incoming.operationId
    || existing.entityType !== incoming.entityType
    || existing.entityId !== incoming.entityId
    || operationIdentity(existing.command) !== operationIdentity(incoming.command)) {
    throw new Error('Offline command operationId collision');
  }
}


function applyReplayUpdate<TCommand>(
  record: OfflineCommandRecord<TCommand>,
  update: OfflineCommandReplayUpdate,
  now: string,
): OfflineCommandRecord<TCommand> {
  const command = record.command && typeof record.command === 'object' && !Array.isArray(record.command)
    ? { ...(record.command as Record<string, unknown>), status: update.status,
        ...(update.decision === undefined ? {} : { decision: update.decision }),
        ...(update.rawResponse === undefined ? {} : { rawResponse: update.rawResponse }) }
    : record.command;
  return { ...record, status: update.status, updatedAt: update.updatedAt ?? now, command: command as TCommand };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function readAll<T>(store: IDBObjectStore): Promise<T[]> {
  if (typeof store.getAll === 'function') return requestToPromise(store.getAll());
  const values: T[] = [];
  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      values.push(cursor.value as T);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
  });
  return values;
}

export class IndexedDbOfflineCommandStore implements OfflineCommandStore {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private readonly dbName: string;
  private readonly dbVersion: number;
  private readonly indexedDb: IDBFactory | undefined;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: OfflineCommandStoreOptions = {}) {
    this.dbName = options.dbName ?? OFFLINE_COMMAND_STORE_DB_NAME;
    this.dbVersion = options.dbVersion ?? OFFLINE_COMMAND_STORE_DB_VERSION;
    this.indexedDb = options.indexedDb ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto?.randomUUID?.() ?? (`offline-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  }

  async init(): Promise<void> {
    await this.open();
  }

  async commitLocalChange<TCommand, TProjection>(
    input: OfflineCommandStoreWrite<TCommand, TProjection>,
  ): Promise<void> {
    const db = await this.open();
    assertOwnerConsistency(input);
    const projection = withSchemaVersion({
      ...input.projection,
      key: input.projection.key ?? projectionKey(
        input.ownerUserId,
        input.projection.entityType,
        input.projection.entityId,
      ),
    });
    const command = withSchemaVersion({
      ...input.command,
      key: input.command.key ?? commandKey(input.ownerUserId, input.command.operationId),
    });
    const audit = withSchemaVersion({
      ...input.audit,
      key: input.audit.key ?? auditKey(input.ownerUserId, input.audit.operationId),
    });
    const conflictEvidence = (input.conflictEvidence ?? []).map(item => withSchemaVersion({
      ...item,
      key: item.key ?? conflictEvidenceKey(input.ownerUserId, item.conflictId),
    }));

    const transaction = db.transaction(
      [
        OFFLINE_COMMAND_STORE_NAMES.projections,
        OFFLINE_COMMAND_STORE_NAMES.commands,
        OFFLINE_COMMAND_STORE_NAMES.audits,
        OFFLINE_COMMAND_STORE_NAMES.conflictEvidence,
      ],
      'readwrite',
    );
    const commandStore = transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.commands);
    const existingCommand = await requestToPromise<OfflineCommandRecord<TCommand> | undefined>(
      commandStore.get(command.key),
    );
    if (existingCommand) assertOperationIdempotent(existingCommand, command);
    transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.projections).put(projection);
    commandStore.put(command);
    transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.audits).put(audit);
    const evidenceStore = transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.conflictEvidence);
    conflictEvidence.forEach(item => evidenceStore.put(item));
    await transactionToPromise(transaction);
  }

  async getProjection<TProjection>(ownerUserId: string, key: string): Promise<OfflineProjectionRecord<TProjection> | null> {
    const db = await this.open();
    const transaction = db.transaction(OFFLINE_COMMAND_STORE_NAMES.projections, 'readonly');
    const value = await requestToPromise<OfflineProjectionRecord<TProjection> | undefined>(
      transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.projections).get(key),
    );
    await transactionToPromise(transaction);
    if (!value || value.ownerUserId !== ownerUserId) return null;
    return value;
  }

  async listProjections<TProjection>(ownerUserId: string): Promise<Array<OfflineProjectionRecord<TProjection>>> {
    const db = await this.open();
    const tx = db.transaction(OFFLINE_COMMAND_STORE_NAMES.projections, 'readonly');
    const values = await readAll<OfflineProjectionRecord<TProjection>>(tx.objectStore(OFFLINE_COMMAND_STORE_NAMES.projections));
    await transactionToPromise(tx);
    return values.filter(item => item.ownerUserId === ownerUserId);
  }

  async putProjection<TProjection>(record: Omit<OfflineProjectionRecord<TProjection>, 'schemaVersion'>): Promise<void> {
    if (!record.ownerUserId || !record.key.startsWith(`${record.ownerUserId}:projection:`)) {
      throw new Error('Offline projection owner mismatch');
    }
    const db = await this.open();
    const tx = db.transaction(OFFLINE_COMMAND_STORE_NAMES.projections, 'readwrite');
    tx.objectStore(OFFLINE_COMMAND_STORE_NAMES.projections).put(withSchemaVersion(record));
    await transactionToPromise(tx);
  }

  async listCommands<TCommand>(
    ownerUserId: string,
    status?: OfflineCommandStoreCommandStatus,
  ): Promise<Array<OfflineCommandRecord<TCommand>>> {
    const db = await this.open();
    const transaction = db.transaction(OFFLINE_COMMAND_STORE_NAMES.commands, 'readonly');
    const values = await readAll<OfflineCommandRecord<TCommand>>(transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.commands));
    await transactionToPromise(transaction);
    return values.filter(item => item.ownerUserId === ownerUserId && (!status || item.status === status));
  }

  async updateReplayResult<TCommand>(update: OfflineCommandReplayUpdate): Promise<OfflineCommandRecord<TCommand> | null> {
    const db = await this.open();
    const transaction = db.transaction([OFFLINE_COMMAND_STORE_NAMES.commands, OFFLINE_COMMAND_STORE_NAMES.audits], 'readwrite');
    const commandStore = transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.commands);
    const auditStore = transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.audits);
    const current = await requestToPromise<OfflineCommandRecord<TCommand> | undefined>(commandStore.get(commandKey(update.ownerUserId, update.operationId)));
    if (!current || current.ownerUserId !== update.ownerUserId) {
      await transactionToPromise(transaction);
      return null;
    }
    const updated = applyReplayUpdate(current, update, this.now());
    commandStore.put(updated);
    const audit = await requestToPromise<OfflineAuditRecord | undefined>(auditStore.get(auditKey(update.ownerUserId, update.operationId)));
    if (audit && audit.ownerUserId === update.ownerUserId) {
      auditStore.put(withSchemaVersion({
        ...audit,
        queueResult: update.status,
        ...(update.decision === undefined ? {} : { conflictDecision: update.decision, remoteDecision: update.decision }),
        ...(update.rawResponse === undefined ? {} : { remoteResponse: update.rawResponse }),
        ...(update.serverUpdatedAt === undefined ? {} : { serverUpdatedAt: update.serverUpdatedAt }),
        ...(update.lastSyncTimeEffect === undefined ? {} : { lastSyncTimeEffect: update.lastSyncTimeEffect }),
      }));
    }
    await transactionToPromise(transaction);
    return updated;
  }

  async getAudit(ownerUserId: string, operationId: string): Promise<OfflineAuditRecord | null> {
    const db = await this.open();
    const transaction = db.transaction(OFFLINE_COMMAND_STORE_NAMES.audits, 'readonly');
    const value = await requestToPromise<OfflineAuditRecord | undefined>(
      transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.audits).get(auditKey(ownerUserId, operationId)),
    );
    await transactionToPromise(transaction);
    return value ?? null;
  }

  async quarantine(input: Omit<OfflineQuarantineRecord, 'key' | 'schemaVersion'> & { key?: string }): Promise<void> {
    const db = await this.open();
    const value = withSchemaVersion({
      ...input,
      key: input.key ?? quarantineKey(input.ownerUserId, this.idFactory),
    });
    const transaction = db.transaction(OFFLINE_COMMAND_STORE_NAMES.quarantine, 'readwrite');
    transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.quarantine).put(value);
    await transactionToPromise(transaction);
  }

  async listConflictEvidence(ownerUserId: string): Promise<OfflineConflictEvidenceRecord[]> {
    const db = await this.open();
    const transaction = db.transaction(OFFLINE_COMMAND_STORE_NAMES.conflictEvidence, 'readonly');
    const records = await readAll<OfflineConflictEvidenceRecord>(
      transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.conflictEvidence),
    );
    await transactionToPromise(transaction);
    return records.filter(record => record.ownerUserId === ownerUserId);
  }

  async exportOwner<TCommand, TProjection>(ownerUserId: string): Promise<OfflineCommandStoreExport<TCommand, TProjection>> {
    const db = await this.open();
    const transaction = db.transaction(
      Object.values(OFFLINE_COMMAND_STORE_NAMES),
      'readonly',
    );
    const [projections, commands, audits, quarantine, conflictEvidence] = await Promise.all([
      readAll<OfflineProjectionRecord<TProjection>>(transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.projections)),
      readAll<OfflineCommandRecord<TCommand>>(transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.commands)),
      readAll<OfflineAuditRecord>(transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.audits)),
      readAll<OfflineQuarantineRecord>(transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.quarantine)),
      readAll<OfflineConflictEvidenceRecord>(transaction.objectStore(OFFLINE_COMMAND_STORE_NAMES.conflictEvidence)),
    ]);
    await transactionToPromise(transaction);
    return {
      schemaVersion: OFFLINE_COMMAND_STORE_SCHEMA_VERSION,
      ownerUserId,
      projections: projections.filter(item => item.ownerUserId === ownerUserId),
      commands: commands.filter(item => item.ownerUserId === ownerUserId),
      audits: audits.filter(item => item.ownerUserId === ownerUserId),
      quarantine: quarantine.filter(item => isQuarantineVisibleToOwner(item, ownerUserId)),
      conflictEvidence: conflictEvidence.filter(item => item.ownerUserId === ownerUserId),
    };
  }


  async restoreOwner<TCommand, TProjection>(
    payload: OfflineCommandStoreExport<TCommand, TProjection>,
  ): Promise<void> {
    assertRestorePayload(payload);
    const db = await this.open();
    const storeNames = Object.values(OFFLINE_COMMAND_STORE_NAMES);
    const transaction = db.transaction(storeNames, 'readwrite');
    const stores = storeNames.map(name => transaction.objectStore(name));
    const [projections, commands, audits, quarantine, conflictEvidence] = await Promise.all([
      readAll<OfflineProjectionRecord<TProjection>>(stores[0]),
      readAll<OfflineCommandRecord<TCommand>>(stores[1]),
      readAll<OfflineAuditRecord>(stores[2]),
      readAll<OfflineQuarantineRecord>(stores[3]),
      readAll<OfflineConflictEvidenceRecord>(stores[4]),
    ]);
    projections.filter(item => item.ownerUserId === payload.ownerUserId).forEach(item => stores[0].delete(item.key));
    commands.filter(item => item.ownerUserId === payload.ownerUserId).forEach(item => stores[1].delete(item.key));
    audits.filter(item => item.ownerUserId === payload.ownerUserId).forEach(item => stores[2].delete(item.key));
    if (payload.conflictEvidence !== undefined) {
      conflictEvidence.filter(item => item.ownerUserId === payload.ownerUserId).forEach(item => stores[4].delete(item.key));
    }
    quarantine.filter(item => item.ownerUserId === payload.ownerUserId).forEach(item => stores[3].delete(item.key));
    payload.projections.forEach(item => stores[0].put(item));
    payload.commands.forEach(item => stores[1].put(item));
    payload.audits.forEach(item => stores[2].put(item));
    payload.quarantine.forEach(item => stores[3].put(item));
    payload.conflictEvidence?.forEach(item => stores[4].put(item));
    await transactionToPromise(transaction);
  }

  private open(): Promise<IDBDatabase> {
    if (!this.indexedDb) return Promise.reject(new Error('IndexedDB unavailable'));
    if (this.db) return Promise.resolve(this.db);
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb!.open(this.dbName, this.dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const storeName of Object.values(OFFLINE_COMMAND_STORE_NAMES)) {
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
          this.dbPromise = null;
        };
        resolve(this.db);
      };
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
      request.onblocked = () => {
        this.dbPromise = null;
        reject(new Error('IndexedDB open blocked'));
      };
    });
    return this.dbPromise;
  }
}

interface LocalStorageEnvelope {
  schemaVersion: typeof OFFLINE_COMMAND_STORE_SCHEMA_VERSION;
  projections: Array<OfflineProjectionRecord>;
  commands: Array<OfflineCommandRecord>;
  audits: Array<OfflineAuditRecord>;
  quarantine: Array<OfflineQuarantineRecord>;
  conflictEvidence: Array<OfflineConflictEvidenceRecord>;
}

export class LocalStorageOfflineCommandStore implements OfflineCommandStore {
  private readonly storage: Storage | undefined;
  private readonly storageKey: string;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: OfflineCommandStoreOptions = {}) {
    this.storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    this.storageKey = `${options.dbName ?? OFFLINE_COMMAND_STORE_DB_NAME}:local-storage`;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto?.randomUUID?.() ?? (`offline-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  }

  async init(): Promise<void> {
    this.readEnvelope();
  }

  async commitLocalChange<TCommand, TProjection>(
    input: OfflineCommandStoreWrite<TCommand, TProjection>,
  ): Promise<void> {
    const envelope = this.readEnvelope();
    assertOwnerConsistency(input);
    const projection = withSchemaVersion({
      ...input.projection,
      key: input.projection.key ?? projectionKey(input.ownerUserId, input.projection.entityType, input.projection.entityId),
    });
    const command = withSchemaVersion({
      ...input.command,
      key: input.command.key ?? commandKey(input.ownerUserId, input.command.operationId),
    });
    const audit = withSchemaVersion({
      ...input.audit,
      key: input.audit.key ?? auditKey(input.ownerUserId, input.audit.operationId),
    });
    const conflictEvidence = (input.conflictEvidence ?? []).map(item => withSchemaVersion({
      ...item,
      key: item.key ?? conflictEvidenceKey(input.ownerUserId, item.conflictId),
    }));
    const existingCommand = envelope.commands.find(item => item.key === command.key);
    if (existingCommand) assertOperationIdempotent(existingCommand, command);
    envelope.projections = envelope.projections.filter(item => item.key !== projection.key);
    envelope.commands = envelope.commands.filter(item => item.key !== command.key);
    envelope.audits = envelope.audits.filter(item => item.key !== audit.key);
    envelope.projections.push(projection as OfflineProjectionRecord);
    envelope.commands.push(command as OfflineCommandRecord);
    envelope.audits.push(audit);
    conflictEvidence.forEach(item => {
      envelope.conflictEvidence = envelope.conflictEvidence.filter(existing => existing.key !== item.key);
      envelope.conflictEvidence.push(item);
    });
    this.writeEnvelope(envelope);
  }

  async getProjection<TProjection>(ownerUserId: string, key: string): Promise<OfflineProjectionRecord<TProjection> | null> {
    const envelope = this.readEnvelope();
    return envelope.projections.find(item => item.ownerUserId === ownerUserId && item.key === key) as OfflineProjectionRecord<TProjection> | null ?? null;
  }

  async listProjections<TProjection>(ownerUserId: string): Promise<Array<OfflineProjectionRecord<TProjection>>> {
    return this.readEnvelope().projections.filter(item => item.ownerUserId === ownerUserId) as Array<OfflineProjectionRecord<TProjection>>;
  }

  async putProjection<TProjection>(record: Omit<OfflineProjectionRecord<TProjection>, 'schemaVersion'>): Promise<void> {
    if (!record.ownerUserId || !record.key.startsWith(`${record.ownerUserId}:projection:`)) {
      throw new Error('Offline projection owner mismatch');
    }
    const envelope = this.readEnvelope();
    envelope.projections = envelope.projections.filter(item => item.key !== record.key);
    envelope.projections.push(withSchemaVersion(record));
    this.writeEnvelope(envelope);
  }

  async listCommands<TCommand>(ownerUserId: string, status?: OfflineCommandStoreCommandStatus): Promise<Array<OfflineCommandRecord<TCommand>>> {
    const envelope = this.readEnvelope();
    return envelope.commands.filter(item => item.ownerUserId === ownerUserId && (!status || item.status === status)) as Array<OfflineCommandRecord<TCommand>>;
  }

  async updateReplayResult<TCommand>(update: OfflineCommandReplayUpdate): Promise<OfflineCommandRecord<TCommand> | null> {
    const envelope = this.readEnvelope();
    const index = envelope.commands.findIndex(item => item.ownerUserId === update.ownerUserId && item.operationId === update.operationId);
    if (index < 0) return null;
    const updated = applyReplayUpdate(envelope.commands[index] as OfflineCommandRecord<TCommand>, update, this.now());
    envelope.commands[index] = updated as OfflineCommandRecord<unknown>;
    const audit = envelope.audits.find(item => item.ownerUserId === update.ownerUserId && item.operationId === update.operationId);
    if (audit) {
      audit.queueResult = update.status;
      if (update.decision !== undefined) { audit.conflictDecision = update.decision; audit.remoteDecision = update.decision; }
      if (update.rawResponse !== undefined) audit.remoteResponse = update.rawResponse;
      if (update.serverUpdatedAt !== undefined) audit.serverUpdatedAt = update.serverUpdatedAt;
      if (update.lastSyncTimeEffect !== undefined) audit.lastSyncTimeEffect = update.lastSyncTimeEffect;
    }
    this.writeEnvelope(envelope);
    return updated;
  }

  async getAudit(ownerUserId: string, operationId: string): Promise<OfflineAuditRecord | null> {
    const envelope = this.readEnvelope();
    return envelope.audits.find(item => item.ownerUserId === ownerUserId && item.operationId === operationId) ?? null;
  }

  async quarantine(input: Omit<OfflineQuarantineRecord, 'key' | 'schemaVersion'> & { key?: string }): Promise<void> {
    const envelope = this.readEnvelope();
    const value = withSchemaVersion({
      ...input,
      key: input.key ?? quarantineKey(input.ownerUserId, this.idFactory),
    });
    envelope.quarantine = envelope.quarantine.filter(item => item.key !== value.key);
    envelope.quarantine.push(value);
    this.writeEnvelope(envelope);
  }

  async listConflictEvidence(ownerUserId: string): Promise<OfflineConflictEvidenceRecord[]> {
    return this.readEnvelope().conflictEvidence.filter(record => record.ownerUserId === ownerUserId);
  }

  async exportOwner<TCommand, TProjection>(ownerUserId: string): Promise<OfflineCommandStoreExport<TCommand, TProjection>> {
    const envelope = this.readEnvelope();
    return {
      schemaVersion: OFFLINE_COMMAND_STORE_SCHEMA_VERSION,
      ownerUserId,
      projections: envelope.projections.filter(item => item.ownerUserId === ownerUserId) as Array<OfflineProjectionRecord<TProjection>>,
      commands: envelope.commands.filter(item => item.ownerUserId === ownerUserId) as Array<OfflineCommandRecord<TCommand>>,
      audits: envelope.audits.filter(item => item.ownerUserId === ownerUserId),
      quarantine: envelope.quarantine.filter(item => isQuarantineVisibleToOwner(item, ownerUserId)),
      conflictEvidence: envelope.conflictEvidence.filter(item => item.ownerUserId === ownerUserId),
    };
  }

  async restoreOwner<TCommand, TProjection>(
    payload: OfflineCommandStoreExport<TCommand, TProjection>,
  ): Promise<void> {
    assertRestorePayload(payload);
    const envelope = this.readEnvelope();
    envelope.projections = envelope.projections.filter(item => item.ownerUserId !== payload.ownerUserId);
    envelope.commands = envelope.commands.filter(item => item.ownerUserId !== payload.ownerUserId);
    envelope.audits = envelope.audits.filter(item => item.ownerUserId !== payload.ownerUserId);
    envelope.quarantine = envelope.quarantine.filter(item => item.ownerUserId !== payload.ownerUserId);
    if (payload.conflictEvidence !== undefined) {
      envelope.conflictEvidence = envelope.conflictEvidence.filter(item => item.ownerUserId !== payload.ownerUserId);
    }
    envelope.projections.push(...payload.projections as OfflineProjectionRecord[]);
    envelope.commands.push(...payload.commands as OfflineCommandRecord[]);
    envelope.audits.push(...payload.audits);
    envelope.quarantine.push(...payload.quarantine);
    payload.conflictEvidence?.forEach(item => {
      envelope.conflictEvidence = envelope.conflictEvidence.filter(existing => existing.key !== item.key);
      envelope.conflictEvidence.push(item);
    });
    this.writeEnvelope(envelope);
  }

  private readEnvelope(): LocalStorageEnvelope {
    let raw: string | null;
    try {
      raw = this.storage?.getItem(this.storageKey) ?? null;
    } catch (error) {
      throw new Error('Offline command localStorage read failed; persisted evidence was not discarded', { cause: error });
    }
    if (!raw) return this.emptyEnvelope();

    let parsed: Partial<LocalStorageEnvelope>;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('envelope is not an object');
      }
      parsed = value as Partial<LocalStorageEnvelope>;
    } catch (error) {
      throw new Error('Offline command localStorage envelope is malformed; persisted evidence was retained', { cause: error });
    }

    if (parsed.schemaVersion !== OFFLINE_COMMAND_STORE_SCHEMA_VERSION) {
      throw new Error(`Offline command localStorage schema mismatch; expected ${OFFLINE_COMMAND_STORE_SCHEMA_VERSION}`);
    }
    const collections: Array<keyof LocalStorageEnvelope> = [
      'projections', 'commands', 'audits', 'quarantine', 'conflictEvidence',
    ];
    if (collections.some(key => !Array.isArray(parsed[key]))) {
      throw new Error('Offline command localStorage envelope is incomplete; persisted evidence was retained');
    }
    return {
      schemaVersion: OFFLINE_COMMAND_STORE_SCHEMA_VERSION,
      projections: parsed.projections as Array<OfflineProjectionRecord>,
      commands: parsed.commands as Array<OfflineCommandRecord>,
      audits: parsed.audits as Array<OfflineAuditRecord>,
      quarantine: parsed.quarantine as Array<OfflineQuarantineRecord>,
      conflictEvidence: parsed.conflictEvidence as Array<OfflineConflictEvidenceRecord>,
    };
  }

  private writeEnvelope(envelope: LocalStorageEnvelope): void {
    if (!this.storage) throw new Error('LocalStorage unavailable');
    const previousRaw = this.storage.getItem(this.storageKey);
    const nextRaw = JSON.stringify(envelope);
    try {
      this.storage.setItem(this.storageKey, nextRaw);
    } catch (error) {
      const retained = this.restorePreviousEnvelope(previousRaw);
      throw new Error(
        `Offline command localStorage write failed; previous envelope retained=${retained}`,
        { cause: error },
      );
    }
    let readback: string | null;
    try {
      readback = this.storage.getItem(this.storageKey);
    } catch (error) {
      const restored = this.restorePreviousEnvelope(previousRaw);
      throw new Error(
        `Offline command localStorage write readback failed; previous envelope restored=${restored}`,
        { cause: error },
      );
    }
    if (readback !== nextRaw) {
      const restored = this.restorePreviousEnvelope(previousRaw);
      throw new Error(
        `Offline command localStorage write readback mismatch; previous envelope restored=${restored}`,
      );
    }
  }

  private restorePreviousEnvelope(previousRaw: string | null): boolean {
    try {
      if (this.storage?.getItem(this.storageKey) === previousRaw) return true;
      if (previousRaw === null) {
        this.storage?.removeItem(this.storageKey);
      } else {
        this.storage?.setItem(this.storageKey, previousRaw);
      }
      return this.storage?.getItem(this.storageKey) === previousRaw;
    } catch {
      return false;
    }
  }

  private emptyEnvelope(): LocalStorageEnvelope {
    return {
      schemaVersion: OFFLINE_COMMAND_STORE_SCHEMA_VERSION,
      projections: [],
      commands: [],
      audits: [],
      quarantine: [],
      conflictEvidence: [],
    };
  }
}


function assertRestorePayload<TCommand, TProjection>(
  payload: OfflineCommandStoreExport<TCommand, TProjection>,
): void {
  if (payload.schemaVersion !== OFFLINE_COMMAND_STORE_SCHEMA_VERSION || payload.ownerUserId.length === 0) {
    throw new Error('Invalid offline command store restore payload');
  }
  const businessRecords = [
    ...payload.projections,
    ...payload.commands,
    ...payload.audits,
    ...(payload.conflictEvidence ?? []),
  ];
  if (businessRecords.some(record => record.ownerUserId !== payload.ownerUserId)) {
    throw new Error('Offline command store restore owner mismatch');
  }
  if (payload.quarantine.some(record => record.ownerUserId !== null
    && record.ownerUserId !== payload.ownerUserId)) {
    throw new Error('Offline command store restore quarantine owner mismatch');
  }
}

export function createOfflineCommandStore(options: OfflineCommandStoreOptions = {}): OfflineCommandStore {
  if (options.indexedDb || typeof indexedDB !== 'undefined') return new IndexedDbOfflineCommandStore(options);
  return new LocalStorageOfflineCommandStore(options);
}

export function createOfflineProjectionKey(ownerUserId: string, entityType: string, entityId: string): string {
  return projectionKey(ownerUserId, entityType, entityId);
}
