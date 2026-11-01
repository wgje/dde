import {
  hasAudioInputDevice,
  resolveFirstSupportedAudioMimeType,
} from './speech-to-text.helpers';

interface MicrophoneAvailabilityOptions {
  debug: (message: string, detail?: unknown) => void;
  mediaDevices: MediaDevices | undefined;
}

export interface RecordingSessionContext {
  recorder: MediaRecorder;
  audioChunks: Blob[];
  ownerUserId: string | null;
  generation: number;
}

export interface RecordingStopOperation {
  recorder: MediaRecorder;
  promise: Promise<string>;
  resolve: (value: string | PromiseLike<string>) => void;
  handlingStarted: boolean;
}

export function isSpeechRecordingSupported(
  mediaDevices: MediaDevices | undefined,
  mediaRecorderAvailable: boolean,
): boolean {
  return !!mediaDevices?.getUserMedia && mediaRecorderAvailable;
}

export function resolveSpeechRecordingFallbackMessage(
  supported: boolean,
  unsupportedMessage: string,
): string {
  return supported ? '' : unsupportedMessage;
}

export function resolveSupportedSpeechAudioMimeType(
  mimeTypes: readonly string[],
  isTypeSupported: (mimeType: string) => boolean,
): string {
  return resolveFirstSupportedAudioMimeType(mimeTypes, isTypeSupported);
}

export async function checkSpeechMicrophoneAvailability(
  options: MicrophoneAvailabilityOptions,
): Promise<boolean> {
  const { debug, mediaDevices } = options;
  if (!mediaDevices?.getUserMedia || !mediaDevices.enumerateDevices) {
    debug('MediaDevices API not supported');
    return false;
  }

  try {
    const devices = await mediaDevices.enumerateDevices();
    if (!hasAudioInputDevice(devices)) {
      debug('No audio input devices found');
      return false;
    }

    return true;
  } catch (error) {
    debug(
      'Failed to check microphone availability',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export function releaseSpeechMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach(track => track.stop());
}

export function releaseSpeechRecorderStream(recorder: MediaRecorder): void {
  releaseSpeechMediaStream(recorder.stream);
}
