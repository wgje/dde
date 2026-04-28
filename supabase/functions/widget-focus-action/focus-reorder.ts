export interface FocusTaskSlotLike {
  slotId?: string;
  taskId?: string | null;
  sourceProjectId?: string | null;
  inlineTitle?: string | null;
  estimatedMinutes?: number | null;
  waitMinutes?: number | null;
  waitStartedAt?: string | null;
  waitEndAt?: string | null;
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
  waitStartedAt?: string | null;
  waitEndAt?: string | null;
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
  commandCenterOrderIds?: string[];
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

type FocusActionError = {
  ok: false;
  code: string;
  error: string;
};

export type PromoteSecondaryResult =
  | {
      ok: true;
      snapshot: DockSnapshotLike;
      mainTaskId: string | null;
      comboSelectIds: string[];
      backupIds: string[];
    }
  | FocusActionError;

export type FrontTaskActionResult =
  | {
      ok: true;
      snapshot: DockSnapshotLike;
      completedTaskId?: string;
      suspendedTaskId?: string;
      waitEndAt?: string;
      mainTaskId: string | null;
      comboSelectIds: string[];
      backupIds: string[];
    }
  | FocusActionError;

const COMBO_VISIBLE_LIMIT = 3;
const CONSOLE_VISIBLE_LIMIT = 4;

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

function normalizeIsoText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : value;
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

function mapDockStatusToFocusStatus(status: string | undefined): string | undefined {
  switch (status) {
    case 'focusing': return 'focusing';
    case 'suspended_waiting': return 'suspend-waiting';
    case 'wait_finished': return 'wait-ended';
    case 'stalled': return 'stalled';
    case 'completed': return 'completed';
    case 'pending_start': return 'pending';
    default: return status;
  }
}

function addMinutesIso(baseIso: string, minutes: number): string {
  return new Date(new Date(baseIso).getTime() + minutes * 60_000).toISOString();
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

function isConsoleVisibleCandidate(entry: DockEntryLike): boolean {
  return entry.isMain === true
    || entry.status === 'focusing'
    || entry.lane === 'combo-select';
}

function resolveVisibleOrder(snapshot: DockSnapshotLike, active: DockEntryLike[]): string[] {
  const fromState = isPlainObject(snapshot.focusSessionState)
    ? stringArray(snapshot.focusSessionState.commandCenterOrderIds)
    : [];
  const activeIds = new Set(uniqueIds(active.map(entry => taskIdOfEntry(entry))));
  if (fromState.length > 0) {
    return fromState.filter(taskId => activeIds.has(taskId)).slice(0, CONSOLE_VISIBLE_LIMIT);
  }

  return active
    .filter(isConsoleVisibleCandidate)
    .slice()
    .sort((left, right) => {
      if (left.status === 'focusing' && right.status !== 'focusing') return -1;
      if (right.status === 'focusing' && left.status !== 'focusing') return 1;
      const orderDelta = entryOrder(left) - entryOrder(right);
      if (orderDelta !== 0) return orderDelta;
      return (taskIdOfEntry(left) ?? '').localeCompare(taskIdOfEntry(right) ?? '');
    })
    .map(entry => taskIdOfEntry(entry))
    .filter((taskId): taskId is string => taskId !== null)
    .slice(0, CONSOLE_VISIBLE_LIMIT);
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
    waitMinutes: normalizeNumber(entry?.waitMinutes) ?? normalizeNumber(base.waitMinutes),
    waitStartedAt: normalizeIsoText(entry?.waitStartedAt) ?? normalizeIsoText(base.waitStartedAt),
    waitEndAt: normalizeIsoText(entry?.waitEndAt) ?? normalizeIsoText(base.waitEndAt),
    cognitiveLoad: base.cognitiveLoad ?? entry?.load ?? null,
    focusStatus: mapDockStatusToFocusStatus(entry?.status) ?? base.focusStatus,
    zone,
    zoneIndex,
    isMaster,
  };
}

function inactiveError(): FocusActionError {
  return { ok: false, code: 'FOCUS_INACTIVE', error: 'focus session is not active' };
}

function normalizeFrontActionInput(snapshot: unknown): {
  ok: true;
  dockSnapshot: DockSnapshotLike;
  existingFocusState: FocusSessionStateLike | null;
  active: DockEntryLike[];
  visibleOrder: string[];
  mainTaskId: string | null;
} | FocusActionError {
  if (!isPlainObject(snapshot)) {
    return { ok: false, code: 'INVALID_SESSION_STATE', error: 'focus session snapshot must be an object' };
  }

  const dockSnapshot = snapshot as DockSnapshotLike;
  const existingFocusState = isPlainObject(dockSnapshot.focusSessionState)
    ? dockSnapshot.focusSessionState
    : null;
  if (dockSnapshot.focusMode !== true && existingFocusState?.isActive !== true) {
    return inactiveError();
  }

  const active = activeEntries(dockSnapshot);
  const visibleOrder = resolveVisibleOrder(dockSnapshot, active);
  const mainTaskId = resolveMainTaskId(dockSnapshot, active);
  return { ok: true, dockSnapshot, existingFocusState, active, visibleOrder, mainTaskId };
}

function buildFocusActionSnapshot(
  dockSnapshot: DockSnapshotLike,
  existingFocusState: FocusSessionStateLike | null,
  nextEntries: DockEntryLike[],
  nextVisibleOrder: string[],
  mainTaskId: string | null,
  savedAtIso: string,
): {
  snapshot: DockSnapshotLike;
  comboSelectIds: string[];
  backupIds: string[];
  mainTaskId: string | null;
} {
  const active = nextEntries.filter(entry => !isCompletedEntry(entry));
  if (active.length === 0) {
    return {
      snapshot: {
        ...dockSnapshot,
        entries: sortEntriesByOrder(nextEntries),
        focusMode: false,
        session: {
          ...(dockSnapshot.session ?? {}),
          mainTaskId: null,
          comboSelectIds: [],
          backupIds: [],
        },
        focusSessionState: null,
        savedAt: savedAtIso,
      },
      comboSelectIds: [],
      backupIds: [],
      mainTaskId: null,
    };
  }

  const activeTaskIds = new Set(uniqueIds(active.map(entry => taskIdOfEntry(entry))));
  const normalizedVisibleOrder = uniqueIds(nextVisibleOrder)
    .filter(taskId => activeTaskIds.has(taskId))
    .slice(0, CONSOLE_VISIBLE_LIMIT);
  const activeSecondary = active.filter(entry => {
    const taskId = taskIdOfEntry(entry);
    return taskId !== null && taskId !== mainTaskId && entry.isMain !== true;
  });
  const previousSecondaryOrder = resolveSecondaryOrder(dockSnapshot, activeSecondary);
  const visibleSecondaryIds = normalizedVisibleOrder.filter(taskId => taskId !== mainTaskId);
  const comboSelectIds = visibleSecondaryIds.slice(0, COMBO_VISIBLE_LIMIT);
  const backupIds = uniqueIds(previousSecondaryOrder)
    .filter(taskId => taskId !== mainTaskId && !comboSelectIds.includes(taskId));
  const visibleOrderIndex = new Map(normalizedVisibleOrder.map((taskId, index) => [taskId, index]));
  const backupOrder = new Map(backupIds.map((taskId, index) => [taskId, index]));

  const normalizedEntries = nextEntries.map(entry => {
    const taskId = taskIdOfEntry(entry);
    if (!taskId || isCompletedEntry(entry)) {
      return entry;
    }
    if (visibleOrderIndex.has(taskId)) {
      const visibleIndex = visibleOrderIndex.get(taskId)!;
      return {
        ...entry,
        lane: 'combo-select',
        isMain: taskId === mainTaskId,
        dockedOrder: visibleIndex,
        manualOrder: visibleIndex,
      };
    }
    if (backupOrder.has(taskId)) {
      const index = backupOrder.get(taskId)!;
      return {
        ...entry,
        lane: 'backup',
        isMain: false,
        dockedOrder: normalizedVisibleOrder.length + index,
        manualOrder: normalizedVisibleOrder.length + index,
        status: entry.status === 'focusing' ? 'stalled' : entry.status,
      };
    }
    return entry.isMain === true ? { ...entry, isMain: false } : entry;
  });
  const orderedEntries = sortEntriesByOrder(normalizedEntries);

  const entryByTaskId = new Map<string, DockEntryLike>();
  for (const entry of orderedEntries) {
    const taskId = taskIdOfEntry(entry);
    if (taskId) entryByTaskId.set(taskId, entry);
  }

  const slotByTaskId = collectExistingSlots(existingFocusState);
  const commandCenterTasks = mainTaskId
    ? [buildSlot(mainTaskId, 'command', 0, true, slotByTaskId, entryByTaskId)]
    : [];
  const comboSelectTasks = comboSelectIds.map((taskId, index) =>
    buildSlot(taskId, 'combo-select', index, false, slotByTaskId, entryByTaskId),
  );
  const backupTasks = backupIds.map((taskId, index) =>
    buildSlot(taskId, 'backup', index, false, slotByTaskId, entryByTaskId),
  );
  const sessionId = existingFocusState?.sessionId ?? dockSnapshot.session?.focusSessionId;
  const sessionStartedAt = existingFocusState?.sessionStartedAt ?? dockSnapshot.session?.focusSessionStartedAt;

  return {
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
        commandCenterOrderIds: normalizedVisibleOrder,
        commandCenterTasks,
        comboSelectTasks,
        backupTasks,
      },
      savedAt: savedAtIso,
    },
    comboSelectIds,
    backupIds,
    mainTaskId,
  };
}

