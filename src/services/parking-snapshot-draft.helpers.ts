import type {
  ParkingSnapshot,
  Task,
  TaskParkingMeta,
} from '../models';

type SnapshotDraftCursorPosition = ParkingSnapshot['cursorPosition'];
type SnapshotDraftStructuralAnchor = ParkingSnapshot['structuralAnchor'] | Record<string, unknown>;

export interface ParkingSnapshotDraft {
  taskId: string;
  contentHash: string;
  cursorPosition: SnapshotDraftCursorPosition;
  structuralAnchor: SnapshotDraftStructuralAnchor | null;
  savedAt: string;
}

export function buildParkingSnapshotDraft(
  focused: Task,
  savedAt: string = new Date().toISOString()
): ParkingSnapshotDraft | null {
  const snapshot = focused.parkingMeta?.contextSnapshot;
  if (!snapshot) {
    return null;
  }

  return {
    taskId: focused.id,
    contentHash: snapshot.contentHash,
    cursorPosition: snapshot.cursorPosition,
    structuralAnchor: snapshot.structuralAnchor,
    savedAt,
  };
}

export function parseParkingSnapshotDraft(raw: string | null): ParkingSnapshotDraft | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ParkingSnapshotDraft>;
    if (
      typeof parsed?.taskId !== 'string'
      || typeof parsed?.savedAt !== 'string'
      || typeof parsed?.contentHash !== 'string'
    ) {
      return null;
    }

    return {
      taskId: parsed.taskId,
      contentHash: parsed.contentHash,
      cursorPosition: parsed.cursorPosition ?? null,
      structuralAnchor: parsed.structuralAnchor ?? null,
      savedAt: parsed.savedAt,
    };
  } catch {
    // eslint-disable-next-line no-restricted-syntax -- localStorage 草稿损坏时无法恢复，null 表示忽略该草稿。
    return null;
  }
}

export function shouldRestoreParkingSnapshotDraft(
  task: Task | undefined,
  draft: ParkingSnapshotDraft
): task is Task & { parkingMeta: TaskParkingMeta } {
  if (!task?.parkingMeta) return false;

  const idbSavedAt = parseSnapshotSavedAt(task.parkingMeta.contextSnapshot?.savedAt);
  const draftSavedAt = parseSnapshotSavedAt(draft.savedAt);
  return draftSavedAt > idbSavedAt;
}

export function mergeParkingSnapshotDraft(
  existing: ParkingSnapshot | null | undefined,
  draft: ParkingSnapshotDraft
): ParkingSnapshot {
  return {
    savedAt: draft.savedAt,
    contentHash: draft.contentHash || existing?.contentHash || '',
    viewMode: existing?.viewMode ?? 'text',
    cursorPosition: draft.cursorPosition ?? existing?.cursorPosition ?? null,
    scrollAnchor: existing?.scrollAnchor ?? null,
    structuralAnchor: (draft.structuralAnchor ?? existing?.structuralAnchor ?? null) as ParkingSnapshot['structuralAnchor'],
    flowViewport: existing?.flowViewport ?? null,
  };
}

export function parseSnapshotSavedAt(value: string | null | undefined): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
}
