import type { Connection, Project, Task } from '../../../models';

export interface TaskStoreStateSnapshot {
  tasksMap: Map<string, Task>;
  tasksByProject: Map<string, Set<string>>;
  taskProjectMap: Map<string, string>;
  parkedTaskIds: Set<string>;
}

export interface ProjectStoreStateSnapshot {
  projectsMap: Map<string, Project>;
  activeProjectId: string | null;
}

export interface ConnectionStoreStateSnapshot {
  connectionsMap: Map<string, Connection>;
  connectionsByProject: Map<string, Set<string>>;
  connectionProjectMap: Map<string, string>;
}

export function cloneSetIndex(
  source: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  return new Map(Array.from(source, ([key, values]) => [key, new Set(values)]));
}

export function isSameRevision(
  a: { updatedAt?: string; deletedAt?: string | null } | undefined,
  b: { updatedAt?: string; deletedAt?: string | null } | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.updatedAt !== b.updatedAt || a.deletedAt !== b.deletedAt) return false;
  if (a === b) return true;

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return aKeys.length === bKeys.length
    && aKeys.every(key => Object.prototype.hasOwnProperty.call(bRecord, key)
      && Object.is(aRecord[key], bRecord[key]));
}

export function detachEntityFromPreviousProject(
  index: Map<string, Set<string>>,
  entityId: string,
  previousProjectId: string | undefined,
  nextProjectId: string,
): void {
  if (!previousProjectId || previousProjectId === nextProjectId) return;
  const previousIds = index.get(previousProjectId);
  previousIds?.delete(entityId);
  if (previousIds?.size === 0) index.delete(previousProjectId);
}

export function assertUniqueEntityIds<TEntry, TEntity extends { id: string }>(
  entries: readonly TEntry[],
  entities: (entry: TEntry) => readonly TEntity[],
  entityType: string,
): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    for (const entity of entities(entry)) {
      if (ids.has(entity.id)) throw new Error(`Duplicate ${entityType} id in multi-project replacement: ${entity.id}`);
      ids.add(entity.id);
    }
  }
}
