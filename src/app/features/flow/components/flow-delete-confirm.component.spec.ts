import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import { FlowDeleteConfirmComponent } from './flow-delete-confirm.component';
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

function textContent(fixture: ComponentFixture<FlowDeleteConfirmComponent>): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

describe('FlowDeleteConfirmComponent', () => {
  let fixture: ComponentFixture<FlowDeleteConfirmComponent>;
  let component: FlowDeleteConfirmComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FlowDeleteConfirmComponent],
    });

    fixture = TestBed.createComponent(FlowDeleteConfirmComponent);
    component = fixture.componentInstance;
    (component as any).task = signal(createTask());
  });

  it('没有子任务时不应提示会同时删除子任务', () => {
    (component as any).hasChildren = signal(false);
    fixture.detectChanges();

    expect(textContent(fixture)).not.toContain('这将同时删除其所有子任务');
  });

  it('桌面端有子任务时应提供保留子任务选项', () => {
    (component as any).hasChildren = signal(true);
    (component as any).isMobile = signal(false);
    fixture.detectChanges();

    expect(textContent(fixture)).toContain('保留子任务');
    expect(textContent(fixture)).toContain('子任务将提升到当前任务的父级');
    expect((fixture.nativeElement as HTMLElement).querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('移动端有子任务时应把保留/删除子任务作为两个确认动作', () => {
    const confirmSpy = vi.spyOn(fixture.componentInstance.confirm, 'emit');
    (component as any).hasChildren = signal(true);
    (component as any).isMobile = signal(true);
    fixture.detectChanges();

    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    buttons.find(button => button.textContent?.includes('同时删除子任务'))?.click();
    buttons.find(button => button.textContent?.includes('保留子任务'))?.click();

    expect(confirmSpy).toHaveBeenCalledWith(false);
    expect(confirmSpy).toHaveBeenCalledWith(true);
  });
});
