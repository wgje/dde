export interface FocusTaskSlotLike {
  slotId?: string;
  taskId?: string | null;
  sourceProjectId?: string | null;
  inlineTitle?: string | null;
  estimatedMinutes?: number | null;
  waitMinutes?: number | null;
  cognitiveLoad?: string | null;
  focusStatus?: string;
  zone?: string;
  zoneIndex?: number;
  isMaster?: boolean;
  [key: string]: unknown;
}

export interface DockEntryLike {
  taskId?: string | null;
  title?: string | null;
  sourceProjectId?: string | null;
  expectedMinutes?: number | null;
  waitMinutes?: number | null;
  load?: string | null;
  status?: string;
  lane?: string;
  isMain?: boolean;
  dockedOrder?: number;
  manualOrder?: number | null;
  [key: string]: unknown;
}

export interface FocusSessionStateLike {
  schemaVersion?: number;
  sessionId?: string;
  sessionStartedAt?: number;
  isActive?: boolean;
  isFocusOverlayOn?: boolean;
  commandCenterTasks?: FocusTaskSlotLike[];
  comboSelectTasks?: FocusTaskSlotLike[];
  backupTasks?: FocusTaskSlotLike[];
  [key: string]: unknown;
}

export interface DockSessionLike {
  mainTaskId?: string | null;
  comboSelectIds?: string[];
  backupIds?: string[];
  focusSessionId?: string;
  focusSessionStartedAt?: number;
  [key: string]: unknown;
}

export interface DockSnapshotLike {
  entries?: DockEntryLike[];
  focusMode?: boolean;
  session?: DockSessionLike;
  focusSessionState?: FocusSessionStateLike | null;
  savedAt?: string;
  [key: string]: unknown;
}

export type PromoteSecondaryResult =
  | {
      ok: true;
      snapshot: DockSnapshotLike;
      mainTaskId: string | null;
      comboSelectIds: string[];
      backupIds: string[];
    }
  | {
      ok: false;
      code: string;
      error: string;
    };

