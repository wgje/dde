/**
 * DockTaskSyncService
 * Dock 引擎中任务同步相关的操作：项目归属查找、详情/规划字段同步、跨项目更新。
 * 从 DockEngineService 提取，降低引擎文件体量。
 */
import { Injectable, Injector, inject } from '@angular/core';
import { CognitiveLoad, DockEntry } from '../models/parking-dock';
import { Task } from '../models';
import { TaskStore } from '../core-bridge';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { BlackBoxService } from './black-box.service';
import { normalizeNullableNumber } from './dock-snapshot-persistence.service';
import { sanitizePlannerFields } from '../utils/planner-fields';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { AUTH_CONFIG } from '../config/auth.config';

type DockTaskPlannerPatch = {
  expected_minutes?: number | null;
  cognitive_load?: CognitiveLoad | null;
  wait_minutes?: number | null;
};

type TaskOperationPlannerPatch = {
  expectedMinutes?: number | null;
  waitMinutes?: number | null;
  cognitiveLoad?: CognitiveLoad | null;
};

@Injectable({
  providedIn: 'root',
})
export class DockTaskSyncService {
  private readonly taskStore = inject(TaskStore);
  private readonly injector = inject(Injector);
  private readonly projectState = inject(ProjectStateService);
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly authService = inject(AuthService);
  private readonly logger = inject(LoggerService).category('DockTaskSync');

