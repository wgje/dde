import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextTaskEditorComponent } from './text-task-editor.component';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService, TaskConnectionInfo } from '../../../../services/project-state.service';
import { AttachmentService } from '../../../../services/attachment.service';
import { ToastService } from '../../../../services/toast.service';
import type { Task } from '../../../../models';

describe('TextTaskEditorComponent', () => {
  let fixture: ComponentFixture<TextTaskEditorComponent>;

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
  };

  const mockAttachmentService = {
    uploadFile: vi.fn(),
    markAsDeleted: vi.fn(),
  };

  const mockToast = {
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
    projectId: 'project-1',
    parentId: null,
    level: 0,
    path: 'task-1',
    sortKey: 'task-1',
    createdAt: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    userId: 'local-user',
    isExpanded: false,
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
    const component = fixture.componentInstance as unknown as {
      task: () => Task;
      connections: () => TaskConnectionInfo | null;
      isMobile: () => boolean;
      userId: () => string | null;
      projectId: () => string | null;
      initialPreview: () => boolean;
    };

    component.task = () => createTask(taskOverrides);
    component.connections = () => null;
    component.isMobile = () => false;
    component.userId = () => null;
    component.projectId = () => null;
    component.initialPreview = () => true;
    fixture.detectChanges();
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [TextTaskEditorComponent],
      providers: [
        { provide: TaskOperationAdapterService, useValue: mockTaskAdapter },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();
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
    expect(preview?.className).toContain('max-h-40');
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
});