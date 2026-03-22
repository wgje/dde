export interface BackupProjectLike {
  id: string;
  userId: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
}

export interface BackupTaskLike {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  parentId?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: string;
  x?: number;
  y?: number;
  shortId?: string;
  attachments?: unknown[];
  tags?: string[];
  priority?: string;
  dueDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface BackupConnectionLike {
  id: string;
  projectId: string;
  source: string;
  target: string;
  title?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface BackupDataLike {
  projects: BackupProjectLike[];
  tasks: BackupTaskLike[];
  connections: BackupConnectionLike[];
  payloadVersion?: string;
  userPreferences?: BackupUserPreferencesLike[];
  blackBoxEntries?: BackupBlackBoxEntryLike[];
  focusSessions?: BackupFocusSessionLike[];
  transcriptionUsage?: BackupTranscriptionUsageLike[];
  routineTasks?: BackupRoutineTaskLike[];
  routineCompletions?: BackupRoutineCompletionLike[];
  localState?: unknown;
}

export interface RestoreSelection {
  scope: 'all' | 'project';
  projectId?: string;
  preset?: 'project_only' | 'project_plus_user_state';
}

export interface BackupUserPreferencesLike {
  id: string;
  userId: string;
  theme?: string;
  layoutDirection?: string;
  floatingWindowPref?: string;
  colorMode?: string;
  autoResolveConflicts?: boolean;
  localBackupEnabled?: boolean;
  localBackupIntervalMs?: number;
  focusPreferences?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupBlackBoxEntryLike {
  id: string;
  projectId?: string | null;
  userId?: string | null;
  content: string;
  date?: string;
  createdAt?: string;
  updatedAt?: string;
  isRead?: boolean;
  isCompleted?: boolean;
  isArchived?: boolean;
  snoozeUntil?: string | null;
  snoozeCount?: number;
  deletedAt?: string | null;
  focusMeta?: unknown;
}

export interface BackupFocusSessionLike {
  id: string;
  userId: string;
  startedAt: string;
  endedAt?: string | null;
  sessionState: unknown;
  updatedAt?: string;
}

export interface BackupTranscriptionUsageLike {
  id: string;
  userId: string;
  date: string;
  audioSeconds: number;
  createdAt?: string;
}

export interface BackupRoutineTaskLike {
  id: string;
  userId: string;
  title: string;
  maxTimesPerDay: number;
  isEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupRoutineCompletionLike {
  id: string;
  routineId: string;
  userId: string;
  dateKey: string;
  count: number;
  updatedAt?: string;
}

export interface RestoreProjectRow {
  id: string;
  owner_id: string;
  title: string;
  description?: string;
  created_date?: string;
  updated_at?: string;
  version?: number;
}

export interface RestoreTaskRow {
  id: string;
  project_id: string;
  title: string;
  content?: string;
  parent_id?: string | null;
  stage?: number | null;
  order?: number;
  rank?: number;
  status?: string;
  x?: number;
  y?: number;
  short_id?: string;
  attachments?: unknown[];
  tags?: string[];
  priority?: string;
  due_date?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface RestoreConnectionRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  title?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface PreparedRestoreRows {
  projects: RestoreProjectRow[];
  tasks: RestoreTaskRow[];
  connections: RestoreConnectionRow[];
  userPreferences: RestoreUserPreferencesRow[];
  blackBoxEntries: RestoreBlackBoxEntryRow[];
  focusSessions: RestoreFocusSessionRow[];
  transcriptionUsage: RestoreTranscriptionUsageRow[];
  routineTasks: RestoreRoutineTaskRow[];
  routineCompletions: RestoreRoutineCompletionRow[];
}

export interface RestoreUserPreferencesRow {
  id: string;
  user_id: string;
  theme?: string;
  layout_direction?: string;
  floating_window_pref?: string;
  color_mode?: string;
  auto_resolve_conflicts?: boolean;
  local_backup_enabled?: boolean;
  local_backup_interval_ms?: number;
  focus_preferences?: unknown;
  created_at?: string;
  updated_at?: string;
}

export interface RestoreBlackBoxEntryRow {
  id: string;
  project_id?: string | null;
  user_id: string;
  content: string;
  date?: string;
  created_at?: string;
  updated_at?: string;
  is_read?: boolean;
  is_completed?: boolean;
  is_archived?: boolean;
  snooze_until?: string | null;
  snooze_count?: number;
  deleted_at?: string | null;
  focus_meta?: unknown;
}

export interface RestoreFocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at?: string | null;
  session_state: unknown;
  updated_at?: string;
}

export interface RestoreTranscriptionUsageRow {
  id: string;
  user_id: string;
  date: string;
  audio_seconds: number;
  created_at?: string;
}

export interface RestoreRoutineTaskRow {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day: number;
  is_enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface RestoreRoutineCompletionRow {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  count: number;
  updated_at?: string;
}

export function prepareRestoreRows(
  backupData: BackupDataLike,
  targetUserId: string,
  selection: RestoreSelection,
): PreparedRestoreRows {
  const preset = selection.preset ?? 'project_only';
  const selectedProjects = selection.scope === 'project' && selection.projectId
    ? backupData.projects.filter(project => project.id === selection.projectId)
    : backupData.projects;

  const projectIds = new Set(selectedProjects.map(project => project.id));
  const includeUserState = selection.scope === 'all' || preset === 'project_plus_user_state';

  const blackBoxEntries = (backupData.blackBoxEntries ?? []).filter((entry) => {
    if (selection.scope === 'all') return true;
    if (projectIds.has(entry.projectId ?? '')) return true;
    return includeUserState && (entry.projectId === null || entry.projectId === undefined);
  });

  return {
    projects: selectedProjects.map(project => ({
      id: project.id,
      owner_id: targetUserId,
      title: project.name,
      description: project.description,
      created_date: project.createdAt,
      updated_at: project.updatedAt,
      version: project.version,
    })),
    tasks: backupData.tasks
      .filter(task => projectIds.has(task.projectId))
      .map(task => ({
        id: task.id,
        project_id: task.projectId,
        title: task.title,
        content: task.content,
        parent_id: task.parentId,
        stage: task.stage,
        order: task.order,
        rank: task.rank,
        status: task.status,
        x: task.x,
        y: task.y,
        short_id: task.shortId,
        attachments: task.attachments,
        tags: task.tags,
        priority: task.priority,
        due_date: task.dueDate,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        deleted_at: task.deletedAt,
      })),
    connections: backupData.connections
      .filter(connection => projectIds.has(connection.projectId))
      .map(connection => ({
        id: connection.id,
        project_id: connection.projectId,
        source_id: connection.source,
        target_id: connection.target,
        title: connection.title,
        description: connection.description,
        created_at: connection.createdAt,
        updated_at: connection.updatedAt,
        deleted_at: connection.deletedAt,
      })),
    userPreferences: includeUserState
      ? (backupData.userPreferences ?? []).map((preferences) => ({
        id: preferences.id,
        user_id: targetUserId,
        theme: preferences.theme,
        layout_direction: preferences.layoutDirection,
        floating_window_pref: preferences.floatingWindowPref,
        color_mode: preferences.colorMode,
        auto_resolve_conflicts: preferences.autoResolveConflicts,
        local_backup_enabled: preferences.localBackupEnabled,
        local_backup_interval_ms: preferences.localBackupIntervalMs,
        focus_preferences: preferences.focusPreferences,
        created_at: preferences.createdAt,
        updated_at: preferences.updatedAt,
      }))
      : [],
    blackBoxEntries: blackBoxEntries.map((entry) => ({
      id: entry.id,
      project_id: entry.projectId,
      user_id: targetUserId,
      content: entry.content,
      date: entry.date,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      is_read: entry.isRead,
      is_completed: entry.isCompleted,
      is_archived: entry.isArchived,
      snooze_until: entry.snoozeUntil,
      snooze_count: entry.snoozeCount,
      deleted_at: entry.deletedAt,
      focus_meta: entry.focusMeta,
    })),
    focusSessions: includeUserState
      ? (backupData.focusSessions ?? []).map((session) => ({
        id: session.id,
        user_id: targetUserId,
        started_at: session.startedAt,
        ended_at: session.endedAt,
        session_state: session.sessionState,
        updated_at: session.updatedAt,
      }))
      : [],
    transcriptionUsage: includeUserState
      ? (backupData.transcriptionUsage ?? []).map((usage) => ({
        id: usage.id,
        user_id: targetUserId,
        date: usage.date,
        audio_seconds: usage.audioSeconds,
        created_at: usage.createdAt,
      }))
      : [],
    routineTasks: includeUserState
      ? (backupData.routineTasks ?? []).map((task) => ({
        id: task.id,
        user_id: targetUserId,
        title: task.title,
        max_times_per_day: task.maxTimesPerDay,
        is_enabled: task.isEnabled,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
      }))
      : [],
    routineCompletions: includeUserState
      ? (backupData.routineCompletions ?? []).map((completion) => ({
        id: completion.id,
        routine_id: completion.routineId,
        user_id: targetUserId,
        date_key: completion.dateKey,
        count: completion.count,
        updated_at: completion.updatedAt,
      }))
      : [],
  };
}
