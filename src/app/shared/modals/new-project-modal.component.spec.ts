import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { NewProjectModalComponent } from './new-project-modal.component';

describe('NewProjectModalComponent', () => {
  let fixture: ComponentFixture<NewProjectModalComponent>;
  let component: NewProjectModalComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewProjectModalComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(NewProjectModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should enable create button after the name field receives input', () => {
    const button = fixture.debugElement.query(By.css('[data-testid="create-project-confirm"]')).nativeElement as HTMLButtonElement;
    const input = fixture.debugElement.query(By.css('[data-testid="project-name-input"]')).nativeElement as HTMLInputElement;

    expect(button.disabled).toBe(true);

    input.value = 'Dock UX Audit';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(button.disabled).toBe(false);
  });

  it('should emit the trimmed form state when the form is submitted', () => {
    const confirmSpy = vi.fn();
    component.confirm.subscribe(confirmSpy);

    const form = fixture.debugElement.query(By.css('form')).nativeElement as HTMLFormElement;
    const input = fixture.debugElement.query(By.css('[data-testid="project-name-input"]')).nativeElement as HTMLInputElement;
    const textarea = fixture.debugElement.query(By.css('textarea')).nativeElement as HTMLTextAreaElement;

    input.value = '  Dock UX Audit  ';
    input.dispatchEvent(new Event('input'));
    textarea.value = '  improve planner entry  ';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    form.dispatchEvent(new Event('submit'));

    expect(confirmSpy).toHaveBeenCalledWith({
      name: 'Dock UX Audit',
      description: 'improve planner entry',
    });
  });
});