export function completeFrontTask(
  snapshot: unknown,
  expectedTaskId: string | null | undefined,
  savedAtIso: string,
): FrontTaskActionResult {
  const input = normalizeFrontActionInput(snapshot);
  if (!input.ok) return input;

  const currentFrontTaskId = input.visibleOrder[0] ?? null;
  if (!currentFrontTaskId) {
    return { ok: false, code: 'FOCUS_TARGET_NOT_FOUND', error: 'no front task in the command center' };
  }
  if (expectedTaskId && expectedTaskId !== currentFrontTaskId) {
    return { ok: false, code: 'FOCUS_TARGET_CHANGED', error: 'front task changed before action was applied' };
  }

  const targetEntry = input.active.find(entry => taskIdOfEntry(entry) === currentFrontTaskId) ?? null;
  if (!targetEntry) {
    return { ok: false, code: 'FOCUS_TARGET_NOT_FOUND', error: 'front task is not in the active dock' };
  }

  const targetWasMain = targetEntry.isMain === true || currentFrontTaskId === input.mainTaskId;
  const nextVisibleOrder = input.visibleOrder.filter(taskId => taskId !== currentFrontTaskId);
  const nextMainTaskId = targetWasMain
    ? (nextVisibleOrder[0] ?? null)
    : input.mainTaskId;

  const nextEntries = Array.isArray(input.dockSnapshot.entries)
    ? input.dockSnapshot.entries.map(entry => {
        const taskId = taskIdOfEntry(entry);
        if (taskId === currentFrontTaskId) {
          return {
            ...entry,
            status: 'completed',
            isMain: false,
            waitMinutes: null,
            waitStartedAt: null,
            waitEndAt: null,
          };
        }
        if (!taskId || isCompletedEntry(entry)) return entry;
        if (taskId === nextVisibleOrder[0]) {
          return {
            ...entry,
            status: 'focusing',
            isMain: taskId === nextMainTaskId,
            waitMinutes: null,
            waitStartedAt: null,
            waitEndAt: null,
          };
        }
        return {
          ...entry,
          isMain: taskId === nextMainTaskId,
          status: entry.status === 'focusing' ? 'stalled' : entry.status,
        };
      })
    : [];

  const rebuilt = buildFocusActionSnapshot(
    input.dockSnapshot,
    input.existingFocusState,
    nextEntries,
    nextVisibleOrder,
    nextMainTaskId,
    savedAtIso,
  );

  return {
    ok: true,
    snapshot: rebuilt.snapshot,
    completedTaskId: currentFrontTaskId,
    mainTaskId: rebuilt.mainTaskId,
    comboSelectIds: rebuilt.comboSelectIds,
    backupIds: rebuilt.backupIds,
  };
}