  private get taskOps(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  resolveTaskProjectId(taskId: string, fallbackProjectId?: string | null): string | null {
    const directProjectId = this.taskStore.getTaskProjectId(taskId);
    if (directProjectId) return directProjectId;
    if (fallbackProjectId) return fallbackProjectId;

    const project = this.projectState.projects().find(candidate =>
      candidate.tasks.some(task => task.id === taskId),
    );
    return project?.id ?? this.projectState.activeProjectId() ?? null;
  }

  /**
   * 同步 dock 详情文本到底层任务或 BlackBox 条目。
   * @param context 来自引擎的运行时状态（entries 列表与专注会话上下文）
   */
  syncTaskDetail(
    taskId: string,
    detail: string,
    context: {
      entries: DockEntry[];
      focusSessionContext: { id: string; startedAt: number } | null;
    },
  ): Promise<boolean> {
    const inlineEntry = context.entries.find(entry => entry.taskId === taskId) ?? null;
    if (inlineEntry?.sourceKind === 'dock-created') {
      if (!inlineEntry.sourceBlackBoxEntryId) return Promise.resolve(false);
      return this.monitorBlackBoxMutation(
        this.blackBoxService.updateDurably(inlineEntry.sourceBlackBoxEntryId, {
        content: detail.trim() || inlineEntry.title,
        focusMeta: {
          source: 'focus-console-inline',
          sessionId: context.focusSessionContext?.id ?? crypto.randomUUID(),
          title: inlineEntry.title,
          detail: detail.trim() || null,
          lane: inlineEntry.lane,
          expectedMinutes: normalizeNullableNumber(inlineEntry.expectedMinutes),
          waitMinutes: normalizeNullableNumber(inlineEntry.waitMinutes),
          cognitiveLoad: inlineEntry.load,
          dockEntryId: inlineEntry.taskId,
        },
        }),
        'Inline dock detail failed to update source black-box entry',
        {
          dockEntryId: inlineEntry.taskId,
          blackBoxEntryId: inlineEntry.sourceBlackBoxEntryId,
        },
      );
    }

    const task = this.taskStore.getTask(taskId);
    if (!task) return Promise.resolve(false);
    const projectId = this.resolveTaskProjectId(taskId, inlineEntry?.sourceProjectId ?? null);
    if (!projectId) return Promise.resolve(false);

    if (this.projectState.activeProjectId() === projectId) {
      return this.monitorBooleanMutation(
        this.taskOps.updateTaskContent(taskId, detail),
        'Dock task detail failed to persist through task operations',
        { taskId, projectId },
      );
    }

    return this.applyCrossProjectTaskPatch(taskId, projectId, {
      content: detail,
    });
  }

  async syncTaskPlannerFields(
    taskId: string,
    patch: DockTaskPlannerPatch,
  ): Promise<boolean> {
    const task = this.taskStore.getTask(taskId);
    if (!task) return false;
    const projectId = this.resolveTaskProjectId(taskId);
    if (!projectId) return false;

    const normalizedPatch = this.normalizePlannerPatch(task, patch);

    if (this.projectState.activeProjectId() === projectId) {
      return this.syncActiveProjectPlannerFields(taskId, projectId, normalizedPatch);
    }

    return this.applyCrossProjectTaskPatch(taskId, projectId, normalizedPatch);
  }

  private normalizePlannerPatch(task: Task, patch: DockTaskPlannerPatch): DockTaskPlannerPatch {
    const normalizedPatch: DockTaskPlannerPatch = {};
    const plannerFields = sanitizePlannerFields({
      expectedMinutes:
        'expected_minutes' in patch ? patch.expected_minutes : task.expected_minutes,
      waitMinutes:
        'wait_minutes' in patch ? patch.wait_minutes : task.wait_minutes,
      cognitiveLoad:
        'cognitive_load' in patch ? patch.cognitive_load : task.cognitive_load,
    });

    if ('expected_minutes' in patch || ('wait_minutes' in patch && plannerFields.adjusted)) {
      normalizedPatch.expected_minutes = plannerFields.expectedMinutes;
    }
    if ('cognitive_load' in patch) {
      normalizedPatch.cognitive_load = plannerFields.cognitiveLoad;
    }
    if ('wait_minutes' in patch) {
      normalizedPatch.wait_minutes = plannerFields.waitMinutes;
    }
    return normalizedPatch;
  }

  private syncActiveProjectPlannerFields(
    taskId: string,
    projectId: string,
    normalizedPatch: DockTaskPlannerPatch,
  ): Promise<boolean> {
    const durablePatch: TaskOperationPlannerPatch = {};
    if ('expected_minutes' in normalizedPatch) {
      durablePatch.expectedMinutes = normalizedPatch.expected_minutes ?? null;
    }
    if ('cognitive_load' in normalizedPatch) {
      durablePatch.cognitiveLoad = normalizedPatch.cognitive_load ?? null;
    }
    if ('wait_minutes' in normalizedPatch) {
      durablePatch.waitMinutes = normalizedPatch.wait_minutes ?? null;
    }

    if (Object.keys(durablePatch).length === 0) return Promise.resolve(false);
    return this.monitorBooleanMutation(
      this.taskOps.updateTaskPlannerFields(taskId, durablePatch),
      'Dock task planner fields failed to persist through task operations',
      { taskId, projectId },
    );
  }

  syncInlineCompletion(entry: DockEntry): void {
    if (entry.sourceKind !== 'dock-created') return;
    const blackBoxEntryId = entry.sourceBlackBoxEntryId ?? null;
    if (!blackBoxEntryId) return;

    if (this.blackBoxService.getEntry(blackBoxEntryId)?.isCompleted) return;

    void this.monitorBlackBoxMutation(
      this.blackBoxService.markAsCompletedDurably(blackBoxEntryId),
      'Inline dock completion failed to mark source black-box entry completed',
      {
        dockEntryId: entry.taskId,
        blackBoxEntryId,
      },
    );
  }

  syncCompletedInlineEntries(entries: readonly DockEntry[]): void {
    for (const entry of entries) {
      if (entry.status === 'completed') {
        this.syncInlineCompletion(entry);
      }
    }
  }

  async applyCrossProjectTaskPatch(
    taskId: string,
    projectId: string,
    patch: Partial<Task>,
  ): Promise<boolean> {
    const currentTask = this.taskStore.getTask(taskId);
    if (!currentTask) return false;
    const now = new Date().toISOString();
    const completedAt = this.resolveCompletedAt(currentTask, patch, now);

    const updatedTask: Task = {
      ...currentTask,
      ...patch,
      completedAt,
      updatedAt: now,
    };
    const ownerUserId = this.authService.currentUserId();
    if (!ownerUserId) {
      this.logger.warn('跨项目任务补丁缺少当前用户，未提交本地 UI 更新', { taskId, projectId });
      return false;
    }

    if (ownerUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      const actionId = await this.actionQueue.enqueueDurablyForOwner(ownerUserId, {
        type: 'update',
        entityType: 'task',
        entityId: taskId,
        payload: {
          task: updatedTask,
          projectId,
          sourceUserId: ownerUserId,
        },
        priority: 'normal',
      });
      if (!actionId) {
        this.logger.warn('跨项目任务补丁未能写入本地持久化队列，未提交 UI 更新', { taskId, projectId });
        return false;
      }
    }

    this.taskStore.setTask(updatedTask, projectId);
    this.projectState.updateProjects(projects =>
      projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(item => (item.id === taskId ? updatedTask : item)),
            }
          : project,
      ),
    );
    return true;
  }

  /**
   * 完成时间不是 LWW 时钟：已完成任务保留原值，刚完成时写入 now，恢复/归档时清空。
   */
  private resolveCompletedAt(currentTask: Task, patch: Partial<Task>, now: string): string | null | undefined {
    if (patch.status === 'completed') {
      if (currentTask.status === 'completed') {
        return patch.completedAt ?? currentTask.completedAt ?? now;
      }
      return patch.completedAt ?? now;
    }
    if (patch.status) {
      return null;
    }
    return patch.completedAt === undefined ? currentTask.completedAt : patch.completedAt;
  }

  private async monitorBooleanMutation(
    mutation: Promise<unknown>,
    message: string,
    context: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const result = await mutation;
      return result !== false;
    } catch (error) {
      this.logger.warn(message, {
        ...context,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async monitorBlackBoxMutation(
    mutation: Promise<{ ok: true } | { ok: false; error: { message: string } }>,
    message: string,
    context: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const result = await mutation;
      if (!result.ok) {
        this.logger.warn(message, {
          ...context,
          message: result.error.message,
        });
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(message, {
        ...context,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
