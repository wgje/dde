import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppComponent } from './app.component';
import { BootStageService } from './services/boot-stage.service';

describe('AppComponent', () => {
  let bootStageMock: {
    markLaunchShellVisible: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    bootStageMock = {
      markLaunchShellVisible: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        { provide: BootStageService, useValue: bootStageMock },
      ],
    });
  });

  it('should render router-outlet without launch shell', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="launch-shell"]')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
  });

  it('should have no launch shell DOM elements', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-launch-shell')).toBeFalsy();
  });
});
