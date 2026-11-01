import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextTaskEditorComponent } from './text-task-editor.component';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { UndoService } from '../../../../services/undo.service';
import type { UndoAppliedReplay } from '../../../../services/undo.service';
import { AttachmentService } from '../../../../services/attachment.service';
import { ToastService } from '../../../../services/toast.service';
import type { Task } from '../../../../models';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';
import { KnowledgeAnchorStubComponent } from '../../../../tests/stubs/knowledge-anchor.stub';
import { createClickEvent, createPathClickEvent, createTask } from './text-task-editor.test-harness';
import { registerTextTaskEditorAttentionSpecs } from './text-task-editor-attention.spec-helpers';
import { registerTextTaskEditorMarkdownLinkSpecs } from './text-task-editor-markdown-link.spec-helpers';
import { registerTextTaskEditorPlannerSpecs } from './text-task-editor-planner.spec-helpers';
import { registerTextTaskEditorPreviewStateSpecs } from './text-task-editor-preview-state.spec-helpers';
import { createTextTaskEditorProjectStateHarness, registerTextTaskEditorProjectOwnershipSpecs } from './text-task-editor-project-ownership.spec-helpers';
import { registerTextTaskEditorSelectionSpecs } from './text-task-editor-selection.spec-helpers';

describe('TextTaskEditorComponent', () => {
  let fixture: ComponentFixture<TextTaskEditorComponent>;

  const mockTaskAdapter = {
    updateTaskTitle: vi.fn(),
    updateTaskContent: vi.fn(),
    addTodoItem: vi.fn(),
    updateTaskExpectedMinutes: vi.fn(),
    updateTaskWaitMinutes: vi.fn(),
    updateTaskCognitiveLoad: vi.fn(),
    updateTaskAttentionItems: vi.fn(),
    updateTaskAttachments: vi.fn(),
  };

  const mockChangeTracker = {
    lockTaskField: vi.fn(),
    unlockTaskField: vi.fn(),
  };

  const mockUiState = {
    markEditing: vi.fn(),
  };

  const projectOwnership = createTextTaskEditorProjectStateHarness();
  const mockProjectState = projectOwnership.service;
  const mockAttachmentService = {
    uploadFile: vi.fn(),
    markAsDeleted: vi.fn(),
  };

  const mockUndoService = {
    appliedReplay: signal<UndoAppliedReplay | null>(null),
  };

  const mockToast = {
    info: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  };

  const render = (
    taskOverrides: Partial<Task> = {},
    inputOverrides: { userId?: string | null; projectId?: string | null } = {},
  ) => {
    if (inputOverrides.projectId) projectOwnership.setCurrentProject(inputOverrides.projectId);
    fixture = TestBed.createComponent(TextTaskEditorComponent);
    const currentTask = signal(createTask(taskOverrides));
    const currentUserId = signal(inputOverrides.userId === undefined ? 'user-1' : inputOverrides.userId);
    const currentProjectId = signal(inputOverrides.projectId ?? null);
    const component = fixture.componentInstance as unknown as {
      task: () => Task;
      connections: () => TaskConnectionInfo | null;
      isMobile: () => boolean;
      userId: () => string | null;
      projectId: () => string | null;
      initialPreview: () => boolean;
    };

    component.task = currentTask;
    component.connections = () => null;
    component.isMobile = () => false;
    component.userId = currentUserId;
    component.projectId = currentProjectId;
    component.initialPreview = () => true;
    fixture.detectChanges();

    return {
      setTask: (nextTask: Task) => currentTask.set(nextTask),
      setUserId: (nextUserId: string | null) => currentUserId.set(nextUserId),
      setProjectId: (nextProjectId: string | null) => currentProjectId.set(nextProjectId),
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    projectOwnership.reset();
    mockProjectState.getTask.mockReturnValue(null);
    mockUndoService.appliedReplay.set(null);
    mockTaskAdapter.updateTaskTitle.mockResolvedValue(true);
    mockTaskAdapter.updateTaskContent.mockResolvedValue(true);
    mockTaskAdapter.addTodoItem.mockResolvedValue(true);
    mockTaskAdapter.updateTaskExpectedMinutes.mockResolvedValue(true);
    mockTaskAdapter.updateTaskWaitMinutes.mockResolvedValue(true);
    mockTaskAdapter.updateTaskCognitiveLoad.mockResolvedValue(true);
    mockTaskAdapter.updateTaskAttentionItems.mockResolvedValue(true);
    mockTaskAdapter.updateTaskAttachments.mockResolvedValue(true);

    await TestBed.configureTestingModule({
      imports: [TextTaskEditorComponent],
      providers: [
        { provide: TaskOperationAdapterService, useValue: mockTaskAdapter },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: UndoService, useValue: mockUndoService },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: ToastService, useValue: mockToast },
      ],
    })
      .overrideComponent(TextTaskEditorComponent, {
        remove: { imports: [KnowledgeAnchorComponent] },
        add: { imports: [KnowledgeAnchorStubComponent] },
      })
      .compileComponents();
  });

  registerTextTaskEditorProjectOwnershipSpecs({ getFixture: () => fixture, render,
    switchProject: projectOwnership.switchProject, currentProjectId: projectOwnership.currentProjectId,
    updateTaskTitle: mockTaskAdapter.updateTaskTitle, updateTaskContent: mockTaskAdapter.updateTaskContent,
    updateTaskExpectedMinutes: mockTaskAdapter.updateTaskExpectedMinutes,
    updateTaskAttentionItems: mockTaskAdapter.updateTaskAttentionItems,
  });

  it('restores same-owner title, content, and attention drafts after recreation', async () => {
    mockTaskAdapter.updateTaskTitle.mockResolvedValue(false);
    mockTaskAdapter.updateTaskContent.mockResolvedValue(false);
    mockTaskAdapter.updateTaskAttentionItems.mockResolvedValue(false);
    const task = createTask({
      id: 'draft-recovery', title: '旧标题', content: '旧内容',
      attentionMeta: { items: [], updatedAt: '2026-06-05T00:00:00.000Z' },
    });
    render(task, { userId: 'user-1', projectId: 'project-a' });
    let component = fixture.componentInstance as unknown as {
      onTitleInput(value: string): void;
      onContentInput(value: string): void;
      onAttentionInput(value: string): void;
    };
    component.onTitleInput('恢复标题');
    component.onContentInput('恢复正文');
    component.onAttentionInput('恢复注意');
    await Promise.resolve();
    fixture.destroy();

    render(task, { userId: 'user-1', projectId: 'project-a' });
    component = fixture.componentInstance as typeof component;
    const restored = component as unknown as {
      localTitle(): string;
      localContent(): string;
      localAttentionDraft(): string;
    };
    expect([restored.localTitle(), restored.localContent(), restored.localAttentionDraft()])
      .toEqual(['恢复标题', '恢复正文', '恢复注意']);
  });

  registerTextTaskEditorMarkdownLinkSpecs({
    getFixture: () => fixture,
    render,
  });

  it('should keep the preview compact when the task has no description', () => {
    render({ content: '' });

    const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
    const emptyPreview = fixture.nativeElement.querySelector('[data-testid="task-content-empty"]') as HTMLButtonElement | null;

    expect(titlePreview?.textContent).toContain('购置零件');
    expect(fixture.nativeElement.querySelector('[data-testid="task-title-input"]')).toBeNull();
    expect(emptyPreview).not.toBeNull();
    expect(emptyPreview?.textContent).toContain('点击输入内容');
    expect(emptyPreview?.className).not.toContain('min-h-24');
    expect(emptyPreview?.className).not.toContain('min-h-28');
  });

  it('should use an adaptive preview container for short descriptions instead of a fixed minimum height', () => {
    render({ content: '联系供应商确认规格。' });

    const preview = fixture.nativeElement.querySelector('[data-testid="task-content"]') as HTMLElement | null;

    expect(preview).not.toBeNull();
    expect(preview?.className).toContain('markdown-preview-adaptive');
    expect(preview?.className).toContain('max-h-20');
    expect(preview?.className).toContain('overflow-hidden');
    expect(preview?.className).not.toContain('min-h-24');
    expect(preview?.className).not.toContain('min-h-28');
  });

  it('should focus the title input when switching from compact preview into edit mode by clicking the preview title', () => {
    vi.useFakeTimers();
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus');
    const selectSpy = vi.spyOn(HTMLInputElement.prototype, 'select');
    try {
      render({ content: '联系供应商确认规格。' });

      const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
      titlePreview?.click();
      fixture.detectChanges();
      vi.runAllTimers();
      fixture.detectChanges();

      const titleInput = fixture.nativeElement.querySelector('[data-testid="task-title-input"]') as HTMLInputElement | null;

      expect(fixture.nativeElement.querySelector('[data-testid="task-title-preview"]')).toBeNull();
      expect(titleInput).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="task-content-editor"]')).not.toBeNull();
      expect(focusSpy).toHaveBeenCalled();
      expect(selectSpy).toHaveBeenCalled();
    } finally {
      focusSpy.mockRestore();
      selectSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should use the long text-input field lock while editing the title', () => {
    render();
    mockProjectState.activeProjectId.mockReturnValue('project-1');
    const component = fixture.componentInstance as unknown as {
      onInputFocus: (field: 'title' | 'content' | 'todo') => void;
    };

    component.onInputFocus('title');

    expect(mockChangeTracker.lockTaskField).toHaveBeenCalledWith(
      'task-1',
      'project-1',
      'title',
      ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS,
    );
  });
  it('should replace stale title unlock timers when blur fires repeatedly', () => {
    vi.useFakeTimers();
    try {
      render();
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      const component = fixture.componentInstance as unknown as { onInputBlur: (field: 'title' | 'content' | 'todo') => void };
      component.onInputBlur('title'); component.onInputBlur('title');
      vi.advanceTimersByTime(10_000);
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledTimes(1);
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-1', 'project-1', 'title');
    } finally {
      vi.runOnlyPendingTimers(); vi.useRealTimers();
    }
  });

  it('blur 产生的解锁定时器 handle 为 0 时，重新聚焦也必须取消它（防止聚焦中被远程覆盖）', () => {
    render();
    mockProjectState.activeProjectId.mockReturnValue('project-1');
    const component = fixture.componentInstance as unknown as {
      onInputFocus: (field: 'title' | 'content' | 'todo') => void;
      onInputBlur: (field: 'title' | 'content' | 'todo') => void;
      unlockTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const zeroTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => zeroTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    try {
      component.onInputBlur('title');
      expect(component.unlockTimers.get('title')).toBe(zeroTimer);

      component.onInputFocus('title');

      // handle 为 0 的解锁定时器若漏清理，会在字段聚焦且锁定期间触发解锁，
      // 让 store->local 同步恢复并覆盖正在输入的内容
      expect(clearTimeoutSpy).toHaveBeenCalledWith(zeroTimer);
      expect(component.unlockTimers.has('title')).toBe(false);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('should not dispatch duplicate content updates when input is followed by blur with the same value', () => {
    render({ content: '旧内容' });
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      onContentInput: (value: string) => void;
      onInputBlur: (field: 'title' | 'content' | 'todo') => void;
    };
    component.isPreview.set(false);
    fixture.detectChanges();
    const contentInput = fixture.nativeElement.querySelector('[data-testid="task-content-editor"]') as HTMLTextAreaElement | null;
    expect(contentInput).not.toBeNull();

    component.onContentInput('新内容');
    contentInput!.value = '新内容';
    component.onInputBlur('content');

    expect(mockTaskAdapter.updateTaskContent).toHaveBeenCalledTimes(1);
    expect(mockTaskAdapter.updateTaskContent).toHaveBeenCalledWith('task-1', '新内容');
  });

  it('should not dispatch duplicate title updates when input is followed by blur with the same value', () => {
    render({ title: '旧标题' });
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      onTitleInput: (value: string) => void;
      onInputBlur: (field: 'title' | 'content' | 'todo') => void;
    };
    component.isPreview.set(false);
    fixture.detectChanges();
    const titleInput = fixture.nativeElement.querySelector('[data-testid="task-title-input"]') as HTMLInputElement | null;
    expect(titleInput).not.toBeNull();

    component.onTitleInput('新标题');
    titleInput!.value = '新标题';
    component.onInputBlur('title');

    expect(mockTaskAdapter.updateTaskTitle).toHaveBeenCalledTimes(1);
    expect(mockTaskAdapter.updateTaskTitle).toHaveBeenCalledWith('task-1', '新标题');
  });

  it('should keep failed title draft when a stale task input arrives after blur unlock', async () => {
    vi.useFakeTimers();
    try {
      const { setTask } = render({ title: '旧标题' });
      mockTaskAdapter.updateTaskTitle.mockResolvedValue(false);
      const component = fixture.componentInstance as unknown as {
        isPreview: { set(value: boolean): void };
        onInputFocus: (field: 'title' | 'content' | 'todo') => void;
        onInputBlur: (field: 'title' | 'content' | 'todo') => void;
        onTitleInput: (value: string) => void;
        localTitle: () => string;
        textSaveState: () => 'idle' | 'saving' | 'failed';
      };
      component.isPreview.set(false);
      fixture.detectChanges();
      const titleInput = fixture.nativeElement.querySelector('[data-testid="task-title-input"]') as HTMLInputElement | null;
      expect(titleInput).not.toBeNull();

      component.onInputFocus('title');
      component.onTitleInput('离线失败标题');
      titleInput!.value = '离线失败标题';
      await Promise.resolve();
      await Promise.resolve();
      component.onInputBlur('title');
      vi.advanceTimersByTime(10_000);
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }

      setTask(createTask({
        title: '旧标题',
        updatedAt: '2026-04-04T08:01:00.000Z',
      }));
      fixture.detectChanges();

      expect(mockTaskAdapter.updateTaskTitle).toHaveBeenCalledWith('task-1', '离线失败标题');
      expect(component.localTitle()).toBe('离线失败标题');
      expect(component.textSaveState()).toBe('failed');
      expect(fixture.nativeElement.textContent).toContain('任务文本本地保存失败');
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should settle a rejected title save as failed and allow the same draft to retry', async () => {
    const submitError = new Error('title save rejected');
    mockTaskAdapter.updateTaskTitle
      .mockRejectedValueOnce(submitError)
      .mockResolvedValueOnce(true);
    render({ title: '旧标题' });
    const component = fixture.componentInstance as unknown as {
      onTitleInput(value: string): void;
      textSaveState(): 'idle' | 'saving' | 'failed';
    };

    component.onTitleInput('可重试标题');
    await vi.waitFor(() => {
      expect(component.textSaveState()).toBe('failed');
    });

    component.onTitleInput('可重试标题');
    await vi.waitFor(() => {
      expect(mockTaskAdapter.updateTaskTitle).toHaveBeenCalledTimes(2);
      expect(component.textSaveState()).toBe('idle');
    });
  });

  it('should keep a same-value retry pending until an in-flight rejected title save settles', async () => {
    const submitError = new Error('title save rejected');
    let rejectFirst!: (error: Error) => void;
    mockTaskAdapter.updateTaskTitle
      .mockImplementationOnce(() => new Promise<boolean>((_, reject) => {
        rejectFirst = reject;
      }))
      .mockResolvedValueOnce(true);
    render({ title: '旧标题' });
    const component = fixture.componentInstance as unknown as {
      onTitleInput(value: string): void;
      textSaveState(): 'idle' | 'saving' | 'failed';
    };

    component.onTitleInput('可重试标题');
    component.onTitleInput('可重试标题');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockTaskAdapter.updateTaskTitle).toHaveBeenCalledTimes(1);
    expect(component.textSaveState()).toBe('saving');

    rejectFirst(submitError);

    await vi.waitFor(() => {
      expect(mockTaskAdapter.updateTaskTitle).toHaveBeenCalledTimes(2);
      expect(component.textSaveState()).toBe('idle');
    });
  });

  it('should unlock the blurred content field for the original task and project after selection changes', () => {
    vi.useFakeTimers();
    try {
      const { setTask } = render({ id: 'task-1', content: '旧内容' });
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      const component = fixture.componentInstance as unknown as {
        onInputBlur: (field: 'title' | 'content' | 'todo') => void;
      };

      component.onInputBlur('content');
      setTask(createTask({ id: 'task-2', content: '另一个任务' }));
      mockProjectState.activeProjectId.mockReturnValue('project-2');
      vi.advanceTimersByTime(10_000);

      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledTimes(1);
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-1', 'project-1', 'content');
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should lock attentionMeta while editing attention rows', () => {
    vi.useFakeTimers();
    try {
      render();
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      const component = fixture.componentInstance as unknown as {
        onAttentionFocus: () => void;
        onAttentionBlur: () => void;
      };

      component.onAttentionFocus();

      expect(mockChangeTracker.lockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'attentionMeta',
        ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS,
      );

      component.onAttentionBlur();
      expect(mockChangeTracker.unlockTaskField).not.toHaveBeenCalledWith('task-1', 'project-1', 'attentionMeta');

      vi.advanceTimersByTime(10_000);

      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-1', 'project-1', 'attentionMeta');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should ignore the same document click that opened title editing from preview', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T00:00:00.000Z'));
    try {
      render({ content: '联系供应商确认规格。' });

      const component = fixture.componentInstance as unknown as {
        onDocumentClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
      const editorRoot = fixture.nativeElement.querySelector('.animate-collapse-open') as HTMLElement | null;

      titlePreview?.click();
      fixture.detectChanges();

      component.onDocumentClick(createPathClickEvent(titlePreview!, [titlePreview!, editorRoot!, document.body, document, window]));
      fixture.detectChanges();

      expect(component.isPreview()).toBe(false);

      vi.advanceTimersByTime(250);
      component.onDocumentClick(createClickEvent(Date.now(), document.body));
      fixture.detectChanges();

      expect(component.isPreview()).toBe(true);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should clear preview text selection when clicking outside while already in preview mode', () => {
    render({ content: '联系供应商确认规格。' });

    const component = fixture.componentInstance as unknown as {
      onDocumentClick: (event: MouseEvent) => void;
      isPreview: () => boolean;
    };
    const removeAllRanges = vi.fn();
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '供应商',
      rangeCount: 1,
      isCollapsed: false,
      removeAllRanges,
    } as unknown as Selection);

    try {
      component.onDocumentClick(createClickEvent(Date.now(), document.body));

      expect(removeAllRanges).toHaveBeenCalledTimes(1);
      expect(component.isPreview()).toBe(true);
    } finally {
      getSelectionSpy.mockRestore();
    }
  });

  it('should emit attachment error when desktop attachment changes fail local durable persistence', async () => {
    render();
    mockTaskAdapter.updateTaskAttachments.mockResolvedValueOnce(false);
    const emitSpy = vi.spyOn(fixture.componentInstance.attachmentError, 'emit');
    const attachments = [{
      id: 'attachment-failed',
      type: 'file',
      name: 'failed.txt',
      url: 'nanoflow-local-attachment://attachment-failed',
      createdAt: '2026-06-01T00:00:00.000Z',
    }] as const;
    const component = fixture.componentInstance as unknown as {
      onAttachmentsChange: (nextAttachments: typeof attachments) => Promise<void>;
    };

    await component.onAttachmentsChange(attachments);

    expect(mockTaskAdapter.updateTaskAttachments).toHaveBeenCalledWith('task-1', attachments);
    expect(emitSpy).toHaveBeenCalledWith('附件本地保存失败，请释放浏览器存储空间后重试');
  });

  it('should keep quick todo input when local durable add fails', async () => {
    render();
    mockTaskAdapter.addTodoItem.mockResolvedValueOnce(false);
    const input = document.createElement('input');
    input.value = '  本地队列验收  ';
    const focusSpy = vi.spyOn(input, 'focus');
    const component = fixture.componentInstance as unknown as {
      addQuickTodo(inputElement: HTMLInputElement): Promise<boolean>;
    };

    const saved = await component.addQuickTodo(input);

    expect(saved).toBe(false);
    expect(mockTaskAdapter.addTodoItem).toHaveBeenCalledWith('task-1', '本地队列验收');
    expect(input.value).toBe('  本地队列验收  ');
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('should serialize quick todo triggers while a durable add is pending', async () => {
    let resolveFirstAdd!: (saved: boolean) => void;
    mockTaskAdapter.addTodoItem
      .mockImplementationOnce(() => new Promise<boolean>(resolve => {
        resolveFirstAdd = resolve;
      }))
      .mockResolvedValueOnce(true);
    render();

    const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement;
    titlePreview.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('input[placeholder^="输入待办内容"]') as HTMLInputElement;
    const addButton = fixture.nativeElement.querySelector('button[title="添加待办"]') as HTMLButtonElement;
    const focusSpy = vi.spyOn(input, 'focus');
    input.value = '  待确认条目  ';

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    addButton.click();

    expect(mockTaskAdapter.addTodoItem).toHaveBeenCalledTimes(1);
    expect(mockTaskAdapter.addTodoItem).toHaveBeenCalledWith('task-1', '待确认条目');
    expect(input.value).toBe('  待确认条目  ');
    expect(addButton.disabled).toBe(true);
    expect(addButton.getAttribute('aria-busy')).toBe('true');

    resolveFirstAdd(false);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(addButton.disabled).toBe(false);
      expect(addButton.getAttribute('aria-busy')).toBe('false');
    });

    expect(input.value).toBe('  待确认条目  ');
    expect(focusSpy).not.toHaveBeenCalled();

    addButton.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(mockTaskAdapter.addTodoItem).toHaveBeenCalledTimes(2);
      expect(input.value).toBe('');
      expect(focusSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('should preserve a newer quick todo input value when an older add succeeds', async () => {
    let resolveAdd!: (saved: boolean) => void;
    mockTaskAdapter.addTodoItem.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      resolveAdd = resolve;
    }));
    render();
    const input = document.createElement('input');
    input.value = '  原待办  ';
    const focusSpy = vi.spyOn(input, 'focus');
    const component = fixture.componentInstance as unknown as {
      addQuickTodo(inputElement: HTMLInputElement): Promise<boolean>;
    };
    const addPromise = component.addQuickTodo(input);
    input.value = '新待办草稿';
    resolveAdd(true);
    await expect(addPromise).resolves.toBe(true);
    expect(mockTaskAdapter.addTodoItem).toHaveBeenCalledWith('task-1', '原待办');
    expect(input.value).toBe('新待办草稿');
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('should not clear or focus a stale quick todo input after the task changes', async () => {
    let resolveAdd!: (saved: boolean) => void;
    mockTaskAdapter.addTodoItem.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      resolveAdd = resolve;
    }));
    const { setTask } = render();
    const input = document.createElement('input');
    input.value = '旧任务待办';
    const focusSpy = vi.spyOn(input, 'focus');
    const component = fixture.componentInstance as unknown as {
      addQuickTodo(inputElement: HTMLInputElement): Promise<boolean>;
    };
    const addPromise = component.addQuickTodo(input);
    setTask(createTask({ id: 'task-2' }));
    fixture.detectChanges();
    resolveAdd(true);
    await expect(addPromise).resolves.toBe(true);
    expect(mockTaskAdapter.addTodoItem).toHaveBeenCalledWith('task-1', '旧任务待办');
    expect(input.value).toBe('旧任务待办');
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('should not clear or focus quick todo input after the component is destroyed', async () => {
    let resolveAdd!: (saved: boolean) => void;
    mockTaskAdapter.addTodoItem.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      resolveAdd = resolve;
    }));
    render();
    const input = document.createElement('input');
    input.value = '销毁前待办';
    const focusSpy = vi.spyOn(input, 'focus');
    const component = fixture.componentInstance as unknown as {
      addQuickTodo(inputElement: HTMLInputElement): Promise<boolean>;
    };
    const addPromise = component.addQuickTodo(input);
    fixture.destroy();
    resolveAdd(true);
    await expect(addPromise).resolves.toBe(true);
    expect(input.value).toBe('销毁前待办');
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('quick todo rejected'))],
    ['throws', () => { throw new Error('quick todo threw'); }],
  ] as const)('should fail closed and allow retry when durable add %s', async (_failureMode, failAdd) => {
    mockTaskAdapter.addTodoItem.mockReset();
    mockTaskAdapter.addTodoItem
      .mockImplementationOnce(failAdd)
      .mockResolvedValueOnce(true);
    render();
    const input = document.createElement('input');
    input.value = '  可重试待办  ';
    const focusSpy = vi.spyOn(input, 'focus');
    const component = fixture.componentInstance as unknown as {
      addQuickTodo(inputElement: HTMLInputElement): Promise<boolean>;
    };
    await expect(component.addQuickTodo(input)).resolves.toBe(false);
    expect(input.value).toBe('  可重试待办  ');
    expect(focusSpy).not.toHaveBeenCalled();
    await expect(component.addQuickTodo(input)).resolves.toBe(true);
    expect(mockTaskAdapter.addTodoItem).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('should keep local todo checkbox preview unchanged when durable content update fails', async () => {
    render({ content: '- [ ] 本地优先' });
    mockTaskAdapter.updateTaskContent.mockResolvedValueOnce(false);
    const component = fixture.componentInstance as unknown as {
      onPreviewClick(event: MouseEvent): Promise<void>;
      localContent: () => string;
    };
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('data-todo-index', '0');
    const stopPropagation = vi.fn();

    await component.onPreviewClick({ target: checkbox, stopPropagation } as unknown as MouseEvent);

    expect(mockTaskAdapter.updateTaskContent).toHaveBeenCalledWith('task-1', '- [x] 本地优先');
    expect(component.localContent()).toBe('- [ ] 本地优先');
  });

  registerTextTaskEditorSelectionSpecs({
    getFixture: () => fixture,
    render,
  });

  registerTextTaskEditorAttentionSpecs({
    getFixture: () => fixture,
    render,
    updateTaskAttentionItems: mockTaskAdapter.updateTaskAttentionItems,
  });

  registerTextTaskEditorPlannerSpecs({
    getFixture: () => fixture,
    render,
    updateTaskExpectedMinutes: mockTaskAdapter.updateTaskExpectedMinutes,
    updateTaskWaitMinutes: mockTaskAdapter.updateTaskWaitMinutes,
    updateTaskCognitiveLoad: mockTaskAdapter.updateTaskCognitiveLoad,
  });

  registerTextTaskEditorPreviewStateSpecs({
    getFixture: () => fixture,
    render,
    setUndoReplay: (replay) => mockUndoService.appliedReplay.set(replay),
  });
});
