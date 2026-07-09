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
    createDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
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
    mockSpeechService.isRecording.set(false);
    mockSpeechService.isTranscribing.set(false);
    mockSpeechService.isSupported.mockReturnValue(false);
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

  it('confirmPendingTranscription should keep draft open when durable save fails', async () => {
    mockBlackBoxService.createDurably.mockResolvedValueOnce({
      ok: false,
      error: { message: '保存失败' },
    });
    component.pendingTranscription.set('原始转写');
    component.editableTranscription = '原始转写';
    component.quickCaptureOpen.set(true);

    await component.confirmPendingTranscription();

    expect(component.pendingTranscription()).toBe('原始转写');
    expect(component.editableTranscription).toBe('原始转写');
    expect(component.quickCaptureOpen()).toBe(true);
    expect(mockToastService.error).toHaveBeenCalledWith('保存失败');
    expect(mockBlackBoxService.create).not.toHaveBeenCalled();
  });

  it('should render quick capture panel when pending transcription exists', () => {
    component.pendingTranscription.set('待确认内容');
    component.editableTranscription = '待确认内容';
    component.quickCaptureOpen.set(true);
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('[data-testid="gate-quick-capture-panel"]');
    expect(panel).toBeTruthy();
  });

  it('submitQuickInput should durably create black box entry', async () => {
    component.quickInputText.set('补记录测试');

    await component.submitQuickInput();

    expect(mockBlackBoxService.createDurably).toHaveBeenCalledWith({ content: '补记录测试' });
    expect(mockBlackBoxService.create).not.toHaveBeenCalled();
    expect(mockToastService.success).toHaveBeenCalled();
  });

  it('touchcancel should cancel FAB recording without transcribing', async () => {
    vi.useFakeTimers();
    mockSpeechService.isSupported.mockReturnValue(true);
    mockSpeechService.startRecording.mockImplementationOnce(async () => {
      mockSpeechService.isRecording.set(true);
    });

    try {
      component.onFabTouchStart(new Event('touchstart') as TouchEvent);
      await vi.advanceTimersByTimeAsync(350);

      document.dispatchEvent(new Event('touchcancel'));
      await Promise.resolve();

      expect(mockSpeechService.cancelRecording).toHaveBeenCalledOnce();
      expect(mockSpeechService.stopAndTranscribe).not.toHaveBeenCalled();
      expect(component.quickCaptureOpen()).toBe(false);
      expect(component.pendingTranscription()).toBe('');
      expect(component.isFabRecording()).toBe(false);
      expect(component.isFabTranscribing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroy should ignore late FAB recording fallback after long press starts', async () => {
    vi.useFakeTimers();
    mockSpeechService.isSupported.mockReturnValue(true);
    let resolveStartRecording: (() => void) | null = null;
    mockSpeechService.startRecording.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveStartRecording = resolve;
      }),
    );

    try {
      component.onFabMouseDown(new MouseEvent('mousedown', { cancelable: true }));
      await vi.advanceTimersByTimeAsync(350);

      component.ngOnDestroy();
      expect(resolveStartRecording).toBeTypeOf('function');
      resolveStartRecording!();
      await Promise.resolve();

      expect(component.quickCaptureOpen()).toBe(false);
      expect(component.manualQuickCaptureFallback()).toBe(false);
      expect(component.isFabRecording()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroy should ignore late FAB transcription results after recording stops', async () => {
    vi.useFakeTimers();
    mockSpeechService.isSupported.mockReturnValue(true);
    mockSpeechService.startRecording.mockImplementationOnce(async () => {
      mockSpeechService.isRecording.set(true);
    });
    let resolveTranscription: ((text: string) => void) | null = null;
    mockSpeechService.stopAndTranscribe.mockReturnValueOnce(
      new Promise<string>(resolve => {
        resolveTranscription = resolve;
      }),
    );

    try {
      component.onFabMouseDown(new MouseEvent('mousedown', { cancelable: true }));
      await vi.advanceTimersByTimeAsync(350);
      await Promise.resolve();

      document.dispatchEvent(new MouseEvent('mouseup'));
      expect(resolveTranscription).toBeTypeOf('function');

      component.ngOnDestroy();
      resolveTranscription!('late transcription');
      await Promise.resolve();

      expect(component.pendingTranscription()).toBe('');
      expect(component.editableTranscription).toBe('');
      expect(component.quickCaptureOpen()).toBe(false);
      expect(component.isFabTranscribing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues destroy cleanup when one global listener cleanup throws', () => {
    const internals = component as unknown as { globalCleanups: (() => void)[] };
    const secondCleanup = vi.fn<() => void>();
    internals.globalCleanups = [
      () => {
        throw new Error('cleanup failed');
      },
      secondCleanup,
    ];

    try {
      expect(() => component.ngOnDestroy()).not.toThrow();
      expect(secondCleanup).toHaveBeenCalledOnce();
      expect(internals.globalCleanups).toEqual([]);
    } finally {
      internals.globalCleanups = [];
    }
  });
});