const COMBO_VISIBLE_LIMIT = 3;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompletedEntry(entry: DockEntryLike): boolean {
  return entry.status === 'completed';
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueIds(ids: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  for (const id of ids) {
    if (!isNonEmptyText(id)) continue;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function entryOrder(entry: DockEntryLike): number {
  return normalizeNumber(entry.manualOrder) ?? normalizeNumber(entry.dockedOrder) ?? Number.MAX_SAFE_INTEGER;
}

function sortEntriesByOrder(entries: DockEntryLike[]): DockEntryLike[] {
  return [...entries].sort((left, right) => {
    if (isCompletedEntry(left) && !isCompletedEntry(right)) return 1;
    if (isCompletedEntry(right) && !isCompletedEntry(left)) return -1;
    const orderDelta = entryOrder(left) - entryOrder(right);
    if (orderDelta !== 0) return orderDelta;
    return (taskIdOfEntry(left) ?? '').localeCompare(taskIdOfEntry(right) ?? '');
  });
}

function taskIdOfEntry(entry: DockEntryLike | undefined): string | null {
  return isNonEmptyText(entry?.taskId) ? entry.taskId : null;
}

function slotTaskIds(slots: FocusTaskSlotLike[] | undefined): string[] {
  if (!Array.isArray(slots)) return [];
  return uniqueIds(slots.map(slot => slot.taskId));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueIds(value.filter((item): item is string => typeof item === 'string'));
}

function activeEntries(snapshot: DockSnapshotLike): DockEntryLike[] {
  return Array.isArray(snapshot.entries)
    ? snapshot.entries.filter(entry => !isCompletedEntry(entry))
    : [];
}

function resolveMainTaskId(snapshot: DockSnapshotLike, active: DockEntryLike[]): string | null {
  const explicitMainTaskId = taskIdOfEntry(active.find(entry => entry.isMain === true));
  if (explicitMainTaskId) {
    return explicitMainTaskId;
  }

  const sessionMainTaskId = snapshot.session?.mainTaskId;
  if (isNonEmptyText(sessionMainTaskId) && active.some(entry => taskIdOfEntry(entry) === sessionMainTaskId)) {
    return sessionMainTaskId;
  }

  return taskIdOfEntry(active.find(entry => entry.status === 'focusing'));
}

function resolveSecondaryOrder(snapshot: DockSnapshotLike, activeSecondary: DockEntryLike[]): string[] {
  const activeSecondaryIds = new Set(uniqueIds(activeSecondary.map(entry => entry.taskId)));
  const existingState = isPlainObject(snapshot.focusSessionState) ? snapshot.focusSessionState : null;
  const orderedCandidates = uniqueIds([
    ...slotTaskIds(existingState?.comboSelectTasks),
    ...slotTaskIds(existingState?.backupTasks),
    ...stringArray(snapshot.session?.comboSelectIds),
    ...stringArray(snapshot.session?.backupIds),
    ...activeSecondary
      .slice()
      .sort((left, right) => {
        const orderDelta = entryOrder(left) - entryOrder(right);
        if (orderDelta !== 0) return orderDelta;
        return (taskIdOfEntry(left) ?? '').localeCompare(taskIdOfEntry(right) ?? '');
      })
      .map(entry => entry.taskId),
  ]);

  return orderedCandidates.filter(id => activeSecondaryIds.has(id));
}

function collectExistingSlots(state: FocusSessionStateLike | null): Map<string, FocusTaskSlotLike> {
  const slots = [
    ...(state?.commandCenterTasks ?? []),
    ...(state?.comboSelectTasks ?? []),
    ...(state?.backupTasks ?? []),
  ];
  const result = new Map<string, FocusTaskSlotLike>();
  for (const slot of slots) {
    const taskId = isNonEmptyText(slot.taskId) ? slot.taskId : null;
    if (taskId && !result.has(taskId)) {
      result.set(taskId, slot);
    }
  }
  return result;
}

function buildSlot(
  taskId: string,
  zone: 'command' | 'combo-select' | 'backup',
  zoneIndex: number,
  isMaster: boolean,
  slotByTaskId: Map<string, FocusTaskSlotLike>,
  entryByTaskId: Map<string, DockEntryLike>,
): FocusTaskSlotLike {
  const base = slotByTaskId.get(taskId) ?? {};
  const entry = entryByTaskId.get(taskId);
  return {
    ...base,
    slotId: isNonEmptyText(base.slotId) ? base.slotId : taskId,
    taskId,
    sourceProjectId: base.sourceProjectId ?? entry?.sourceProjectId ?? null,
    inlineTitle: base.inlineTitle ?? entry?.title ?? null,
    estimatedMinutes: base.estimatedMinutes ?? entry?.expectedMinutes ?? null,
    waitMinutes: base.waitMinutes ?? entry?.waitMinutes ?? null,
    cognitiveLoad: base.cognitiveLoad ?? entry?.load ?? null,
    focusStatus: typeof base.focusStatus === 'string' ? base.focusStatus : entry?.status,
    zone,
    zoneIndex,
    isMaster,
  };
}

export function promoteSecondaryTaskToC2(
  snapshot: unknown,
  targetTaskId: string,
  savedAtIso: string,
): PromoteSecondaryResult {
  if (!isPlainObject(snapshot)) {
    return { ok: false, code: 'INVALID_SESSION_STATE', error: 'focus session snapshot must be an object' };
  }

  const dockSnapshot = snapshot as DockSnapshotLike;
  const existingFocusState = isPlainObject(dockSnapshot.focusSessionState)
    ? dockSnapshot.focusSessionState
    : null;
  if (dockSnapshot.focusMode !== true && existingFocusState?.isActive !== true) {
    return { ok: false, code: 'FOCUS_INACTIVE', error: 'focus session is not active' };
  }

  const active = activeEntries(dockSnapshot);
  const mainTaskId = resolveMainTaskId(dockSnapshot, active);
  if (mainTaskId === targetTaskId) {
    return { ok: false, code: 'MAIN_TASK_FIXED', error: 'main task cannot be reordered by widget' };
  }

  const activeSecondary = active.filter(entry => {
    const taskId = taskIdOfEntry(entry);
    return taskId !== null && taskId !== mainTaskId && entry.isMain !== true;
  });
  if (!activeSecondary.some(entry => taskIdOfEntry(entry) === targetTaskId)) {
    return { ok: false, code: 'SECONDARY_TASK_NOT_FOUND', error: 'secondary task is not in the active focus session' };
  }

  const previousOrder = resolveSecondaryOrder(dockSnapshot, activeSecondary);
  const nextSecondaryIds = uniqueIds([
    targetTaskId,
    ...previousOrder.filter(taskId => taskId !== targetTaskId),
  ]);
  const comboSelectIds = nextSecondaryIds.slice(0, COMBO_VISIBLE_LIMIT);
  const backupIds = nextSecondaryIds.slice(COMBO_VISIBLE_LIMIT);
  const secondaryOrder = new Map(nextSecondaryIds.map((taskId, index) => [taskId, index]));

  const nextEntries = Array.isArray(dockSnapshot.entries)
    ? dockSnapshot.entries.map(entry => {
        const taskId = taskIdOfEntry(entry);
        if (!taskId || isCompletedEntry(entry)) {
          return entry;
        }
        if (taskId === mainTaskId) {
          return {
            ...entry,
            lane: 'combo-select',
            isMain: true,
            dockedOrder: 0,
            manualOrder: 0,
          };
        }
        if (!secondaryOrder.has(taskId)) {
          return entry.isMain === true ? { ...entry, isMain: false } : entry;
        }
        const index = secondaryOrder.get(taskId)!;
        return {
          ...entry,
          lane: index < COMBO_VISIBLE_LIMIT ? 'combo-select' : 'backup',
          isMain: false,
          dockedOrder: index + 1,
          manualOrder: index + 1,
        };
      })
    : [];
  const orderedEntries = sortEntriesByOrder(nextEntries);

  const entryByTaskId = new Map<string, DockEntryLike>();
  for (const entry of orderedEntries) {
    const taskId = taskIdOfEntry(entry);
    if (taskId) entryByTaskId.set(taskId, entry);
  }

  const slotByTaskId = collectExistingSlots(existingFocusState);
  const commandCenterTasks = active
    .filter(entry => {
      const taskId = taskIdOfEntry(entry);
      return taskId !== null && (entry.isMain === true || taskId === mainTaskId);
    })
    .map((entry, index) => buildSlot(taskIdOfEntry(entry)!, 'command', index, true, slotByTaskId, entryByTaskId));
  const comboSelectTasks = comboSelectIds.map((taskId, index) =>
    buildSlot(taskId, 'combo-select', index, false, slotByTaskId, entryByTaskId),
  );
  const backupTasks = backupIds.map((taskId, index) =>
    buildSlot(taskId, 'backup', index, false, slotByTaskId, entryByTaskId),
  );

  const sessionId = existingFocusState?.sessionId ?? dockSnapshot.session?.focusSessionId;
  const sessionStartedAt = existingFocusState?.sessionStartedAt ?? dockSnapshot.session?.focusSessionStartedAt;

  return {
    ok: true,
    snapshot: {
      ...dockSnapshot,
      entries: orderedEntries,
      focusMode: true,
      session: {
        ...(dockSnapshot.session ?? {}),
        mainTaskId,
        comboSelectIds,
        backupIds,
        ...(sessionId ? { focusSessionId: sessionId } : {}),
        ...(typeof sessionStartedAt === 'number' ? { focusSessionStartedAt: sessionStartedAt } : {}),
      },
      focusSessionState: {
        ...(existingFocusState ?? {}),
        schemaVersion: 2,
        ...(sessionId ? { sessionId } : {}),
        ...(typeof sessionStartedAt === 'number' ? { sessionStartedAt } : {}),
        isActive: true,
        isFocusOverlayOn: existingFocusState?.isFocusOverlayOn ?? true,
        commandCenterTasks,
        comboSelectTasks,
        backupTasks,
      },
      savedAt: savedAtIso,
    },
    mainTaskId,
    comboSelectIds,
    backupIds,
  };
}
