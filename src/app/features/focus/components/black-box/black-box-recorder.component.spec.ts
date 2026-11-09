import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../../services/logger.service';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { BlackBoxRecorderComponent } from './black-box-recorder.component';

describe('BlackBoxRecorderComponent', () => {
  let component: BlackBoxRecorderComponent;
  let fixture: ComponentFixture<BlackBoxRecorderComponent>;
  let isRecording: ReturnType<typeof signal<boolean>>;
  let isTranscribing: ReturnType<typeof signal<boolean>>;
  let recordingDurationSec: ReturnType<typeof signal<number>>;
  let startRecording: ReturnType<typeof vi.fn<(ownerToken?: symbol) => Promise<boolean>>>;
  let stopAndTranscribe: ReturnType<typeof vi.fn<(ownerToken?: symbol) => Promise<string>>>;
  let cancelRecording: ReturnType<typeof vi.fn<(ownerToken?: symbol) => boolean>>;

  beforeEach(async () => {
    isRecording = signal(false);
    isTranscribing = signal(false);
    recordingDurationSec = signal(0);
    startRecording = vi.fn<(ownerToken?: symbol) => Promise<boolean>>().mockResolvedValue(true);
    stopAndTranscribe = vi.fn<(ownerToken?: symbol) => Promise<string>>().mockResolvedValue('');
    cancelRecording = vi.fn<(ownerToken?: symbol) => boolean>().mockReturnValue(true);

    const voiceService = {
      isRecording,
      isTranscribing,
      recordingDurationSec,
      startRecording,
      stopAndTranscribe,
      cancelRecording,
    } satisfies Partial<SpeechToTextService>;

    await TestBed.configureTestingModule({
      imports: [BlackBoxRecorderComponent],
      providers: [
        { provide: SpeechToTextService, useValue: voiceService },
        {
          provide: LoggerService,
          useValue: {
            debug: vi.fn(),
            error: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BlackBoxRecorderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
  });

  it('deduplicates repeated stop requests while transcription is still in flight', async () => {
    let resolveTranscription!: (text: string) => void;
    stopAndTranscribe.mockReturnValueOnce(new Promise<string>(resolve => {
      resolveTranscription = resolve;
    }));
    startRecording.mockImplementationOnce(async () => {
      isRecording.set(true);
      return true;
    });
    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    await Promise.resolve();

    component.onKeyStop();
    component.onKeyStop();

    expect(stopAndTranscribe).toHaveBeenCalledTimes(1);

    resolveTranscription('captured thought');
    await Promise.resolve();

    expect(component.transcription()).toBe('captured thought');
    expect(component.editableText).toBe('captured thought');
  });

  it('deduplicates pending starts and permits retry after rejection', async () => {
    let rejectStart!: (error: Error) => void;
    startRecording.mockReturnValueOnce(new Promise<boolean>((_, reject) => {
      rejectStart = reject;
    }));

    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));

    expect(startRecording).toHaveBeenCalledOnce();

    rejectStart(new Error('permission denied'));
    await Promise.resolve();
    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    await Promise.resolve();

    expect(startRecording).toHaveBeenCalledTimes(2);
  });

  it('keeps an old transcription result and finally from affecting a new recording session', async () => {
    let resolveOldTranscription!: (text: string) => void;
    let resolveNewTranscription!: (text: string) => void;
    stopAndTranscribe
      .mockImplementationOnce(() => {
        isRecording.set(false);
        return new Promise<string>(resolve => {
          resolveOldTranscription = resolve;
        });
      })
      .mockImplementationOnce(() => {
        isRecording.set(false);
        return new Promise<string>(resolve => {
          resolveNewTranscription = resolve;
        });
      });
    startRecording.mockImplementation(async () => {
      isRecording.set(true);
      return true;
    });

    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    await Promise.resolve();
    component.onKeyStop();

    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    await Promise.resolve();
    component.onKeyStop();

    expect(stopAndTranscribe).toHaveBeenCalledTimes(2);

    resolveOldTranscription('stale thought');
    await Promise.resolve();

    const internals = component as unknown as { stopTranscribeInFlight: boolean };
    expect(component.transcription()).toBe('');
    expect(component.editableText).toBe('');
    expect(internals.stopTranscribeInFlight).toBe(true);

    resolveNewTranscription('current thought');
    await Promise.resolve();

    expect(component.transcription()).toBe('current thought');
    expect(component.editableText).toBe('current thought');
    expect(internals.stopTranscribeInFlight).toBe(false);
  });

  it('ignores a pending transcription result after destroy', async () => {
    let resolveTranscription!: (text: string) => void;
    stopAndTranscribe.mockReturnValueOnce(new Promise<string>(resolve => {
      resolveTranscription = resolve;
    }));
    startRecording.mockImplementationOnce(async () => {
      isRecording.set(true);
      return true;
    });
    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    await Promise.resolve();

    component.onKeyStop();
    fixture.destroy();
    resolveTranscription('stale thought');
    await Promise.resolve();

    expect(component.transcription()).toBe('');
    expect(component.editableText).toBe('');
  });

  it('continues destroy cleanup when one global listener cleanup throws', async () => {
    const internals = component as unknown as { globalCleanups: (() => void)[] };
    const secondCleanup = vi.fn<() => void>();
    internals.globalCleanups = [
      () => {
        throw new Error('cleanup failed');
      },
      secondCleanup,
    ];
    startRecording.mockImplementationOnce(async () => {
      isRecording.set(true);
      return true;
    });
    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    await Promise.resolve();

    try {
      expect(() => component.ngOnDestroy()).not.toThrow();
      expect(secondCleanup).toHaveBeenCalledOnce();
      expect(internals.globalCleanups).toEqual([]);
      expect(cancelRecording).toHaveBeenCalledOnce();
    } finally {
      internals.globalCleanups = [];
      isRecording.set(false);
    }
  });

  it('does not stop or cancel a recording owned by another surface', async () => {
    startRecording.mockResolvedValueOnce(false);

    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    isRecording.set(true);
    await Promise.resolve();
    component.onKeyStop();

    expect(stopAndTranscribe).not.toHaveBeenCalled();
    expect(cancelRecording).not.toHaveBeenCalled();

    component.ngOnDestroy();
    expect(cancelRecording).not.toHaveBeenCalled();
    isRecording.set(false);
  });

  it('keeps the record zone focusable with truthful button semantics', async () => {
    const zone = fixture.nativeElement.querySelector(
      '[data-testid="black-box-recorder"]',
    ) as HTMLElement;

    expect(zone.getAttribute('role')).toBe('button');
    expect(zone.tabIndex).toBe(0);
    expect(zone.getAttribute('aria-disabled')).toBe('false');

    isTranscribing.set(true);
    fixture.detectChanges();

    expect(zone.getAttribute('aria-disabled')).toBe('true');
    expect(zone.tabIndex).toBe(0);

    isTranscribing.set(false);
    component.transcription.set('captured thought');
    fixture.detectChanges();
    expect(zone.getAttribute('aria-disabled')).toBe('true');

    component.transcription.set('');
    startRecording.mockReturnValueOnce(new Promise<boolean>(() => undefined));
    component.onKeyStart(new KeyboardEvent('keydown', { key: ' ' }));
    fixture.detectChanges();
    expect(zone.getAttribute('aria-disabled')).toBe('true');
  });

  it.each([' ', 'Enter'])('supports %s key down and up parity', async key => {
    startRecording.mockImplementation(async () => {
      isRecording.set(true);
      return true;
    });
    stopAndTranscribe.mockImplementation(async () => {
      isRecording.set(false);
      return '';
    });
    const zone = fixture.nativeElement.querySelector(
      '[data-testid="black-box-recorder"]',
    ) as HTMLElement;

    zone.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await Promise.resolve();
    zone.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    await Promise.resolve();

    expect(startRecording).toHaveBeenCalledOnce();
    expect(stopAndTranscribe).toHaveBeenCalledOnce();
  });

  it('focuses the record zone through the structural API', () => {
    const focusable = fixture.componentInstance as BlackBoxRecorderComponent & {
      focusPrimaryAction(): boolean;
    };

    expect(focusable.focusPrimaryAction()).toBe(true);
    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector('[data-testid="black-box-recorder"]'),
    );
  });
});
