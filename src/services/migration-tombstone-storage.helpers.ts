export type TombstoneRecord = Record<string, Set<string>>;

export function parseTombstoneRecord(raw: string | null): TombstoneRecord {
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const result: TombstoneRecord = {};
  for (const [projectId, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      result[projectId] = new Set(value.filter((v): v is string => typeof v === 'string'));
      continue;
    }
    if (value && typeof value === 'object') {
      result[projectId] = new Set(Object.keys(value));
    }
  }
  return result;
}

export function mergeTombstoneRecord(target: TombstoneRecord, source: TombstoneRecord): number {
  let migratedCount = 0;
  for (const [projectId, taskIds] of Object.entries(source)) {
    const existing = target[projectId] ?? new Set<string>();
    migratedCount += addTombstoneIds(existing, taskIds);
    target[projectId] = existing;
  }
  return migratedCount;
}

export function serializeTombstoneRecord(record: TombstoneRecord): Record<string, string[]> {
  const serializable: Record<string, string[]> = {};
  for (const [projectId, ids] of Object.entries(record)) {
    serializable[projectId] = Array.from(ids);
  }
  return serializable;
}

function addTombstoneIds(existing: Set<string>, taskIds: Set<string>): number {
  let addedCount = 0;
  for (const taskId of taskIds) {
    const before = existing.size;
    existing.add(taskId);
    if (existing.size > before) {
      addedCount++;
    }
  }
  return addedCount;
}
