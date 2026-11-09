type TaskParkingMeta = import('../models/parking').TaskParkingMeta;
type ParkingContextSnapshot = TaskParkingMeta['contextSnapshot'];
type ParkingScrollAnchor = import('../models/parking').ParkingScrollAnchor;
type ParkingStructuralAnchor = import('../models/parking').ParkingStructuralAnchor;
type ParkingFlowViewport = import('../models/parking').ParkingFlowViewport;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/** 校验并清理停泊元数据，确保结构合法 */
export function sanitizeParkingMeta(value: unknown): TaskParkingMeta | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (value.state !== 'focused' && value.state !== 'parked') return undefined;
  return {
    state: value.state,
    parkedAt: typeof value.parkedAt === 'string' ? value.parkedAt : null,
    lastVisitedAt: typeof value.lastVisitedAt === 'string' ? value.lastVisitedAt : null,
    // H-9 fix: 结构校验嵌套对象，防止空对象通过后导致下游 NaN/崩溃
    contextSnapshot: sanitizeContextSnapshot(value.contextSnapshot),
    reminder: sanitizeReminder(value.reminder),
    pinned: typeof value.pinned === 'boolean' ? value.pinned : false,
  };
}

function sanitizeCursorPosition(value: unknown): { line: number; column: number } | null {
  if (!isRecord(value)) {
    return null;
  }

  return typeof value.line === 'number' && typeof value.column === 'number'
    ? { line: value.line, column: value.column }
    : null;
}

function sanitizeScrollAnchor(value: unknown): ParkingScrollAnchor | null {
  if (!isRecord(value) || typeof value.scrollPercent !== 'number') {
    return null;
  }

  return {
    anchorType: value.anchorType === 'heading' || value.anchorType === 'line' ? value.anchorType : 'line',
    anchorIndex: typeof value.anchorIndex === 'number' ? value.anchorIndex : 0,
    scrollPercent: value.scrollPercent,
    ...(typeof value.anchorOffset === 'number' ? { anchorOffset: value.anchorOffset } : {}),
  };
}

function sanitizeStructuralAnchor(value: unknown): ParkingStructuralAnchor | null {
  if (!isRecord(value)) {
    return null;
  }

  const validTypes = ['heading', 'gojs-node', 'line', 'fallback'] as const;
  const type = validTypes.includes(value.type as typeof validTypes[number])
    ? value.type as typeof validTypes[number]
    : 'fallback';

  return {
    type,
    label: typeof value.label === 'string' ? value.label : '',
    ...(typeof value.line === 'number' ? { line: value.line } : {}),
  };
}

function sanitizeFlowViewport(value: unknown): ParkingFlowViewport | null {
  if (!isRecord(value) || typeof value.scale !== 'number') {
    return null;
  }

  return {
    scale: value.scale,
    selectedNodeId: typeof value.selectedNodeId === 'string' ? value.selectedNodeId : null,
  };
}

/** H-9: 校验 contextSnapshot 嵌套字段 */
function sanitizeContextSnapshot(value: unknown): ParkingContextSnapshot {
  if (!isRecord(value)) return null;
  if (typeof value.savedAt !== 'string' && typeof value.savedAt !== 'number') return null;

  return {
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : String(value.savedAt),
    contentHash: typeof value.contentHash === 'string' ? value.contentHash : '',
    viewMode: value.viewMode === 'flow' || value.viewMode === 'text' ? value.viewMode : 'text',
    cursorPosition: sanitizeCursorPosition(value.cursorPosition),
    scrollAnchor: sanitizeScrollAnchor(value.scrollAnchor),
    structuralAnchor: sanitizeStructuralAnchor(value.structuralAnchor),
    flowViewport: sanitizeFlowViewport(value.flowViewport),
  };
}

/** H-9: 校验 reminder 嵌套字段 */
function sanitizeReminder(value: unknown): TaskParkingMeta['reminder'] {
  if (!isRecord(value) || typeof value.reminderAt !== 'string') return null;
  return {
    reminderAt: value.reminderAt,
    snoozeCount: typeof value.snoozeCount === 'number' ? value.snoozeCount : 0,
    maxSnoozeCount: typeof value.maxSnoozeCount === 'number' ? value.maxSnoozeCount : 3,
  } as TaskParkingMeta['reminder'];
}
