import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DockZenModeComponent } from './dock-zen-mode.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { signal } from '@angular/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PARKING_CONFIG } from '../../../../config/parking.config';

describe('DockZenModeComponent', () => {
  let component: DockZenModeComponent;
  let fixture: ComponentFixture<DockZenModeComponent>;

  const mockEngine = {
    isBurnoutActive: signal(false),
    burnoutTriggeredAt: signal(null),
    fragmentDefenseLevel: signal(1 as const),
    lastRecommendationGroups: signal([]),
    highLoadCounter: signal({ count: 0, windowStartAt: 0 }),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DockZenModeComponent],
      providers: [
        { provide: DockEngineService, useValue: mockEngine },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DockZenModeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should have correct config values', () => {
    expect(component.pulseSize).toBe(PARKING_CONFIG.ZEN_MODE_PULSE_SIZE_PX);
    expect(component.blurPx).toBe(PARKING_CONFIG.ZEN_MODE_BLUR_PX);
    expect(component.hintText).toBe(PARKING_CONFIG.ZEN_MODE_HINT_TEXT);
    expect(component.breatheDuration).toBe(`${PARKING_CONFIG.ZEN_MODE_BREATHE_DURATION_S}s`);
  });

  it('should compute isBurnout from engine', () => {
    expect(component.isBurnout()).toBe(false);
    mockEngine.isBurnoutActive.set(true);
    expect(component.isBurnout()).toBe(true);
    mockEngine.isBurnoutActive.set(false); // 清理
  });

  it('should have isActive default to false', () => {
    expect(component.isActive$()).toBe(false);
  });

  // TODO(L-36): Add test for overlayStyle computed — verify CSS custom properties change with burnout and tier
  // TODO(L-36): Add test for exit output — verify click/escape emits exit event
  // TODO(L-36): Add test for ngOnInit/ngOnDestroy — verify performance tier measuring lifecycle
  // TODO(L-36): Add test for template rendering when isActive is true — verify zen-overlay DOM presence
});
