import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockPlannerQuickEditComponent } from './dock-planner-quick-edit.component';

describe('DockPlannerQuickEditComponent', () => {
  let fixture: ComponentFixture<DockPlannerQuickEditComponent>;
  let component: DockPlannerQuickEditComponent;

  beforeEach(async () => {
    vi.useFakeTimers();

    await TestBed.configureTestingModule({
      imports: [DockPlannerQuickEditComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DockPlannerQuickEditComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should render the trigger with a missing-field badge', () => {
    component.expectedMinutesInput = null;
    component.waitMinutesInput = null;
    fixture.detectChanges();

    const trigger = fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-toggle"]')).nativeElement as HTMLButtonElement;

    expect(trigger.textContent).toContain('补全属性');
    expect(trigger.textContent).toContain('待补1');
  });

  it('should emit toggle when clicked', () => {
    const toggleSpy = vi.fn();
    component.toggleRequested.subscribe(toggleSpy);
    fixture.detectChanges();

    component.onToggle();

    expect(toggleSpy).toHaveBeenCalledTimes(1);
  });

  it('should not emit toggle when disabled', () => {
    const toggleSpy = vi.fn();
    component.toggleRequested.subscribe(toggleSpy);
    component.disabledInput = true;
    fixture.detectChanges();

    const button = fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-toggle"]')).nativeElement as HTMLButtonElement;
    button.click();

    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it('should stop the attention pulse while the panel is opening or open', () => {
    component.attentionInput = true;
    fixture.detectChanges();

    const trigger = fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-toggle"]')).nativeElement as HTMLButtonElement;
    expect(trigger.className).toContain('planner-attention-glow');

    trigger.click();
    fixture.detectChanges();

    expect(trigger.className).not.toContain('planner-attention-glow');

    component.openInput = true;
    fixture.detectChanges();

    expect(trigger.className).not.toContain('planner-attention-glow');
  });

  it('should expose the task id on the trigger for root-level panel lookup', () => {
    component.taskIdInput = 'task-123';
    fixture.detectChanges();

    const trigger = fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-toggle"]')).nativeElement as HTMLButtonElement;
    expect(trigger.getAttribute('data-planner-task-id')).toBe('task-123');
  });

  it('should keep the trigger at least 44px tall', () => {
    fixture.detectChanges();

    const trigger = fixture.debugElement.query(By.css('[data-testid="dock-v3-planner-toggle"]')).nativeElement as HTMLButtonElement;

    expect(trigger.getAttribute('style')).toContain('min-height: 44px');
  });
});
