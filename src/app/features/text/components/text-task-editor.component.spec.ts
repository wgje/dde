import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextTaskEditorComponent } from './text-task-editor.component';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { UndoService } from '../../../../services/undo.service';
import { AttachmentService } from '../../../../services/attachment.service';
import { ToastService } from '../../../../services/toast.service';
import type { Task } from '../../../../models';

describe('TextTaskEditorComponent', () => {
  let fixture: ComponentFixture<TextTaskEditorComponent>;

  const createClickEvent = (timeStamp: number, target: EventTarget = document.body) => ({
    timeStamp,
    target,
    stopPropagation: vi.fn(),
    composedPath: () => [target, document.body, document, window],
  } as unknown as MouseEvent);

  const mockTaskAdapter = {
    updateTaskTitle: vi.fn(),
    updateTaskContent: vi.fn(),
    addTodoItem: vi.fn(),
    updateTaskExpectedMinutes: vi.fn(),
    updateTaskWaitMinutes: vi.fn(),
    updateTaskCognitiveLoad: vi.fn(),
    updateTaskAttachments: vi.fn(),
  };

  const mockChangeTracker = {
    lockTaskField: vi.fn(),
    unlockTaskField: vi.fn(),
  };

  const mockUiState = {
    markEditing: vi.fn(),
  };

  const mockProjectState = {
    activeProjectId: vi.fn(() => null),
    compressDisplayId: vi.fn((displayId: string) => displayId),
    getTask: vi.fn(() => null),
  };

  const mockAttachmentService = {
    uploadFile: vi.fn(),
    markAsDeleted: vi.fn(),
  };

  const mockUndoService = {
    appliedReplay: signal(null),
  };

  const mockToast = {
    info: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  };

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '购置零件',
    content: '',
    status: 'active',
    stage: 1,
    order: 0,
    parentId: null,
    rank: 0,
    x: 0,
    y: 0,
    createdDate: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    displayId: '1,a',
    attachments: [],
    tags: [],
    parkingMeta: null,
    expected_minutes: null,
    wait_minutes: null,
    cognitive_load: null,
    ...overrides,
  });

  const render = (taskOverrides: Partial<Task> = {}) => {
    fixture = TestBed.createComponent(TextTaskEditorComponent);
    let currentTask = createTask(taskOverrides);
    const component = fixture.componentInstance as unknown as {
      task: () => Task;
      connections: () => TaskConnectionInfo | null;
      isMobile: () => boolean;
      userId: () => string | null;
      projectId: () => string | null;
      initialPreview: () => boolean;
    };

    component.task = () => currentTask;
    component.connections = () => null;
    component.isMobile = () => false;
    component.userId = () => null;
    component.projectId = () => null;
    component.initialPreview = () => true;
    fixture.detectChanges();

    return {
      setTask(nextTask: Task): void {
        currentTask = nextTask;
      },
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProjectState.getTask.mockReturnValue(null);
    mockUndoService.appliedReplay.set(null);

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
    }).compileComponents();
  });

  const createPathClickEvent = (target: EventTarget, path: EventTarget[], timeStamp = Date.now()) => ({
    timeStamp,
    target,
    stopPropagation: vi.fn(),
    composedPath: () => path,
  } as unknown as MouseEvent);

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

  it('should clear selected editor text on the first outside click and collapse on the next click', () => {
    vi.useFakeTimers();
    try {
      render({ content: '联系供应商确认规格。' });

      const component = fixture.componentInstance as unknown as {
        onDocumentClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
      titlePreview?.click();
      fixture.detectChanges();
      vi.runAllTimers();
      fixture.detectChanges();

      const removeAllRanges = vi.fn();
      const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => '零件',
        rangeCount: 1,
        isCollapsed: false,
        removeAllRanges,
      } as unknown as Selection);

      try {
        component.onDocumentClick(createClickEvent(Date.now(), document.body));
        fixture.detectChanges();

        expect(removeAllRanges).toHaveBeenCalledTimes(1);
        expect(component.isPreview()).toBe(false);
      } finally {
        getSelectionSpy.mockRestore();
      }

      component.onDocumentClick(createClickEvent(Date.now(), document.body));
      fixture.detectChanges();

      expect(component.isPreview()).toBe(true);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should collapse native input selection before leaving edit mode on outside click', () => {
    vi.useFakeTimers();
    const activeElementDescriptor = Object.getOwnPropertyDescriptor(document, 'activeElement');

    try {
      render({ content: '联系供应商确认规格。' });

      const component = fixture.componentInstance as unknown as {
        onDocumentClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const titlePreview = fixture.nativeElement.querySelector('[data-testid="task-title-preview"]') as HTMLButtonElement | null;
      titlePreview?.click();
      fixture.detectChanges();
      vi.runAllTimers();
      fixture.detectChanges();

      const titleInput = fixture.nativeElement.querySelector('[data-testid="task-title-input"]') as HTMLInputElement | null;
      expect(titleInput).not.toBeNull();

      const setSelectionRangeSpy = vi.spyOn(titleInput!, 'setSelectionRange');
      Object.defineProperty(titleInput!, 'selectionStart', {
        configurable: true,
        get: () => 0,
      });
      Object.defineProperty(titleInput!, 'selectionEnd', {
        configurable: true,
        get: () => 2,
      });
      Object.defineProperty(document, 'activeElement', {
        configurable: true,
        get: () => titleInput,
      });

      const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue(null);

      try {
        component.onDocumentClick(createClickEvent(Date.now(), document.body));
        fixture.detectChanges();

        expect(setSelectionRangeSpy).toHaveBeenCalledWith(2, 2);
        expect(component.isPreview()).toBe(false);
      } finally {
        getSelectionSpy.mockRestore();
        setSelectionRangeSpy.mockRestore();
      }
    } finally {
      if (activeElementDescriptor) {
        Object.defineProperty(document, 'activeElement', activeElementDescriptor);
      }
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should suppress the same document click when entering content editing from the empty preview button', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T00:00:00.000Z'));
    try {
      render({ content: '' });

      const component = fixture.componentInstance as unknown as {
        onDocumentClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const emptyPreview = fixture.nativeElement.querySelector('[data-testid="task-content-empty"]') as HTMLButtonElement | null;
      const editorRoot = fixture.nativeElement.querySelector('.animate-collapse-open') as HTMLElement | null;

      emptyPreview?.click();
      fixture.detectChanges();

      component.onDocumentClick(createPathClickEvent(emptyPreview!, [emptyPreview!, editorRoot!, document.body, document, window]));
      fixture.detectChanges();

      expect(component.isPreview()).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should suppress the same document click when entering content editing from the non-empty preview area', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T00:00:00.000Z'));
    try {
      render({ content: '联系供应商确认规格。' });

      const component = fixture.componentInstance as unknown as {
        onDocumentClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const contentPreview = fixture.nativeElement.querySelector('[data-testid="task-content"]') as HTMLElement | null;
      const editorRoot = fixture.nativeElement.querySelector('.animate-collapse-open') as HTMLElement | null;

      contentPreview?.click();
      fixture.detectChanges();

      component.onDocumentClick(createPathClickEvent(contentPreview!, [contentPreview!, editorRoot!, document.body, document, window]));
      fixture.detectChanges();

      expect(component.isPreview()).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should keep editing open when the original preview trigger node has been detached before document click runs', () => {
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
      expect(fixture.nativeElement.querySelector('[data-testid="task-title-input"]')).not.toBeNull();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('should keep preview mode when clicking an external markdown link', () => {
    render({ content: '[官网](https://example.com)' });

    const component = fixture.componentInstance as unknown as {
      onPreviewClick: (event: MouseEvent) => void;
      isPreview: () => boolean;
    };
    const link = fixture.nativeElement.querySelector('[data-testid="task-content"] a[data-link-kind="external"]') as HTMLAnchorElement | null;
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    component.onPreviewClick({ target: link, stopPropagation, preventDefault } as unknown as MouseEvent);
    fixture.detectChanges();

    expect(component.isPreview()).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="task-title-input"]')).toBeNull();
  });

  it('should emit openLinkedTask when clicking a task markdown link', () => {
    render({ content: '[跳转](task:linked-task)' });

    const component = fixture.componentInstance as unknown as {
      onPreviewClick: (event: MouseEvent) => void;
      isPreview: () => boolean;
      openLinkedTask: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(component.openLinkedTask, 'emit');
    const link = fixture.nativeElement.querySelector('[data-testid="task-content"] a[data-link-kind="task"]') as HTMLAnchorElement | null;
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const event = { target: link, stopPropagation, preventDefault } as unknown as MouseEvent;

    component.onPreviewClick(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith({ taskId: 'linked-task', event });
    expect(component.isPreview()).toBe(true);
  });

  it('should block unsafe markdown links without entering edit mode', () => {
    render({ content: '[危险](javascript:alert(1))' });

    const component = fixture.componentInstance as unknown as {
      onPreviewClick: (event: MouseEvent) => void;
      isPreview: () => boolean;
    };
    const link = fixture.nativeElement.querySelector('[data-testid="task-content"] a[data-link-kind="blocked"]') as HTMLAnchorElement | null;
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    component.onPreviewClick({ target: link, stopPropagation, preventDefault } as unknown as MouseEvent);

    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    expect(component.isPreview()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="task-title-input"]')).toBeNull();
  });

  it('should keep preview mode when clicking a local markdown link', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      render({ content: '本地路径' });

      const component = fixture.componentInstance as unknown as {
        onPreviewClick: (event: MouseEvent) => void;
        isPreview: () => boolean;
      };
      const link = document.createElement('a');
      link.setAttribute('href', '#local-path');
      link.setAttribute('data-link-kind', 'local');
      link.setAttribute('data-local-link-path', 'C:\\Docs\\Plan.md');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      component.onPreviewClick({ target: link, stopPropagation, preventDefault } as unknown as MouseEvent);
      await Promise.resolve();

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(component.isPreview()).toBe(true);
      expect(writeText).toHaveBeenCalledWith('C:\\Docs\\Plan.md');
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });

  it('should replay recovered content into the focused local editor after undo', () => {
    const task = createTask({ content: '旧内容' });
    const rendered = render({ content: '旧内容' });

    const component = fixture.componentInstance as unknown as {
      enterEditMode: (field: 'title' | 'content', event?: Event) => void;
      onInputFocus: (field: 'title' | 'content' | 'todo') => void;
      localContent: { (): string; set: (value: string) => void };
    };

    component.enterEditMode('content');
    fixture.detectChanges();
    component.onInputFocus('content');
    component.localContent.set('');

    rendered.setTask({ ...task, content: '恢复后的内容' });
    fixture.detectChanges();
    expect(component.localContent()).toBe('');

    mockUndoService.appliedReplay.set({
      sequence: 1,
      kind: 'undo',
      projectId: 'project-1',
      taskFieldChanges: { 'task-1': ['content'] },
    });
    fixture.detectChanges();

    expect(component.localContent()).toBe('恢复后的内容');

    component.localContent.set('继续编辑');
    rendered.setTask({ ...task, content: '回放后的远端更新' });
    fixture.detectChanges();

    expect(component.localContent()).toBe('继续编辑');
  });
});