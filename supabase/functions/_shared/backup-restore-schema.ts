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
}

export interface RestoreSelection {
  scope: 'all' | 'project';
  projectId?: string;
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
}

export function prepareRestoreRows(
  backupData: BackupDataLike,
  targetUserId: string,
  selection: RestoreSelection,
): PreparedRestoreRows {
  const selectedProjects = selection.scope === 'project' && selection.projectId
    ? backupData.projects.filter(project => project.id === selection.projectId)
    : backupData.projects;

  const projectIds = new Set(selectedProjects.map(project => project.id));

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
  };
}
