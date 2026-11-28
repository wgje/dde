import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { TaskStore, ProjectStore, ConnectionStore } from '../app/core/state/stores';
import type { Project, Task } from '../models';
import { LayoutService } from './layout.service';
import { ProjectStateService } from './project-state.service';
import { UiStateService } from './ui-state.service';

function task(fields: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(), title: '可归档任务', content: '- [ ] 待办事项',
    stage: 1, parentId: null, order: 1, rank: 1000, status: 'active',
    x: 0, y: 0, displayId: '1', createdDate: '2026-11-28T00:00:00.000Z',
    ...fields,
  };
}

function setup(tasks: Task[]) {
  const projectId = crypto.randomUUID();
  const taskStore = new TaskStore();
  const projectStore = new ProjectStore();
  const connectionStore = new ConnectionStore();
  const filterMode = signal('all');
  const project: Project = {
    id: projectId, name: '归档可见性测试', description: '',
    createdDate: '2026-11-28T00:00:00.000Z', tasks, connections: [],
  };
  projectStore.setProjects([project]);
  projectStore.activeProjectId.set(projectId);
  taskStore.setTasks(tasks, projectId);
  const injector = Injector.create({ providers: [
    { provide: TaskStore, useValue: taskStore },
    { provide: ProjectStore, useValue: projectStore },
    { provide: ConnectionStore, useValue: connectionStore },
    { provide: LayoutService, useValue: {} },
    { provide: UiStateService, useValue: { filterMode } },
  ] });
  const state = runInInjectionContext(injector, () => new ProjectStateService());
  const patch = (item: Task, fields: Partial<Task>): void => {
    taskStore.setTask({ ...taskStore.getTask(item.id)!, ...fields }, projectId);
  };
  return { state, taskStore, filterMode, projectId, patch };
}

describe('ProjectStateService main-view task visibility', () => {
  it.each([1, null])('removes stage %s tasks on archive and restores the original entity on unarchive', stage => {
    const item = task({ stage });
    const { state, patch } = setup([item]);
    const shown = () => stage === null
      ? state.unassignedTasks()
      : state.stages().flatMap(section => section.tasks);
    expect(shown().map(value => value.id)).toContain(item.id);
    patch(item, { status: 'archived' });
    expect(shown().map(value => value.id)).not.toContain(item.id);
    expect(state.unfinishedItems()).toEqual([]);
    expect(state.taskTodoStats()).toEqual({ total: 0, completed: 0, pending: 0 });
    expect(state.tasks()).toEqual([{ ...item, status: 'archived' }]);
    patch(item, { status: 'active' });
    expect(shown()).toEqual([item]);
    expect(state.unfinishedItems().map(value => value.taskId)).toEqual([item.id]);
  });

  it('excludes already archived and deleted tasks from stages, root options, todos and counts', () => {
    const active = task();
    const completed = task({ status: 'completed', displayId: '2', rank: 2000 });
    const archived = task({ status: 'archived', displayId: '3', stage: 2 });
    const deleted = task({ deletedAt: '2026-11-28T00:01:00.000Z', displayId: '4' });
    const unassigned = task({ status: 'archived', stage: null, displayId: '?' });
    const { state } = setup([active, completed, archived, deleted, unassigned]);
    expect(state.stages().flatMap(section => section.tasks)).toEqual([active, completed]);
    expect(state.unassignedTasks()).toEqual([]);
    expect(state.allStage1Tasks()).toEqual([active, completed]);
    expect(state.rootTasks()).toEqual([active, completed]);
    expect(state.unfinishedItems().map(value => value.taskId)).toEqual([active.id, completed.id]);
    expect(state.taskTodoStats()).toEqual({ total: 2, completed: 0, pending: 2 });
    expect(state.deletedTasks()).toEqual([deleted]);
  });

  it('does not offer an active root whose only pending work belongs to an archived child', () => {
    const root = task({ content: '父任务没有待办事项' });
    const child = task({ parentId: root.id, displayId: '1,a', stage: 2 });
    const { state, patch } = setup([root, child]);
    expect(state.rootTasks()).toEqual([root]);
    patch(child, { status: 'archived' });
    expect(state.rootTasks()).toEqual([]);
    expect(state.allStage1Tasks()).toEqual([root]);
    expect(state.stages().map(section => section.stageNumber)).toEqual([1]);
  });

  it('keeps visible descendants when their parent is archived and preserves every entity for export', () => {
    const root = task();
    const child = task({ parentId: root.id, displayId: '1,a', stage: 2 });
    const { state, patch, projectId } = setup([root, child]);
    patch(root, { status: 'archived' });
    expect(state.stages().flatMap(section => section.tasks)).toEqual([child]);
    expect(state.allStage1Tasks()).toEqual([]);
    const retained = [{ ...root, status: 'archived' }, child];
    expect(state.tasks()).toEqual(retained);
    expect(state.getProjectWithCurrentData(projectId)?.tasks).toEqual(retained);
    expect(state.getProjectsWithCurrentData()[0]?.tasks).toEqual(retained);
    expect(state.getTask(root.id)?.content).toBe(root.content);
  });

  it('excludes archived todos while retaining the selected-root scope and whole-project counts', () => {
    const root = task();
    const archived = task({ parentId: root.id, displayId: '1,a', stage: 2, status: 'archived' });
    const other = task({ displayId: '2', rank: 2000 });
    const { state, filterMode, patch } = setup([root, archived, other]);
    filterMode.set(root.id);
    expect(state.unfinishedItems().map(value => value.taskId)).toEqual([root.id]);
    expect(state.taskTodoStats().pending).toBe(2);
    patch(archived, { status: 'active' });
    expect(state.unfinishedItems().map(value => value.taskId)).toEqual([root.id, archived.id]);
    expect(state.taskTodoStats().pending).toBe(3);
  });
});