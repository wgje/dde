import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

interface ProjectSearchTaskControllerOptions {
  activeProjectId: () => string | null;
  focusFlowNode: (taskId: string) => void;
  previewTask: (taskId: string) => void | Promise<boolean>;
  setDockExpanded: (
    expanded: boolean,
    options: { persistPreference: boolean },
  ) => void | Promise<boolean>;
  switchActiveProject: (projectId: string) => void;
  taskProjectId: (taskId: string) => string | null;
  waitForProjectSwitchTick?: () => Promise<void>;
}

interface ProjectSearchTaskController {
  open(taskId: string, isParked: boolean): void;
}

type ProjectSearchTaskControllerConstructor = new (
  options: ProjectSearchTaskControllerOptions,
) => ProjectSearchTaskController;

async function loadController(): Promise<ProjectSearchTaskControllerConstructor> {
  const modulePath = './workspace-shell-project-search-task.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellProjectSearchTaskController',
  ) as ProjectSearchTaskControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createContext(): {
  options: ProjectSearchTaskControllerOptions;
  previewTask: ReturnType<typeof vi.fn>;
  setActiveProjectId: (projectId: string | null) => void;
  setDockExpanded: ReturnType<typeof vi.fn>;
  setTaskProjectId: (taskId: string, projectId: string) => void;
  switchActiveProject: ReturnType<typeof vi.fn>;
  focusFlowNode: ReturnType<typeof vi.fn>;
} {
  let activeProjectId: string | null = 'project-current';
  const taskProjectIds = new Map<string, string>();
  const switchActiveProject = vi.fn();
  const focusFlowNode = vi.fn();
  const setDockExpanded = vi.fn();
  const previewTask = vi.fn();

  return {
    options: {
      activeProjectId: () => activeProjectId,
      taskProjectId: taskId => taskProjectIds.get(taskId) ?? null,
      switchActiveProject,
      focusFlowNode,
      setDockExpanded,
      previewTask,
    },
    switchActiveProject,
    focusFlowNode,
    setDockExpanded,
    previewTask,
    setActiveProjectId: projectId => {
      activeProjectId = projectId;
    },
    setTaskProjectId: (taskId, projectId) => {
      taskProjectIds.set(taskId, projectId);
    },
  };
}

describe('WorkspaceShellProjectSearchTaskController', () => {
  it('owns project search task opening outside Project Actions', async () => {
    await loadController();
    const source = readFileSync(
      join(__dirname, 'workspace-shell-project-actions.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellProjectSearchTaskController');
    expect(source).toContain('this.projectSearchTask.open(taskId, isParked)');
    expect(source).not.toContain('parkedSearchPreviewGeneration');
    expect(source).not.toContain('private previewParkedSearchTaskAfterProjectSwitch(');
    expect(source).not.toContain('PROJECT_SWITCH_PREVIEW_WAIT_ATTEMPTS');
  });

  it('switches projects and immediately focuses non-parked search tasks', async () => {
    const Controller = await loadController();
    const context = createContext();
    context.setTaskProjectId('task-1', 'project-target');
    const controller = new Controller(context.options);

    controller.open('task-1', false);

    expect(context.switchActiveProject).toHaveBeenCalledWith('project-target');
    expect(context.focusFlowNode).toHaveBeenCalledWith('task-1');
    expect(context.setDockExpanded).not.toHaveBeenCalled();
    expect(context.previewTask).not.toHaveBeenCalled();
  });

  it('opens parked tasks through the dock in the active project', async () => {
    const Controller = await loadController();
    const context = createContext();
    context.setTaskProjectId('task-1', 'project-current');
    const controller = new Controller(context.options);

    controller.open('task-1', true);
    await Promise.resolve();

    expect(context.switchActiveProject).not.toHaveBeenCalled();
    expect(context.setDockExpanded).toHaveBeenCalledWith(
      true,
      { persistPreference: false },
    );
    expect(context.previewTask).toHaveBeenCalledWith('task-1');
    expect(context.focusFlowNode).not.toHaveBeenCalled();
  });

  it('waits for a cross-project switch before previewing parked tasks', async () => {
    const Controller = await loadController();
    const context = createContext();
    let resolveTick!: () => void;
    context.setTaskProjectId('task-1', 'project-target');
    context.options.waitForProjectSwitchTick = vi.fn(() =>
      new Promise<void>(resolve => {
        resolveTick = resolve;
      }),
    );
    const controller = new Controller(context.options);

    controller.open('task-1', true);
    await Promise.resolve();
    expect(context.previewTask).not.toHaveBeenCalled();

    context.setActiveProjectId('project-target');
    resolveTick();

    await vi.waitFor(() => expect(context.previewTask).toHaveBeenCalledWith('task-1'));
  });

  it('ignores an older parked preview after a newer search task opens', async () => {
    const Controller = await loadController();
    const context = createContext();
    const pendingTicks: Array<() => void> = [];
    context.setTaskProjectId('task-old', 'project-old');
    context.setTaskProjectId('task-new', 'project-new');
    context.options.waitForProjectSwitchTick = vi.fn(() =>
      new Promise<void>(resolve => {
        pendingTicks.push(resolve);
      }),
    );
    const controller = new Controller(context.options);

    controller.open('task-old', true);
    await Promise.resolve();
    controller.open('task-new', true);
    await Promise.resolve();

    context.setActiveProjectId('project-old');
    pendingTicks[0]?.();
    await Promise.resolve();
    expect(context.previewTask).not.toHaveBeenCalledWith('task-old');

    context.setActiveProjectId('project-new');
    pendingTicks[1]?.();
    await vi.waitFor(() => expect(context.previewTask).toHaveBeenCalledWith('task-new'));
  });

  it('stops waiting when the target project never becomes active', async () => {
    const Controller = await loadController();
    const context = createContext();
    const waitForProjectSwitchTick = vi.fn().mockResolvedValue(undefined);
    context.setTaskProjectId('task-1', 'project-target');
    context.options.waitForProjectSwitchTick = waitForProjectSwitchTick;
    const controller = new Controller(context.options);

    controller.open('task-1', true);

    await vi.waitFor(() => expect(waitForProjectSwitchTick).toHaveBeenCalledTimes(5));
    expect(context.previewTask).not.toHaveBeenCalled();
    expect(context.setDockExpanded).not.toHaveBeenCalled();
  });
});
