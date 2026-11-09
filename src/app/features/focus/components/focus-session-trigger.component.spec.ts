import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FocusSessionTriggerComponent } from './focus-session-trigger.component';

describe('FocusSessionTriggerComponent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createFixture() {
    const fixture = TestBed.createComponent(FocusSessionTriggerComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('focuses its native primary button through the structural API', () => {
    const fixture = createFixture();
    const component = fixture.componentInstance as FocusSessionTriggerComponent & {
      focusPrimaryAction(): boolean;
    };

    expect(component.focusPrimaryAction()).toBe(true);
    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector('[data-testid="focus-session-trigger"]'),
    );
  });

  it('retains the existing dock focus toggle event', () => {
    const fixture = createFixture();
    const listener = vi.fn();
    window.addEventListener('dock-focus-session-toggle', listener);

    fixture.nativeElement.querySelector('[data-testid="focus-session-trigger"]').click();

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('dock-focus-session-toggle', listener);
  });
});
