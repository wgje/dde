import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DockInlineTaskFormComponent } from './dock-inline-task-form.component';

describe('DockInlineTaskFormComponent', () => {
  let fixture: ComponentFixture<DockInlineTaskFormComponent>;
  let component: DockInlineTaskFormComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DockInlineTaskFormComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DockInlineTaskFormComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('emits field changes for parent-owned draft state', () => {
    const taskTitleChange = vi.fn();
    component.taskTitleChange.subscribe(taskTitleChange);
    const input = fixture.nativeElement.querySelector('input[type="text"]') as HTMLInputElement;

    input.value = 'New Dock Task';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(taskTitleChange).toHaveBeenCalledWith('New Dock Task');
  });

  it('disables create while pending or title is blank', () => {
    component.taskTitle = '   ';
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('[data-testid="dock-v3-create-submit"]') as HTMLButtonElement;

    expect(button.disabled).toBe(true);

    component.taskTitle = 'Ready';
    component.createPending = true;
    fixture.detectChanges();

    expect(button.disabled).toBe(true);
  });

  it('emits create requests from the submit button', () => {
    const createTask = vi.fn();
    component.taskTitle = 'Ready';
    component.createTask.subscribe(createTask);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('[data-testid="dock-v3-create-submit"]') as HTMLButtonElement;
    button.click();

    expect(createTask).toHaveBeenCalledOnce();
  });
});
