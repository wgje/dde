import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { BlackBoxTextInputComponent } from './black-box-text-input.component';

describe('BlackBoxTextInputComponent', () => {
  async function render(): Promise<{
    component: BlackBoxTextInputComponent;
    fixture: ComponentFixture<BlackBoxTextInputComponent>;
    submitted: string[];
  }> {
    await TestBed.configureTestingModule({
      imports: [BlackBoxTextInputComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(BlackBoxTextInputComponent);
    const component = fixture.componentInstance;
    const submitted: string[] = [];
    component.submitted.subscribe(value => submitted.push(value));
    fixture.detectChanges();
    return { component, fixture, submitted };
  }

  it('does not submit while IME composition is active on Enter', async () => {
    const { component, submitted } = await render();
    component.inputText = '正在输入';

    component.onEnterKey(new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
    }));

    expect(submitted).toEqual([]);
    expect(component.inputText).toBe('正在输入');
  });

  it('submits trimmed text on Ctrl+Enter after composition has settled', async () => {
    const { component, submitted } = await render();
    component.inputText = '  想法  ';

    component.onEnterKey(new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
    }));

    expect(submitted).toEqual(['想法']);
    expect(component.inputText).toBe('');
  });
});
