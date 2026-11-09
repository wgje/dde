import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DockZenModeComponent } from './dock-zen-mode.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import {
  PerformanceTierService,
  type FocusPerformanceTier,
} from '../../../../services/performance-tier.service';
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

  const mockPerformanceTier = {
    tier: signal<FocusPerformanceTier>('T0'),
    startMeasuring: vi.fn(),
    stopMeasuring: vi.fn(),
  };

  function showOverlay(): HTMLElement {
    fixture.componentRef.setInput('isActive', true);
    fixture.detectChanges();
    const overlay = fixture.nativeElement.querySelector('[data-testid="dock-v3-zen-mode"]');
    expect(overlay).not.toBeNull();
    return overlay as HTMLElement;
  }

  beforeEach(async () => {
    mockEngine.isBurnoutActive.set(false);
    mockPerformanceTier.tier.set('T0');
    mockPerformanceTier.startMeasuring.mockClear();
    mockPerformanceTier.stopMeasuring.mockClear();

    await TestBed.configureTestingModule({
      imports: [DockZenModeComponent],
      providers: [
        { provide: DockEngineService, useValue: mockEngine },
        { provide: PerformanceTierService, useValue: mockPerformanceTier },
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

  it('should switch overlay palette custom properties when burnout activates', () => {
    const calmStyle = component.overlayStyle();
    expect(calmStyle['--zen-primary-rgb']).toBe(PARKING_CONFIG.ZEN_MODE_PRIMARY_RGB);
    expect(calmStyle['--zen-secondary-rgb']).toBe(PARKING_CONFIG.ZEN_MODE_SECONDARY_RGB);
    expect(calmStyle['--zen-text-rgb']).toBe('148 163 184');

    mockEngine.isBurnoutActive.set(true);

    // 燃尽状态切换到暖色安抚色板
    const burnoutStyle = component.overlayStyle();
    expect(burnoutStyle['--zen-primary-rgb']).toBe(PARKING_CONFIG.ZEN_MODE_BURNOUT_PRIMARY_RGB);
    expect(burnoutStyle['--zen-secondary-rgb']).toBe(PARKING_CONFIG.ZEN_MODE_BURNOUT_SECONDARY_RGB);
    expect(burnoutStyle['--zen-text-rgb']).toBe('253 230 138');
  });

  it('should dim aurora effects and darken the backdrop as the performance tier degrades', () => {
    const t0Style = component.overlayStyle();
    expect(t0Style['--zen-aurora-opacity']).toBe('0.82');
    expect(t0Style['--zen-mist-opacity']).toBe('0.42');

    mockPerformanceTier.tier.set('T1');
    expect(component.overlayStyle()['--zen-aurora-opacity']).toBe('0.58');

    mockPerformanceTier.tier.set('T2');

    // T2 档关闭大部分光效并提高遮罩不透明度，换取低端设备流畅度
    const t2Style = component.overlayStyle();
    expect(t2Style['--zen-aurora-opacity']).toBe('0.34');
    expect(t2Style['--zen-mist-opacity']).toBe('0.48');
    expect(t2Style['background']).toContain('rgba(8, 12, 22, 0.90)');
  });

  it('should emit exit when the overlay is clicked', () => {
    const exitSpy = vi.fn();
    component.exit.subscribe(exitSpy);
    const overlay = showOverlay();

    overlay.click();

    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('should emit exit when Escape is pressed on the overlay', () => {
    const exitSpy = vi.fn();
    component.exit.subscribe(exitSpy);
    const overlay = showOverlay();

    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('should start performance measuring on init and stop it on destroy', () => {
    // beforeEach 的 detectChanges 已触发 ngOnInit
    expect(mockPerformanceTier.startMeasuring).toHaveBeenCalledTimes(1);
    expect(mockPerformanceTier.stopMeasuring).not.toHaveBeenCalled();

    fixture.destroy();

    expect(mockPerformanceTier.stopMeasuring).toHaveBeenCalledTimes(1);
  });

  it('should render the zen overlay only while isActive is true', () => {
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-zen-mode"]')).toBeNull();

    const overlay = showOverlay();

    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('data-performance-tier')).toBe('T0');
    expect(overlay.textContent).toContain(PARKING_CONFIG.ZEN_MODE_HINT_TEXT);
    expect(overlay.textContent).toContain('点击任意位置退出');

    fixture.componentRef.setInput('isActive', false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-zen-mode"]')).toBeNull();
  });
});
