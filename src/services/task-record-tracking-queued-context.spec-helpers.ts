import { expect, it, vi } from 'vitest';

import type { Project } from '../models';
import {
  createProject,
  createTask,
  type TaskRecordTrackingSpecHarness,
} from './task-record-tracking.service.spec-helpers';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve: resolve! };
}

export function registerTaskRecordTrackingQueuedContextSpecs(
  getHarness: () => TaskRecordTrackingSpecHarness,
): void {
  it('should keep a queued mutation bound to the project active when it was submitted', async () => {
    const { service, mockProjectState, mockActionQueue } = getHarness();
    const firstQueueWrite = createDeferred<string>();
    const projectA = createProject({
      id: 'project-a',
      tasks: [createTask({ id: 'task-a', title: 'Initial A' })],
    });
    const projectB = createProject({
      id: 'project-b',
      tasks: [createTask({ id: 'task-b', title: 'Initial B' })],
    });
    const projects = [projectA, projectB];
    let activeProject = projectA;
    mockProjectState.activeProject.mockImplementation(() => activeProject);
    mockProjectState.getProjectWithCurrentData.mockImplementation(
      (projectId: string) => projects.find(project => project.id === projectId),
    );
    mockProjectState.getProjectsWithCurrentData.mockImplementation(() => projects);
    mockProjectState.updateProjects.mockImplementation((fn: (items: Project[]) => Project[]) => {
      const nextProjects = fn(projects);
      projects.splice(0, projects.length, ...nextProjects);
      return nextProjects;
    });
    mockActionQueue.enqueueDurably
      .mockReturnValueOnce(firstQueueWrite.promise)
      .mockResolvedValueOnce('queued-second-project-a-action');

    const firstResult = service.recordAndUpdate(project => ({
      ...project,
      tasks: project.tasks.map(task => task.id === 'task-a'
        ? { ...task, title: 'First A' }
        : task),
    }));
    const secondResult = service.recordAndUpdate(project => ({
      ...project,
      tasks: project.tasks.map(task => task.id === 'task-a'
        ? { ...task, title: 'Second A' }
        : task),
    }));

    activeProject = projectB;
    firstQueueWrite.resolve('queued-first-project-a-action');

    await expect(firstResult).resolves.toBe(true);
    await expect(secondResult).resolves.toBe(true);
    expect(projects.find(project => project.id === 'project-a')?.tasks[0]?.title).toBe('Second A');
    expect(projects.find(project => project.id === 'project-b')?.tasks[0]?.title).toBe('Initial B');
    expect(mockActionQueue.enqueueDurably).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ projectId: 'project-a' }),
    }));
  });

  it('should invalidate queued and in-flight mutations when the session runtime resets', async () => {
    const { service, mockProjectState, mockActionQueue, sessionRuntimeReset } = getHarness();
    const firstQueueWrite = createDeferred<string>();
    const project = createProject({
      id: 'project-session-reset',
      tasks: [createTask({ id: 'task-session-reset', title: 'Initial' })],
    });
    mockProjectState.activeProject.mockReturnValue(project);
    mockProjectState.getProjectWithCurrentData.mockReturnValue(project);
    mockActionQueue.enqueueDurably.mockReturnValueOnce(firstQueueWrite.promise);

    const firstResult = service.recordAndUpdate(currentProject => ({
      ...currentProject,
      tasks: currentProject.tasks.map(task => ({ ...task, title: 'First' })),
    }));
    const secondMutator = vi.fn((currentProject: Project) => ({
      ...currentProject,
      tasks: currentProject.tasks.map(task => ({ ...task, title: 'Second' })),
    }));
    const secondResult = service.recordAndUpdate(secondMutator);

    sessionRuntimeReset.resetAll('owner-change');
    firstQueueWrite.resolve('queued-before-session-reset');

    await expect(firstResult).resolves.toBe(false);
    await expect(secondResult).resolves.toBe(false);
    expect(secondMutator).not.toHaveBeenCalled();
    expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    expect(mockActionQueue.enqueueDurably).toHaveBeenCalledOnce();
  });
}
