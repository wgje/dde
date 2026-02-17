/**
 * GateActionsComponent 单元测试
 *
 * 覆盖场景：
 * - isProcessing / canSnooze 方法始终可调用（Bug Fix #96645099）
 * - 按钮禁用状态随动画状态变化
 * - snooze 按钮条件渲染
 * - 操作方法正确委托给 GateService
 */
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GateService } from '../../../../../services/gate.service';
import { ToastService } from '../../../../../services/toast.service';
import { BlackBoxService } from '../../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { LoggerService } from '../../../../../services/logger.service';
import { GateActionsComponent } from './gate-actions.component';

type MutableGateServiceForTest = {
  cardAnimation?: unknown;
  canSnooze?: unknown;
};

describe('GateActionsComponent', () => {
  let fixture: ComponentFixture<GateActionsComponent>;
  let component: GateActionsComponent;
  const testBedFlags = globalThis as Record<string, unknown>;
  const testBedResetSkipKey = '__vitest_skip_testbed_reset__';

  const cardAnimation = signal<'idle' | 'entering' | 'sinking' | 'emerging'>('idle');

  const mockGateService = {
    cardAnimation,
    canSnooze: vi.fn(() => true),
    markAsRead: vi.fn(),
    markAsCompleted: vi.fn(),
    snooze: vi.fn(),
    isActive: signal(true),
    showCompletionMessage: signal(false),
  };

  const mockToastService = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  };

  const mockBlackBoxService = {
    create: vi.fn().mockReturnValue({ ok: true, value: {} }),
  };

  const mockSpeechService = {
    isRecording: signal(false),
    isTranscribing: signal(false),
    isSupported: vi.fn(() => false),
    startRecording: vi.fn().mockResolvedValue(undefined),
    stopAndTranscribe: vi.fn().mockResolvedValue(''),
    cancelRecording: vi.fn(),
  };

  const mockLoggerService = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeAll(async () => {
    testBedFlags[testBedResetSkipKey] = true;
    await TestBed.configureTestingModule({
      imports: [GateActionsComponent],
      providers: [
        { provide: GateService, useValue: mockGateService },
        { provide: ToastService, useValue: mockToastService },
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: SpeechToTextService, useValue: mockSpeechService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compileComponents();
  });

  beforeEach(() => {
    cardAnimation.set('idle');
    vi.clearAllMocks();

    fixture = TestBed.createComponent(GateActionsComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture?.destroy();
  });

  afterAll(() => {
    testBedFlags[testBedResetSkipKey] = false;
    try {
      TestBed.resetTestingModule();
    } catch {
      // noop
    }
  });

  // ===== Bug Fix #96645099: isProcessing / canSnooze 始终可调用 =====

  it('should render without errors', () => {
    expect(() => fixture.detectChanges()).not.toThrow();
  });

  it('isProcessing() should return false when animation is idle', () => {
    cardAnimation.set('idle');
    expect(component.isProcessing()).toBe(false);
  });

  it('isProcessing() should return true when animation is not idle', () => {
    cardAnimation.set('sinking');
    expect(component.isProcessing()).toBe(true);

    cardAnimation.set('entering');
    expect(component.isProcessing()).toBe(true);

    cardAnimation.set('emerging');
    expect(component.isProcessing()).toBe(true);
  });

  it('isProcessing() should return false if gateService is broken (defensive)', () => {
    // 模拟极端场景：gateService.cardAnimation 不存在
    const mutableGateService = component.gateService as unknown as MutableGateServiceForTest;
    const original = component.gateService.cardAnimation;
    mutableGateService.cardAnimation = undefined;

    expect(component.isProcessing()).toBe(false);

    // 恢复
    mutableGateService.cardAnimation = original;
  });

  it('canSnooze() should delegate to gateService.canSnooze()', () => {
    mockGateService.canSnooze.mockReturnValue(true);
    expect(component.canSnooze()).toBe(true);

    mockGateService.canSnooze.mockReturnValue(false);
    expect(component.canSnooze()).toBe(false);
  });

  it('canSnooze() should return false if gateService.canSnooze is broken', () => {
    const mutableGateService = component.gateService as unknown as MutableGateServiceForTest;
    const original = mockGateService.canSnooze;
    mutableGateService.canSnooze = undefined;

    expect(component.canSnooze()).toBe(false);

    // 恢复
    mutableGateService.canSnooze = original;
  });

  // ===== 按钮禁用状态 =====

  it('should disable action buttons when processing', () => {
    cardAnimation.set('sinking');
    fixture.detectChanges();

    const readBtn = fixture.nativeElement.querySelector('[data-testid="gate-read-button"]') as HTMLButtonElement;
    const completeBtn = fixture.nativeElement.querySelector('[data-testid="gate-complete-button"]') as HTMLButtonElement;

    expect(readBtn.disabled).toBe(true);
    expect(completeBtn.disabled).toBe(true);
  });

  it('should enable action buttons when idle', () => {
    cardAnimation.set('idle');
    fixture.detectChanges();

    const readBtn = fixture.nativeElement.querySelector('[data-testid="gate-read-button"]') as HTMLButtonElement;
    const completeBtn = fixture.nativeElement.querySelector('[data-testid="gate-complete-button"]') as HTMLButtonElement;

    expect(readBtn.disabled).toBe(false);
    expect(completeBtn.disabled).toBe(false);
  });

  // ===== Snooze 按钮条件渲染 =====

  it('should show snooze button when canSnooze is true', () => {
    mockGateService.canSnooze.mockReturnValue(true);
    fixture.detectChanges();

    const snoozeBtn = fixture.nativeElement.querySelector('[data-testid="gate-snooze-button"]');
    expect(snoozeBtn).toBeTruthy();
  });

  it('should hide snooze button when canSnooze is false', () => {
    mockGateService.canSnooze.mockReturnValue(false);
    fixture.detectChanges();

    const snoozeBtn = fixture.nativeElement.querySelector('[data-testid="gate-snooze-button"]');
    expect(snoozeBtn).toBeFalsy();
  });

  // ===== 操作委托 =====

  it('markAsRead should delegate to gateService', () => {
    component.markAsRead();
    expect(mockGateService.markAsRead).toHaveBeenCalledOnce();
  });

  it('markAsCompleted should delegate to gateService', () => {
    component.markAsCompleted();
    expect(mockGateService.markAsCompleted).toHaveBeenCalledOnce();
  });

  it('snooze should delegate to gateService when canSnooze is true', () => {
    mockGateService.canSnooze.mockReturnValue(true);
    component.snooze();
    expect(mockGateService.snooze).toHaveBeenCalledOnce();
  });

  it('snooze should not delegate when canSnooze is false', () => {
    mockGateService.canSnooze.mockReturnValue(false);
    component.snooze();
    expect(mockGateService.snooze).not.toHaveBeenCalled();
  });
});
