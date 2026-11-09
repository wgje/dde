import type { ComponentFixture } from '@angular/core/testing';
import { expect, it, vi, type Mock } from 'vitest';

import type { Task, TaskAttentionDraftItem } from '../../../../models';
import type {
  ActiveProjectOwner,
  BeforeActiveProjectChangeListener,
} from '../../../../services/project-state.service';
import {
  readTextTaskEditorDraft,
  writeTextTaskEditorDraftField,
  type TextTaskEditorDraftScope,
} from './text-task-editor-draft-storage';
import type { TextTaskEditorComponent } from './text-task-editor.component';
import { createTask } from './text-task-editor.test-harness';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface ProjectOwnershipRenderResult {
  setProjectId(projectId: string | null): void;
  setTask(task: Task): void;
  setUserId(userId: string | null): void;
}

interface ProjectOwnershipSpecOptions {
  currentProjectId(): string | null;
  getFixture(): ComponentFixture<TextTaskEditorComponent>;
  render(
    taskOverrides?: Partial<Task>,
    inputOverrides?: { userId?: string | null; projectId?: string | null },
  ): ProjectOwnershipRenderResult;
  switchProject(projectId: string): void;
  updateTaskTitle: Mock<(taskId: string, title: string) => Promise<boolean>>;
  updateTaskContent: Mock<(taskId: string, content: string) => Promise<boolean>>;
  updateTaskExpectedMinutes: Mock<(taskId: string, minutes: number | null) => Promise<boolean>>;
  updateTaskAttentionItems: Mock<(taskId: string, rows: TaskAttentionDraftItem[]) => Promise<boolean>>;
}