export function suspendFrontTask(
  snapshot: unknown,
  expectedTaskId: string | null | undefined,
  waitMinutes: number,
  savedAtIso: string,
): FrontTaskActionResult {
  const normalizedWaitMinutes = Math.floor(waitMinutes);
  if (!Number.isFinite(normalizedWaitMinutes) || normalizedWaitMinutes <= 0) {
    return { ok: false, code: 'INVALID_WAIT_MINUTES', error: 'waitMinutes must be a positive integer' };
  }

  const input = normalizeFrontActionInput(snapshot);
  if (!input.ok) return input;

  const currentFrontTaskId = input.visibleOrder[0] ?? null;
  if (!currentFrontTaskId) {
    return { ok: false, code: 'FOCUS_TARGET_NOT_FOUND', error: 'no front task in the command center' };
  }
  if (expectedTaskId && expectedTaskId !== currentFrontTaskId) {
    return { ok: false, code: 'FOCUS_TARGET_CHANGED', error: 'front task changed before action was applied' };
  }

  const targetEntry = input.active.find(entry => taskIdOfEntry(entry) === currentFrontTaskId) ?? null;
  if (!targetEntry) {
    return { ok: false, code: 'FOCUS_TARGET_NOT_FOUND', error: 'front task is not in the active dock' };
  }

  const waitEndAt = addMinutesIso(savedAtIso, normalizedWaitMinutes);
  const nextVisibleOrder = uniqueIds([
    ...input.visibleOrder.filter(taskId => taskId !== currentFrontTaskId),
    currentFrontTaskId,
  ]).slice(0, CONSOLE_VISIBLE_LIMIT);
  const nextFocusTaskId = nextVisibleOrder.find(taskId => taskId !== currentFrontTaskId) ?? null;

  const nextEntries = Array.isArray(input.dockSnapshot.entries)
    ? input.dockSnapshot.entries.map(entry => {
        const taskId = taskIdOfEntry(entry);
        if (taskId === currentFrontTaskId) {
          return {
            ...entry,
            status: 'suspended_waiting',
            waitMinutes: normalizedWaitMinutes,
            waitStartedAt: savedAtIso,
            waitEndAt,
            isMain: entry.isMain === true,
            systemSelected: false,
          };
        }
        if (!taskId || isCompletedEntry(entry)) return entry;
        if (taskId === nextFocusTaskId) {
          return {
            ...entry,
            status: 'focusing',
            waitMinutes: null,
            waitStartedAt: null,
            waitEndAt: null,
          };
        }
        return {
          ...entry,
          status: entry.status === 'focusing' ? 'stalled' : entry.status,
        };
      })
    : [];

  const rebuilt = buildFocusActionSnapshot(
    input.dockSnapshot,
    input.existingFocusState,
    nextEntries,
    nextVisibleOrder,
    input.mainTaskId,
    savedAtIso,
  );

  return {
    ok: true,
    snapshot: rebuilt.snapshot,
    suspendedTaskId: currentFrontTaskId,
    waitEndAt,
    mainTaskId: rebuilt.mainTaskId,
    comboSelectIds: rebuilt.comboSelectIds,
    backupIds: rebuilt.backupIds,
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
  const visibleOrder = resolveVisibleOrder(dockSnapshot, active);
  const targetEntry = active.find(entry => taskIdOfEntry(entry) === targetTaskId) ?? null;
  const targetAlreadyVisible = visibleOrder.includes(targetTaskId);
  const currentFrontTaskId = visibleOrder[0] ?? null;
  if (currentFrontTaskId === targetTaskId) {
    return { ok: false, code: 'ALREADY_FRONT', error: 'task is already at the front of the command center' };
  }

  // 允许把备选区任务直接提入 C 位 #1。只要任务仍处于活跃停泊状态，就应参与换位。
  if (!targetEntry) {
    return { ok: false, code: 'SECONDARY_TASK_NOT_FOUND', error: 'task is not in the active dock' };
  }

  const activeSecondary = active.filter(entry => {
    const taskId = taskIdOfEntry(entry);
    return taskId !== null && taskId !== mainTaskId && entry.isMain !== true;
  });

  const previousOrder = resolveSecondaryOrder(dockSnapshot, activeSecondary);
  let nextVisibleOrder = uniqueIds([
    targetTaskId,
    ...visibleOrder.filter(taskId => taskId !== targetTaskId),
  ]);
  // 主任务归属不随前台换位改变；若主任务当前仍在可见 C 位中，则隐藏备选提位时要保住它。
  if (
    !targetAlreadyVisible
    && mainTaskId
    && visibleOrder.includes(mainTaskId)
    && nextVisibleOrder.length > CONSOLE_VISIBLE_LIMIT
    && !nextVisibleOrder.slice(0, CONSOLE_VISIBLE_LIMIT).includes(mainTaskId)
  ) {
    const evictedVisibleTaskId = [...visibleOrder].reverse().find(taskId => taskId !== mainTaskId) ?? null;
    nextVisibleOrder = uniqueIds([
      targetTaskId,
      ...visibleOrder.filter(taskId => taskId !== targetTaskId && taskId !== evictedVisibleTaskId),
    ]);
  }
  nextVisibleOrder = nextVisibleOrder.slice(0, CONSOLE_VISIBLE_LIMIT);
  const visibleSecondaryIds = nextVisibleOrder.filter(taskId => taskId !== mainTaskId);
  const comboSelectIds = visibleSecondaryIds.slice(0, COMBO_VISIBLE_LIMIT);
  const backupIds = uniqueIds(previousOrder.filter(taskId => !comboSelectIds.includes(taskId)));
  const backupOrder = new Map(backupIds.map((taskId, index) => [taskId, index]));
  const visibleOrderIndex = new Map(nextVisibleOrder.map((taskId, index) => [taskId, index]));

  const nextEntries = Array.isArray(dockSnapshot.entries)
    ? dockSnapshot.entries.map(entry => {
        const taskId = taskIdOfEntry(entry);
        if (!taskId || isCompletedEntry(entry)) {
          return entry;
        }
        if (visibleOrderIndex.has(taskId)) {
          const visibleIndex = visibleOrderIndex.get(taskId)!;
          return {
            ...entry,
            lane: 'combo-select',
            isMain: taskId === mainTaskId,
            dockedOrder: visibleIndex,
            manualOrder: visibleIndex,
            status: taskId === targetTaskId
              ? 'focusing'
              : entry.status === 'focusing'
                ? 'stalled'
                : entry.status,
          };
        }
        if (!backupOrder.has(taskId)) {
          return entry.isMain === true ? { ...entry, isMain: false } : entry;
        }
        const index = backupOrder.get(taskId)!;
        return {
          ...entry,
          lane: 'backup',
          isMain: false,
          dockedOrder: nextVisibleOrder.length + index,
          manualOrder: nextVisibleOrder.length + index,
          status: entry.status === 'focusing' ? 'stalled' : entry.status,
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
  const commandCenterTasks = mainTaskId
    ? [buildSlot(mainTaskId, 'command', 0, true, slotByTaskId, entryByTaskId)]
    : [];
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
        commandCenterOrderIds: nextVisibleOrder,
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
