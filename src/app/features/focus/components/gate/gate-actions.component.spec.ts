/**
 * GateActionsComponent 单元测试
 */
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GateService } from '../../../../../services/gate.service';
import { ToastService } from '../../../../../services/toast.service';
import { BlackBoxService } from '../../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { LoggerService } from '../../../../../services/logger.service';
import { GateActionsComponent } from './gate-actions.component';

describe('GateActionsComponent', () => {
  let fixture: ComponentFixture<GateActionsComponent>;
  let component: GateActionsComponent;

  const cardAnimation = signal<'idle' | 'entering' | 'heave_read' | 'heavy_drop' | 'settling'>('idle');

  const mockGateService = {
    cardAnimation,
    markAsRead: vi.fn(),
    markAsCompleted: vi.fn(),
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

  beforeEach(async () => {
    cardAnimation.set('idle');
    vi.clearAllMocks();

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

    fixture = TestBed.createComponent(GateActionsComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
  });

  it('should render without errors', () => {
    expect(() => fixture.detectChanges()).not.toThrow();
  });

  it('isProcessing() should return true when animation is not idle', () => {
    cardAnimation.set('heavy_drop');
    expect(component.isProcessing()).toBe(true);
  });

  it('should disable action buttons when processing', () => {
    cardAnimation.set('heave_read');
    fixture.detectChanges();

    const readBtn = fixture.nativeElement.querySelector('[data-testid="gate-read-button"]') as HTMLButtonElement;
    const completeBtn = fixture.nativeElement.querySelector('[data-testid="gate-complete-button"]') as HTMLButtonElement;

    expect(readBtn.disabled).toBe(true);
    expect(completeBtn.disabled).toBe(true);
  });

  it('markAsRead should delegate to gateService', () => {
    component.markAsRead();
    expect(mockGateService.markAsRead).toHaveBeenCalledOnce();
  });

  it('markAsCompleted should delegate to gateService', () => {
    component.markAsCompleted();
    expect(mockGateService.markAsCompleted).toHaveBeenCalledOnce();
  });

  it('should toggle quick capture panel', () => {
    fixture.detectChanges();

    // FAB 通过短按（mousedown + 快速 mouseup）切换面板
    component.toggleQuickCapture();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('[data-testid="gate-quick-capture-panel"]');
    expect(panel).toBeTruthy();
  });

  it('submitQuickInput should create black box entry', async () => {
    component.quickInputText.set('补记录测试');

    await component.submitQuickInput();

    expect(mockBlackBoxService.create).toHaveBeenCalledWith({ content: '补记录测试' });
    expect(mockToastService.success).toHaveBeenCalled();
  });
});
