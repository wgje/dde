import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { vi } from 'vitest';

import { isRecording, isTranscribing, remainingQuota } from '../state/focus-stores';
import { EventBusService } from './event-bus.service';
import { AuthService } from './auth.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { SpeechToTextService } from './speech-to-text.service';
import { SupabaseClientService } from './supabase-client.service';
import { ToastService } from './toast.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';

export const expectDeferredCallback = <TArgs extends unknown[], TResult = void>(
  callback: ((...args: TArgs) => TResult) | null | undefined,
  label: string,
): ((...args: TArgs) => TResult) => {
  if (!callback) {
    throw new Error(`${label} should be assigned before invocation`);
  }

  return callback;
};

export type SpeechToTextServiceSpecContext = ReturnType<
  typeof createSpeechToTextServiceSpecContext
>;

export function createSpeechToTextServiceSpecContext() {
  vi.useRealTimers();
  const originalMediaDevices = navigator.mediaDevices;

  isRecording.set(false);
  isTranscribing.set(false);
  remainingQuota.set(50);

  const categoryLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };

  const mockLoggerService = {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    category: vi.fn().mockReturnValue(categoryLogger),
  };

  const mockToastService = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  };

  const mockAuthApi = {
    getSession: vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'test-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'local-user' },
        },
      },
      error: null,
    }),
  };

  const client = {
    auth: mockAuthApi,
  };

  const mockSupabaseClient = {
    client: vi.fn().mockReturnValue(client),
    clientAsync: vi.fn().mockResolvedValue(client),
  };

  const mockAuthService = {
    currentUserId: signal<string | null>('local-user'),
    isConfigured: false,
    ensureRuntimeAuthReady: vi.fn().mockResolvedValue(undefined),
  };

  const mockBlackBoxService = {
    create: vi.fn().mockReturnValue({ ok: true, value: { id: 'bb-1' } }),
    createDurably: vi.fn().mockResolvedValue({ ok: true, value: { id: 'bb-1' } }),
  };

  const mockSessionManager = {
    tryRefreshSessionWithReason: vi.fn().mockResolvedValue({ refreshed: true }),
    tryRefreshSessionWithSession: vi.fn().mockResolvedValue({
      refreshed: true,
      session: {
        access_token: 'fresh-session-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'local-user' },
      },
    }),
  };

  const mockEventBus = {
    onSessionRestored$: new Subject<{
      type: 'session-restored';
      userId: string;
      source: string;
    }>(),
    onSessionInvalidated$: new Subject<{
      type: 'session-invalidated';
      userId: string | null;
      source: string;
    }>(),
  };

  const mockNetworkAwareness = {
    isOnline: signal(true),
    networkQuality: signal('high'),
  };

  TestBed.configureTestingModule({
    providers: [
      SpeechToTextService,
      { provide: LoggerService, useValue: mockLoggerService },
      { provide: ToastService, useValue: mockToastService },
      { provide: SupabaseClientService, useValue: mockSupabaseClient },
      { provide: AuthService, useValue: mockAuthService },
      { provide: BlackBoxService, useValue: mockBlackBoxService },
      { provide: SessionManagerService, useValue: mockSessionManager },
      { provide: EventBusService, useValue: mockEventBus },
      { provide: NetworkAwarenessService, useValue: mockNetworkAwareness },
    ],
  });

  const service = TestBed.inject(SpeechToTextService);

  return {
    attachRecordedAudio: () => attachRecordedAudio(service),
    attachRecordedAudioWithTracks: (chunks: Blob[]) =>
      attachRecordedAudioWithTracks(service, chunks),
    mockAuthApi,
    mockAuthService,
    mockBlackBoxService,
    mockEventBus,
    mockLoggerService,
    mockNetworkAwareness,
    mockSessionManager,
    mockSupabaseClient,
    mockToastService,
    originalMediaDevices,
    service,
  };
}

export function cleanupSpeechToTextServiceSpecContext(
  context: SpeechToTextServiceSpecContext,
): void {
  const usedFakeTimers = typeof vi.isFakeTimers === 'function' && vi.isFakeTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (usedFakeTimers) vi.useRealTimers();
  context.mockEventBus.onSessionRestored$.complete();
  context.mockEventBus.onSessionInvalidated$.complete();
  setMediaDevices(context.originalMediaDevices);
}

function attachRecordedAudio(service: SpeechToTextService) {
  const recorder = {
    state: 'recording',
    mimeType: 'audio/webm',
    onstop: null as null | (() => void | Promise<void>),
    stop: vi.fn(function(this: { onstop: null | (() => void | Promise<void>) }) {
      void this.onstop?.();
    }),
    stream: {
      getTracks: () => [] as MediaStreamTrack[],
    },
  };

  (service as unknown as {
    mediaRecorder: typeof recorder;
    audioChunks: Blob[];
  }).mediaRecorder = recorder;
  (service as unknown as {
    mediaRecorder: typeof recorder;
    audioChunks: Blob[];
  }).audioChunks = [new Blob([new Uint8Array(1600)], { type: 'audio/webm' })];

  return recorder;
}

function attachRecordedAudioWithTracks(
  service: SpeechToTextService,
  chunks: Blob[],
) {
  const stopTrack = vi.fn();
  const recorder = {
    state: 'recording',
    mimeType: 'audio/webm',
    onstop: null as null | (() => void | Promise<void>),
    stop: vi.fn(function(this: { onstop: null | (() => void | Promise<void>) }) {
      void this.onstop?.();
    }),
    stream: {
      getTracks: () => [{ stop: stopTrack }] as unknown as MediaStreamTrack[],
    },
  };

  (service as unknown as {
    mediaRecorder: typeof recorder;
    audioChunks: Blob[];
    recordingOwnerUserId: string | null;
  }).mediaRecorder = recorder;
  (service as unknown as {
    mediaRecorder: typeof recorder;
    audioChunks: Blob[];
    recordingOwnerUserId: string | null;
  }).audioChunks = chunks;
  (service as unknown as {
    mediaRecorder: typeof recorder;
    audioChunks: Blob[];
    recordingOwnerUserId: string | null;
  }).recordingOwnerUserId = 'local-user';

  return { recorder, stopTrack };
}

export function setMediaDevices(value: MediaDevices | undefined) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value,
    configurable: true,
    writable: true,
  });
}