export function createTextTaskEditorProjectStateHarness() {
  let activeProjectId = 'project-a';
  let generation = 0;
  const listeners = new Set<BeforeActiveProjectChangeListener>();
  const service = {
    activeProjectId: vi.fn<() => string | null>(() => activeProjectId),
    captureActiveProjectOwner: vi.fn<() => ActiveProjectOwner>(() => ({ projectId: activeProjectId, generation })),
    isActiveProjectOwnerCurrent: vi.fn((owner: ActiveProjectOwner) =>
      owner.projectId === activeProjectId && owner.generation === generation),
    registerBeforeActiveProjectChange: vi.fn((listener: BeforeActiveProjectChangeListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    compressDisplayId: vi.fn((displayId: string) => displayId),
    getTask: vi.fn(() => null),
  };
  const reset = (): void => {
    activeProjectId = 'project-a';
    generation = 0;
    listeners.clear();
    service.activeProjectId.mockImplementation(() => activeProjectId);
  };
  return {
    service,
    reset,
    setCurrentProject: (projectId: string) => { activeProjectId = projectId; },
    currentProjectId: () => activeProjectId,
    switchProject(nextProjectId: string): void {
      if (activeProjectId === nextProjectId) return;
      const previousProjectId = activeProjectId;
      generation += 1;
      for (const listener of [...listeners]) listener(previousProjectId, nextProjectId);
      activeProjectId = nextProjectId;
    },
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function flushPromiseTails(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createAttentionMeta(text = '旧注意'): NonNullable<Task['attentionMeta']> {
  return {
    items: [{
      id: 'attention-1', text, level: 'warning', done: false,
      createdAt: '2026-06-05T00:00:00.000Z', updatedAt: '2026-06-05T00:00:00.000Z',
    }],
    updatedAt: '2026-06-05T00:00:00.000Z',
  };
}

export function registerTextTaskEditorProjectOwnershipSpecs(options: ProjectOwnershipSpecOptions): void {
  it('keeps pre-auth drafts memory-only and stamps them once after trusted user settlement', async () => {
    const rendered = options.render(
      { id: 'pre-auth-task', title: '旧标题', content: '旧内容', attentionMeta: createAttentionMeta() },
      { userId: null, projectId: 'project-a' },
    );
    const fixture = options.getFixture();
    const component = fixture.componentInstance as unknown as {
      onTitleInput(value: string): void;
      onContentInput(value: string): void;
      onExpectedMinutesChange(value: string): Promise<boolean>;
      onAttentionInput(value: string): void;
    };

    component.onTitleInput('预认证标题');
    component.onContentInput('预认证正文');
    await component.onExpectedMinutesChange('25');
    component.onAttentionInput('预认证注意');
    await flushPromiseTails();

    const ownerlessScope = { userId: null, projectId: 'project-a', taskId: 'pre-auth-task' };
    expect(readTextTaskEditorDraft(ownerlessScope)).toBeNull();
    expect(options.updateTaskTitle).not.toHaveBeenCalled();
    expect(options.updateTaskContent).not.toHaveBeenCalled();
    expect(options.updateTaskExpectedMinutes).not.toHaveBeenCalled();
    expect(options.updateTaskAttentionItems).not.toHaveBeenCalled();

    rendered.setUserId('user-a');
    fixture.detectChanges();
    await flushPromiseTails();
    const stamped = readTextTaskEditorDraft({ ...ownerlessScope, userId: 'user-a' });
    expect(stamped).toMatchObject({
      title: '预认证标题', content: '预认证正文', expectedMinutes: '25',
    });
    expect(stamped?.attentionRows?.map(row => row.text)).toEqual(['预认证注意']);
  });

  it.each(['write', 'readback'] as const)(
    'keeps a failed trusted %s unconfirmed until an exact later readback',
    async failure => {
      const rendered = options.render(
        { id: 'unconfirmed-task', title: '服务端标题' },
        { userId: null, projectId: 'project-a' },
      );
      const fixture = options.getFixture();
      const component = fixture.componentInstance as unknown as {
        onTitleInput(value: string): void;
        localTitle(): string;
        draftPersistence: { readDraft(taskId: string): { title?: string } | null };
      };
      component.onTitleInput('仅内存标题');
      const actualGet = localStorage.getItem.bind(localStorage);
      const failureSpy = failure === 'write'
        ? vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); })
        : vi.spyOn(localStorage, 'getItem').mockImplementation(key =>
          key.includes('user-a') ? null : actualGet(key));
      try {
        rendered.setUserId('user-a');
        fixture.detectChanges();
        expect(component.draftPersistence.readDraft('unconfirmed-task')?.title).toBeUndefined();
        expect(component.localTitle()).toBe('仅内存标题');
      } finally {
        failureSpy.mockRestore();
      }

      rendered.setTask(createTask({
        id: 'unconfirmed-task', title: '服务端标题', updatedAt: '2026-07-31T00:00:00.000Z',
      }));
      fixture.detectChanges();
      expect(readTextTaskEditorDraft({
        userId: 'user-a', projectId: 'project-a', taskId: 'unconfirmed-task',
      })?.title).toBe('仅内存标题');
    },
  );

  it('keeps only the newest same-ticket value through overlapping confirmation retries', async () => {
    const rendered = options.render(
      { id: 'revision-task', title: '服务端标题' },
      { userId: null, projectId: 'project-a' },
    );
    const fixture = options.getFixture();
    const component = fixture.componentInstance as unknown as {
      onTitleInput(value: string): void;
      localTitle(): string;
      draftPersistence: { readDraft(taskId: string): { title?: string } | null };
    };
    component.onTitleInput('旧临时标题');

    const actualGet = localStorage.getItem.bind(localStorage);
    const actualSet = localStorage.setItem.bind(localStorage);
    let newerInjected = false;
    let failNextReadback = false;
    let completeOlderReadback = false;
    const getSpy = vi.spyOn(localStorage, 'getItem').mockImplementation(key => {
      if (failNextReadback && key.includes('user-a')) {
        failNextReadback = false;
        completeOlderReadback = true;
        return null;
      }
      if (completeOlderReadback && key.includes('user-a')) {
        completeOlderReadback = false;
        const raw = actualGet(key);
        if (!raw) return raw;
        const older = JSON.stringify({ ...JSON.parse(raw) as object, title: '旧临时标题' });
        actualSet(key, older);
        return older;
      }
      return actualGet(key);
    });
    const setSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      actualSet(key, value);
      if (!key.includes('user-a')) return;
      if (!newerInjected) {
        newerInjected = true;
        component.onTitleInput('最新临时标题');
      } else {
        failNextReadback = true;
      }
    });

    try {
      rendered.setUserId('user-a');
      fixture.detectChanges();
      expect(newerInjected).toBe(true);
      expect(component.localTitle()).toBe('最新临时标题');
    } finally {
      setSpy.mockRestore();
      getSpy.mockRestore();
    }

    expect(component.draftPersistence.readDraft('revision-task')?.title).toBe('最新临时标题');
    expect(readTextTaskEditorDraft({
      userId: 'user-a', projectId: 'project-a', taskId: 'revision-task',
    })?.title).toBe('最新临时标题');
    await flushPromiseTails();
  });

  it('does not publish a mismatched stamp after project or user ABA and confirms only a new exact write', async () => {
    const rendered = options.render(
      { id: 'mismatch-task', title: '服务端标题' },
      { userId: null, projectId: 'project-a' },
    );
    const fixture = options.getFixture();
    const component = fixture.componentInstance as unknown as {
      onTitleInput(value: string): void;
      localTitle(): string;
      draftPersistence: { readDraft(taskId: string): { title?: string } | null };
    };
    component.onTitleInput('未确认标题');
    const actualGet = localStorage.getItem.bind(localStorage);
    const mismatch = vi.spyOn(localStorage, 'getItem').mockImplementation(key => {
      const raw = actualGet(key);
      if (!raw || !key.includes('user-a')) return raw;
      const record = JSON.parse(raw) as Record<string, unknown>;
      return JSON.stringify({ ...record, title: '错误回读标题' });
    });
    rendered.setUserId('user-a'); fixture.detectChanges();
    expect(readTextTaskEditorDraft({
      userId: 'user-a', projectId: 'project-a', taskId: 'mismatch-task',
    })?.title).toBe('错误回读标题');
    options.switchProject('project-b');
    rendered.setProjectId('project-b');
    rendered.setTask(createTask({ id: 'mismatch-task', title: '服务端标题', updatedAt: '2026-07-31T00:00:01.000Z' }));
    fixture.detectChanges();
    options.switchProject('project-a');
    rendered.setProjectId('project-a');
    rendered.setTask(createTask({ id: 'mismatch-task', title: '服务端标题', updatedAt: '2026-07-31T00:00:02.000Z' }));
    fixture.detectChanges();
    expect(component.localTitle()).toBe('服务端标题');
    mismatch.mockRestore();
    rendered.setUserId('user-b'); fixture.detectChanges();
    rendered.setUserId('user-a'); fixture.detectChanges();
    expect(component.localTitle()).toBe('服务端标题');
    expect(component.draftPersistence.readDraft('mismatch-task')?.title).toBeUndefined();

    options.updateTaskTitle.mockResolvedValue(false);
    component.onTitleInput('已确认新标题');
    await flushPromiseTails();
    expect(component.draftPersistence.readDraft('mismatch-task')?.title).toBe('已确认新标题');
  });

  it('clears legacy ownerless fields without restoring or publishing them', () => {
    const scope = { userId: null, projectId: 'project-a', taskId: 'legacy-task' };
    writeTextTaskEditorDraftField(scope, 'title', '旧 ownerless 标题');
    writeTextTaskEditorDraftField(scope, 'content', '旧 ownerless 正文');
    writeTextTaskEditorDraftField(scope, 'expectedMinutes', '90');

    options.render(
      { id: 'legacy-task', title: '可信标题', content: '可信正文', expected_minutes: 15 },
      { userId: null, projectId: 'project-a' },
    );
    const component = options.getFixture().componentInstance as unknown as {
      localTitle(): string;
      localContent(): string;
      localExpectedMinutes(): string;
    };

    expect(component.localTitle()).toBe('可信标题');
    expect(component.localContent()).toBe('可信正文');
    expect(component.localExpectedMinutes()).toBe('15');
    expect(readTextTaskEditorDraft(scope)).toBeNull();
  });

  it('does not dedupe or settle a revived-user title through stale A completion', async () => {
    const oldSave = deferred<boolean>();
    const currentSave = deferred<boolean>();
    options.updateTaskTitle.mockReset();
    options.updateTaskTitle
      .mockImplementationOnce(() => oldSave.promise)
      .mockImplementationOnce(() => currentSave.promise);
    const rendered = options.render(
      { id: 'user-aba-task', title: '旧标题' },
      { userId: 'user-a', projectId: 'project-a' },
    );
    const fixture = options.getFixture();
    const component = fixture.componentInstance as unknown as {
      onTitleInput(value: string): void;
      textSaveState(): 'idle' | 'saving' | 'failed';
    };

    component.onTitleInput('相同草稿');
    rendered.setUserId('user-b'); fixture.detectChanges();
    rendered.setUserId('user-a'); fixture.detectChanges();
    component.onTitleInput('相同草稿');
    oldSave.resolve(true);
    await flushPromiseTails();

    const scope = { userId: 'user-a', projectId: 'project-a', taskId: 'user-aba-task' };
    expect(options.updateTaskTitle).toHaveBeenCalledTimes(2);
    expect(readTextTaskEditorDraft(scope)?.title).toBe('相同草稿');
    expect(component.textSaveState()).toBe('saving');
    currentSave.resolve(false);
    await flushPromiseTails();
    expect(component.textSaveState()).toBe('failed');
  });

  it('keeps revived-user planner and attention drafts fenced from stale completion', async () => {
    const oldPlanner = deferred<boolean>();
    const currentPlanner = deferred<boolean>();
    const oldAttention = deferred<boolean>();
    const currentAttention = deferred<boolean>();
    options.updateTaskExpectedMinutes.mockReset();
    options.updateTaskExpectedMinutes
      .mockImplementationOnce(() => oldPlanner.promise)
      .mockImplementationOnce(() => currentPlanner.promise);
    options.updateTaskAttentionItems.mockReset();
    options.updateTaskAttentionItems
      .mockImplementationOnce(() => oldAttention.promise)
      .mockImplementationOnce(() => currentAttention.promise);
    const rendered = options.render(
      { id: 'sidecar-aba-task', attentionMeta: createAttentionMeta() },
      { userId: 'user-a', projectId: 'project-a' },
    );
    const fixture = options.getFixture();
    const component = fixture.componentInstance as unknown as {
      onExpectedMinutesChange(value: string): Promise<boolean>;
      onAttentionInput(value: string): void;
      plannerSaveState(): 'idle' | 'saving' | 'failed';
      attentionSaveState(): 'idle' | 'saving' | 'failed';
    };

    const stalePlanner = component.onExpectedMinutesChange('25');
    component.onAttentionInput('相同注意');
    rendered.setUserId('user-b'); fixture.detectChanges();
    rendered.setUserId('user-a'); fixture.detectChanges();
    const activePlanner = component.onExpectedMinutesChange('25');
    component.onAttentionInput('相同注意');
    oldPlanner.resolve(true); oldAttention.resolve(true);
    await stalePlanner; await flushPromiseTails();

    const draft = readTextTaskEditorDraft({
      userId: 'user-a', projectId: 'project-a', taskId: 'sidecar-aba-task',
    });
    expect(draft?.expectedMinutes).toBe('25');
    expect(draft?.attentionRows?.map(row => row.text)).toEqual(['相同注意']);
    expect(component.plannerSaveState()).toBe('saving');
    expect(component.attentionSaveState()).toBe('saving');
    currentPlanner.resolve(false); currentAttention.resolve(false);
    await activePlanner; await flushPromiseTails();
    expect(component.plannerSaveState()).toBe('failed');
    expect(component.attentionSaveState()).toBe('failed');
  });

  it('flushes the latest A DOM value once while A is still visible, then retires before B teardown', async () => {
    const observedProjects: Array<string | null> = [];
    options.updateTaskTitle.mockImplementation(async () => {
      observedProjects.push(options.currentProjectId());
      return true;
    });
    const rendered = options.render(
      { id: 'shared-task', title: 'A title' },
      { userId: 'user-1', projectId: 'project-a' },
    );
    const fixture = options.getFixture();
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      persistCurrentEdits(): void;
      textOwner: ActiveProjectOwner & { taskId: string };
    };
    expect(component.textOwner).toEqual({ projectId: 'project-a', generation: 0, taskId: 'shared-task' });
    const persistSpy = vi.spyOn(component, 'persistCurrentEdits');
    component.isPreview.set(false);
    fixture.detectChanges();
    const titleInput = fixture.nativeElement.querySelector('[data-testid="task-title-input"]') as HTMLInputElement;
    titleInput.value = 'A final draft';

    options.switchProject('project-b');
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(options.updateTaskTitle).toHaveBeenCalledTimes(1);
    expect(options.updateTaskTitle).toHaveBeenCalledWith('shared-task', 'A final draft');
    expect(observedProjects).toEqual(['project-a']);

    rendered.setProjectId('project-b');
    rendered.setTask(createTask({ id: 'shared-task', title: 'B title' }));
    fixture.destroy();
    await flushPromiseTails();
    expect(options.updateTaskTitle).toHaveBeenCalledTimes(1);
  });

  it('does not run an A pending retry against same-ID B after the first A save fails', async () => {
    const firstSave = deferred<boolean>();
    options.updateTaskTitle.mockImplementationOnce(() => firstSave.promise);
    const rendered = options.render(
      { id: 'shared-task', title: 'A title' },
      { userId: 'user-1', projectId: 'project-a' },
    );
    const fixture = options.getFixture();
    const component = fixture.componentInstance as unknown as {
      onInputFocus(field: 'title'): void;
      onTitleInput(value: string): void;
    };
    component.onInputFocus('title');
    component.onTitleInput('A pending draft');

    options.switchProject('project-b');
    rendered.setProjectId('project-b');
    rendered.setTask(createTask({ id: 'shared-task', title: 'B title' }));
    fixture.destroy();
    firstSave.resolve(false);
    await firstSave.promise;
    await flushPromiseTails();

    expect(options.updateTaskTitle).toHaveBeenCalledTimes(1);
  });

  it('does not let stale A success clear B or revived-A drafts, while duplicate A stays valid', async () => {
    const firstSave = deferred<boolean>();
    options.updateTaskTitle.mockImplementationOnce(() => firstSave.promise);
    const rendered = options.render(
      { id: 'shared-task', title: 'A title' },
      { userId: 'user-1', projectId: 'project-a' },
    );
    const component = options.getFixture().componentInstance as unknown as {
      onTitleInput(value: string): void;
    };
    component.onTitleInput('shared draft');
    options.switchProject('project-a');

    options.switchProject('project-b');
    rendered.setProjectId('project-b');
    rendered.setTask(createTask({ id: 'shared-task', title: 'B title' }));
    const bScope: TextTaskEditorDraftScope = {
      userId: 'user-1', projectId: 'project-b', taskId: 'shared-task',
    };
    writeTextTaskEditorDraftField(bScope, 'title', 'shared draft');

    options.switchProject('project-a');
    rendered.setProjectId('project-a');
    rendered.setTask(createTask({ id: 'shared-task', title: 'A replacement' }));
    const revivedAScope: TextTaskEditorDraftScope = {
      userId: 'user-1', projectId: 'project-a', taskId: 'shared-task',
    };
    writeTextTaskEditorDraftField(revivedAScope, 'title', 'shared draft');

    firstSave.resolve(true);
    await firstSave.promise;
    await flushPromiseTails();

    expect(readTextTaskEditorDraft(bScope)?.title).toBe('shared draft');
    expect(readTextTaskEditorDraft(revivedAScope)?.title).toBe('shared draft');
    expect(options.updateTaskTitle).toHaveBeenCalledTimes(1);
  });
}
