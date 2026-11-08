import type { Attachment, Project, Task } from '../models';
import type { ActiveProjectOwner } from './project-state.service';

export interface TaskProjectAttachmentOwnerFence {
  readonly ownerUserId: string;
  readonly projectOwner: ActiveProjectOwner;
  readonly authIdentityFence: string;
  readonly sessionGeneration: number;
  readonly operationId: string;
  isCurrent: () => boolean;
}

export interface TaskProjectAttachmentRuntime {
  blockLocalMutation: (actionLabel: string) => boolean;
  ownerFence: TaskProjectAttachmentOwnerFence;
  currentUserId: () => string | null;
  getProjectsWithCurrentData: () => Project[];
  persistOfflineSnapshot: (projects: Project[], ownerUserId: string | null) => Promise<void>;
  updateProjects: (mutator: (projects: Project[]) => Project[]) => void;
  markEditing: () => void;
  setLastUpdateType: (updateType: 'content') => void;
  trackTaskUpdate: (projectId: string, task: Task, changedFields: string[]) => void;
  markLocalChanges: (updateType: 'content') => void;
  schedulePersist: () => void;
  warn: (message: string, data: Record<string, unknown>) => void;
}

export interface TaskProjectAttachmentOutboxRuntime {
  ownerFence: TaskProjectAttachmentOwnerFence;
  currentUserId: () => string | null;
  enqueueDurably: (action: {
    type: 'update';
    entityType: 'task';
    entityId: string;
    operationId?: string;
    payload: {
      task: Task;
      projectId: string;
      sourceUserId: string;
    };
  }) => Promise<string>;
  warn: (message: string, data: Record<string, unknown>) => void;
}

export interface AddTaskAttachmentToProjectOptions {
  projectId: string;
  taskId: string;
  attachment: Attachment;
  operationId?: string;
}

export interface EnqueueTaskAttachmentProjectUpdateOptions extends AddTaskAttachmentToProjectOptions {
  project: Project;
  task: Task;
}

interface ProjectAttachmentMutation {
  foundTask: boolean;
  requiresPreCommitSnapshot: boolean;
  updatedProjects: Project[];
  updatedTask: Task | null;
}

export async function enqueueTaskAttachmentProjectUpdateIfNeeded(
  options: EnqueueTaskAttachmentProjectUpdateOptions,
  runtime: TaskProjectAttachmentOutboxRuntime,
): Promise<boolean> {
  const { project, projectId, taskId, attachment } = options;
  if (!runtime.ownerFence.isCurrent()) return false;
  if (project.syncSource === 'local-only') {
    return true;
  }

  const sourceUserId = runtime.currentUserId();
  if (!sourceUserId) {
    runtime.warn('添加附件失败：用户认证状态尚未就绪，未提交 UI 更新', {
      projectId,
      taskId,
      attachmentId: attachment.id,
    });
    return false;
  }

  if (!runtime.ownerFence.isCurrent()) return false;
  const actionId = await runtime.enqueueDurably({
    type: 'update',
    entityType: 'task',
    entityId: taskId,
    operationId: runtime.ownerFence.operationId,
    payload: {
      task: createTaskWithAttachment(options.task, attachment),
      projectId,
      sourceUserId,
    },
  });
  if (!runtime.ownerFence.isCurrent()) return false;
  if (!actionId) {
    runtime.warn('任务附件 Outbox 本地持久化失败，未提交 UI 更新', {
      projectId,
      taskId,
      attachmentId: attachment.id,
    });
    return false;
  }

  return true;
}

export function addTaskAttachmentToProjectState(
  options: AddTaskAttachmentToProjectOptions,
  runtime: TaskProjectAttachmentRuntime,
): Promise<boolean> {
  if (runtime.blockLocalMutation('添加任务附件')) {
    return Promise.resolve(false);
  }
  if (!runtime.ownerFence.isCurrent()) return Promise.resolve(false);

  return addTaskAttachmentToProjectStateDurably(options, runtime);
}

async function addTaskAttachmentToProjectStateDurably(
  options: AddTaskAttachmentToProjectOptions,
  runtime: TaskProjectAttachmentRuntime,
): Promise<boolean> {
  const { projectId, taskId, attachment } = options;
  if (!runtime.ownerFence.isCurrent()) return false;
  const mutation = buildProjectAttachmentMutation(
    runtime.getProjectsWithCurrentData(),
    options,
  );

  if (!mutation.foundTask || !mutation.updatedTask) {
    runtime.warn('添加附件失败：目标任务不存在', { projectId, taskId, attachmentId: attachment.id });
    return false;
  }

  const ownerUserId = runtime.currentUserId();
  if (mutation.requiresPreCommitSnapshot) {
    if (!runtime.ownerFence.isCurrent()) return false;
    try {
      await runtime.persistOfflineSnapshot(mutation.updatedProjects, ownerUserId);
    } catch (error) {
      runtime.warn('任务附件项目快照本地持久化失败，未提交 UI 更新', {
        projectId,
        taskId,
        attachmentId: attachment.id,
        error,
      });
      return false;
    }
    if (!runtime.ownerFence.isCurrent()) return false;
  }

  if (!runtime.ownerFence.isCurrent()) return false;
  runtime.updateProjects(() => mutation.updatedProjects);
  runtime.markEditing();
  runtime.setLastUpdateType('content');
  runtime.trackTaskUpdate(projectId, mutation.updatedTask, ['attachments']);
  runtime.markLocalChanges('content');
  runtime.schedulePersist();
  if (!mutation.requiresPreCommitSnapshot) {
    void (async () => {
      if (!runtime.ownerFence.isCurrent()) return;
      try {
        await runtime.persistOfflineSnapshot(mutation.updatedProjects, ownerUserId);
        if (!runtime.ownerFence.isCurrent()) return;
      } catch (error: unknown) {
        runtime.warn('任务附件项目快照本地持久化失败，已保留 Outbox 并等待后台持久化重试', {
          projectId,
          taskId,
          attachmentId: attachment.id,
          error,
        });
      }
    })();
  }
  return true;
}

function buildProjectAttachmentMutation(
  currentProjects: Project[],
  options: AddTaskAttachmentToProjectOptions,
): ProjectAttachmentMutation {
  let updatedTask: Task | null = null;
  let foundTask = false;
  let requiresPreCommitSnapshot = false;
  const now = new Date().toISOString();

  const updatedProjects = currentProjects.map(project => {
    if (project.id !== options.projectId) return project;

    requiresPreCommitSnapshot = project.syncSource === 'local-only';
    let projectChanged = false;
    const tasks = project.tasks.map(task => {
      if (task.id !== options.taskId) return task;

      foundTask = true;
      projectChanged = true;
      updatedTask = createTaskWithAttachment(task, options.attachment, now);
      return updatedTask;
    });

    return projectChanged ? { ...project, tasks, updatedAt: now } : project;
  });

  return { foundTask, requiresPreCommitSnapshot, updatedProjects, updatedTask };
}

function upsertTaskAttachment(attachments: Attachment[], attachment: Attachment): Attachment[] {
  const existingIndex = attachments.findIndex(existing => existing.id === attachment.id);
  if (existingIndex === -1) {
    return [...attachments, attachment];
  }

  return attachments.map((existing, index) => (
    index === existingIndex ? { ...existing, ...attachment } : existing
  ));
}

function createTaskWithAttachment(
  task: Task,
  attachment: Attachment,
  updatedAt = new Date().toISOString(),
): Task {
  return {
    ...task,
    attachments: upsertTaskAttachment(task.attachments ?? [], attachment),
    updatedAt,
  };
}
