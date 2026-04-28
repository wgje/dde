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

  it('should render manual quick capture panel when speech is unsupported', () => {
    fixture.detectChanges();

    component.toggleQuickCapture();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('[data-testid="gate-quick-capture-panel"]');
    const input = fixture.nativeElement.querySelector('[data-testid="gate-quick-input-editor"]');
    expect(panel).toBeTruthy();
    expect(input).toBeTruthy();
  });

  it('confirmPendingTranscription should keep draft open when save fails', () => {
    mockBlackBoxService.create.mockReturnValueOnce({
      ok: false,
      error: { message: '保存失败' },
    });
    component.pendingTranscription.set('原始转写');
    component.editableTranscription = '原始转写';
    component.quickCaptureOpen.set(true);

    component.confirmPendingTranscription();

    expect(component.pendingTranscription()).toBe('原始转写');
    expect(component.editableTranscription).toBe('原始转写');
    expect(component.quickCaptureOpen()).toBe(true);
    expect(mockToastService.error).toHaveBeenCalledWith('保存失败');
  });

  it('should render quick capture panel when pending transcription exists', () => {
    component.pendingTranscription.set('待确认内容');
    component.editableTranscription = '待确认内容';
    component.quickCaptureOpen.set(true);
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
