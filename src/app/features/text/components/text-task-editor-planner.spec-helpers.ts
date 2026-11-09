import type { ComponentFixture } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { createTask } from './text-task-editor.test-harness';
import { TextTaskEditorComponent } from './text-task-editor.component';

interface RenderOptions {
  userId?: string | null;
  projectId?: string | null;
}

export interface TextTaskEditorPlannerSpecContext {
  getFixture(): ComponentFixture<TextTaskEditorComponent>;
  render(taskOverrides?: Partial<Task>, options?: RenderOptions): {
    setTask(nextTask: Task): void;
  };
  updateTaskExpectedMinutes: ReturnType<typeof vi.fn>;
  updateTaskWaitMinutes: ReturnType<typeof vi.fn>;
  updateTaskCognitiveLoad: ReturnType<typeof vi.fn>;
}

export function registerTextTaskEditorPlannerSpecs(
  context: TextTaskEditorPlannerSpecContext,
): void {
  it('should restore unsaved planner drafts after the editor is destroyed and recreated', async () => {
    context.updateTaskExpectedMinutes.mockResolvedValue(false);
    context.updateTaskWaitMinutes.mockResolvedValue(false);
    context.updateTaskCognitiveLoad.mockResolvedValue(false);
    context.render(
      {
        id: 'task-planner-draft-recovery',
        expected_minutes: null,
        wait_minutes: null,
        cognitive_load: null,
      },
      { userId: 'user-1', projectId: 'project-1' },
    );
    const fixture = context.getFixture();
    const component = fixture.componentInstance as unknown as {
      isPreview: { set(value: boolean): void };
      onExpectedMinutesChange(value: string): Promise<boolean>;
      onWaitMinutesChange(value: string): Promise<boolean>;
      onCognitiveLoadChange(value: string): Promise<boolean>;
    };
    component.isPreview.set(false);
    fixture.detectChanges();

    await component.onExpectedMinutesChange('25');
    await component.onWaitMinutesChange('8');
    await component.onCognitiveLoadChange('high');
    fixture.destroy();

    context.render(
      {
        id: 'task-planner-draft-recovery',
        expected_minutes: null,
        wait_minutes: null,
        cognitive_load: null,
      },
      { userId: 'user-1', projectId: 'project-1' },
    );
    const restored = context.getFixture().componentInstance as unknown as {
      localExpectedMinutes(): string;
      localWaitMinutes(): string;
      localCognitiveLoad(): 'high' | 'low' | '';
    };

    expect(restored.localExpectedMinutes()).toBe('25');
    expect(restored.localWaitMinutes()).toBe('8');
    expect(restored.localCognitiveLoad()).toBe('high');
  });

  it('should not persist fractional minute inputs that floor to zero', async () => {
    context.render();
    const component = context.getFixture().componentInstance as unknown as {
      onExpectedMinutesChange: (value: string) => Promise<boolean>;
      onWaitMinutesChange: (value: string) => Promise<boolean>;
    };

    await component.onExpectedMinutesChange('0.5');
    await component.onWaitMinutesChange('0.5');

    expect(context.updateTaskExpectedMinutes).toHaveBeenCalledWith('task-1', null);
    expect(context.updateTaskWaitMinutes).toHaveBeenCalledWith('task-1', null);
  });

  it('should expose planner durable save failure without clearing local input', async () => {
    context.render({ expected_minutes: 15 });
    context.updateTaskExpectedMinutes.mockResolvedValueOnce(false);
    const fixture = context.getFixture();
    const component = fixture.componentInstance as unknown as {
      onExpectedMinutesChange: (value: string) => Promise<boolean>;
      plannerSaveState: () => 'idle' | 'saving' | 'failed';
      localExpectedMinutes: () => string;
      isPreview: { set: (value: boolean) => void };
    };
    component.isPreview.set(false);
    fixture.detectChanges();

    const saved = await component.onExpectedMinutesChange('25');
    fixture.detectChanges();

    expect(saved).toBe(false);
    expect(context.updateTaskExpectedMinutes).toHaveBeenCalledWith('task-1', 25);
    expect(component.localExpectedMinutes()).toBe('25');
    expect(component.plannerSaveState()).toBe('failed');
    expect(fixture.nativeElement.textContent).toContain('规划字段本地保存失败');
  });

  it('should clear planner durable failure state when a new task is hydrated', async () => {
    const { setTask } = context.render({ id: 'task-1', expected_minutes: 15 });
    context.updateTaskExpectedMinutes.mockResolvedValueOnce(false);
    const fixture = context.getFixture();
    const component = fixture.componentInstance as unknown as {
      onExpectedMinutesChange: (value: string) => Promise<boolean>;
      plannerSaveState: () => 'idle' | 'saving' | 'failed';
    };

    await component.onExpectedMinutesChange('25');
    expect(component.plannerSaveState()).toBe('failed');

    setTask(createTask({ id: 'task-2', expected_minutes: 30 }));
    fixture.detectChanges();

    expect(component.plannerSaveState()).toBe('idle');
  });
}
