import type { Connection, Task } from '../../../../models';
import type { ConnectionRow, TaskRow } from '../../../../models/supabase-types';
import type { ProjectSyncCursor } from '../../state/persistence';
import {
  computeProjectSyncCursor,
  dedupeConnectionsByLatest,
  dedupeTasksByLatest,
  isProjectRowAfterCursor,
} from './sync-delta-projection';
import type { ProjectDeltaDrift } from './project-sync-cursor.service';

export interface ProjectDeltaWindow {
  effectiveSince: string;
  lookbackMs: number;
}

export interface BuildProjectDeltaDriftOptions {
  taskRows: TaskRow[];
  connectionRows: ConnectionRow[];
  lastCursor: ProjectSyncCursor | null;
  rowToTask: (row: TaskRow) => Task;
  rowToConnection: (row: ConnectionRow) => Connection;
}

export function createEmptyProjectDeltaDrift(): ProjectDeltaDrift {
  return { tasks: [], connections: [], nextCursor: null };
}

export function resolveProjectDeltaWindow(
  lastSyncTime: string,
  currentDriftMs: number,
  safetyLookbackMs: number,
): ProjectDeltaWindow {
  const lookbackMs = Math.max(safetyLookbackMs, Math.abs(currentDriftMs));
  const sinceMs = new Date(lastSyncTime).getTime() - lookbackMs;

  return {
    lookbackMs,
    effectiveSince: new Date(Math.max(0, sinceMs)).toISOString(),
  };
}

export function buildProjectDeltaDrift(
  options: BuildProjectDeltaDriftOptions,
): ProjectDeltaDrift {
  const taskRows = filterTaskRowsAfterCursor(options.taskRows, options.lastCursor);
  const connectionRows = filterConnectionRowsAfterCursor(
    options.connectionRows,
    options.lastCursor,
  );

  return {
    tasks: dedupeTasksByLatest(taskRows.map(options.rowToTask)),
    connections: dedupeConnectionsByLatest(connectionRows.map(options.rowToConnection)),
    nextCursor: computeProjectSyncCursor(taskRows, connectionRows),
  };
}

function filterTaskRowsAfterCursor(
  taskRows: TaskRow[],
  lastCursor: ProjectSyncCursor | null,
): TaskRow[] {
  return taskRows.filter((row) => (
    isProjectRowAfterCursor('task', row.id, row.updated_at, lastCursor)
  ));
}

function filterConnectionRowsAfterCursor(
  connectionRows: ConnectionRow[],
  lastCursor: ProjectSyncCursor | null,
): ConnectionRow[] {
  return connectionRows.filter((row) => (
    isProjectRowAfterCursor('connection', row.id, row.updated_at, lastCursor)
  ));
}
