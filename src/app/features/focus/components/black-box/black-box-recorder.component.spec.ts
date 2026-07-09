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
  let stopAndTranscribe: ReturnType<typeof vi.fn<() => Promise<string>>>;
  let cancelRecording: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    isRecording = signal(false);
    isTranscribing = signal(false);
    recordingDurationSec = signal(0);
    stopAndTranscribe = vi.fn<() => Promise<string>>().mockResolvedValue('');
    cancelRecording = vi.fn<() => void>();

    const voiceService = {
      isRecording,
      isTranscribing,
      recordingDurationSec,
      startRecording: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
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
    isRecording.set(true);

    component.onKeyStop();
    component.onKeyStop();

    expect(stopAndTranscribe).toHaveBeenCalledTimes(1);

    resolveTranscription('captured thought');
    await Promise.resolve();

    expect(component.transcription()).toBe('captured thought');
    expect(component.editableText).toBe('captured thought');
  });

  it('ignores a pending transcription result after destroy', async () => {
    let resolveTranscription!: (text: string) => void;
    stopAndTranscribe.mockReturnValueOnce(new Promise<string>(resolve => {
      resolveTranscription = resolve;
    }));
    isRecording.set(true);

    component.onKeyStop();
    fixture.destroy();
    resolveTranscription('stale thought');
    await Promise.resolve();

    expect(component.transcription()).toBe('');
    expect(component.editableText).toBe('');
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
    isRecording.set(true);

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
});
