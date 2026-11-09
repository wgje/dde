import { describe, expect, it, vi } from 'vitest';

import {
  checkSpeechMicrophoneAvailability,
  isSpeechRecordingSupported,
  releaseSpeechMediaStream,
  releaseSpeechRecorderStream,
  resolveSpeechRecordingFallbackMessage,
  resolveSupportedSpeechAudioMimeType,
} from './speech-to-text-recording-support';

describe('speech-to-text recording support', () => {
  it('requires getUserMedia and MediaRecorder support', () => {
    expect(isSpeechRecordingSupported(undefined, true)).toBe(false);
    expect(isSpeechRecordingSupported({} as MediaDevices, true)).toBe(false);
    expect(isSpeechRecordingSupported({
      getUserMedia: vi.fn(),
    } as unknown as MediaDevices, false)).toBe(false);
    expect(isSpeechRecordingSupported({
      getUserMedia: vi.fn(),
    } as unknown as MediaDevices, true)).toBe(true);
  });

  it('returns the unsupported fallback only when recording is unavailable', () => {
    expect(resolveSpeechRecordingFallbackMessage(false, 'unsupported')).toBe('unsupported');
    expect(resolveSpeechRecordingFallbackMessage(true, 'unsupported')).toBe('');
  });

  it('selects the first supported MIME type', () => {
    const isTypeSupported = vi.fn((type: string) => type === 'audio/mp4');

    expect(resolveSupportedSpeechAudioMimeType(
      ['audio/webm', 'audio/mp4'],
      isTypeSupported,
    )).toBe('audio/mp4');
    expect(isTypeSupported).toHaveBeenCalledWith('audio/webm');
    expect(isTypeSupported).toHaveBeenCalledWith('audio/mp4');
  });

  it('returns false and logs when media device APIs are unavailable', async () => {
    const debug = vi.fn();

    await expect(checkSpeechMicrophoneAvailability({
      debug,
      mediaDevices: undefined,
    })).resolves.toBe(false);

    expect(debug).toHaveBeenCalledWith('MediaDevices API not supported');
  });

  it('returns false and logs when no audio input exists', async () => {
    const debug = vi.fn();
    const mediaDevices = {
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'camera' },
      ]),
      getUserMedia: vi.fn(),
    } as unknown as MediaDevices;

    await expect(checkSpeechMicrophoneAvailability({
      debug,
      mediaDevices,
    })).resolves.toBe(false);

    expect(debug).toHaveBeenCalledWith('No audio input devices found');
  });

  it('returns true when an audio input exists', async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'audioinput', deviceId: 'microphone' },
      ]),
      getUserMedia: vi.fn(),
    } as unknown as MediaDevices;

    await expect(checkSpeechMicrophoneAvailability({
      debug: vi.fn(),
      mediaDevices,
    })).resolves.toBe(true);
  });

  it('returns false and logs enumeration failures', async () => {
    const debug = vi.fn();
    const mediaDevices = {
      enumerateDevices: vi.fn().mockRejectedValue(new Error('enumeration failed')),
      getUserMedia: vi.fn(),
    } as unknown as MediaDevices;

    await expect(checkSpeechMicrophoneAvailability({
      debug,
      mediaDevices,
    })).resolves.toBe(false);

    expect(debug).toHaveBeenCalledWith(
      'Failed to check microphone availability',
      'enumeration failed',
    );
  });

  it('releases every track owned by a stream or recorder', () => {
    const firstTrackStop = vi.fn();
    const secondTrackStop = vi.fn();
    const stream = {
      getTracks: () => [
        { stop: firstTrackStop },
        { stop: secondTrackStop },
      ],
    } as unknown as MediaStream;

    releaseSpeechMediaStream(stream);
    releaseSpeechRecorderStream({ stream } as MediaRecorder);

    expect(firstTrackStop).toHaveBeenCalledTimes(2);
    expect(secondTrackStop).toHaveBeenCalledTimes(2);
  });
});
