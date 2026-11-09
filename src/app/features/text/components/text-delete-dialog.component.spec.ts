import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import { TextDeleteDialogComponent } from './text-delete-dialog.component';
import type { Task } from '../../../../models';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '需要删除的任务',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-08T00:00:00.000Z',
    displayId: '1',
    ...overrides,
  } as Task;
}

function textContent(fixture: ComponentFixture<TextDeleteDialogComponent>): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

describe('TextDeleteDialogComponent', () => {
  let fixture: ComponentFixture<TextDeleteDialogComponent>;
  let component: TextDeleteDialogComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TextDeleteDialogComponent],
    });

    fixture = TestBed.createComponent(TextDeleteDialogComponent);
    component = fixture.componentInstance;
    component.task = createTask();
  });

  it('没有子任务时不应提示会同时删除子任务', () => {
    component.hasChildren = false;
    fixture.detectChanges();

    expect(textContent(fixture)).not.toContain('这将同时删除其所有子任务');
  });

  it('有子任务时应提供保留子任务选项', () => {
    component.hasChildren = true;
    fixture.detectChanges();

    expect(textContent(fixture)).toContain('保留子任务');
    expect(textContent(fixture)).toContain('子任务将提升到当前任务的父级');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="keep-children-checkbox"]')).not.toBeNull();
  });

  it('确认删除时应携带当前保留子任务选择', () => {
    const confirmSpy = vi.spyOn(component.confirm, 'emit');
    component.keepChildren = true;
    fixture.detectChanges();

    ((fixture.nativeElement as HTMLElement).querySelector('[data-testid="confirm-delete-btn"]') as HTMLButtonElement).click();

    expect(confirmSpy).toHaveBeenCalledWith(true);
  });
});
