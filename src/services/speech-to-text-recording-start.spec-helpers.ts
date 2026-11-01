import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { isRecording } from '../state/focus-stores';
import {
  setMediaDevices,
  type SpeechToTextServiceSpecContext,
} from './speech-to-text.service.spec-helpers';

export function registerSpeechToTextRecordingStartSpecs(
  getContext: () => SpeechToTextServiceSpecContext,
): void {
  describe('isRecording', () => {
    it('初始状态应该不在录音', () => {
      expect(getContext().service.isRecording()).toBe(false);
    });
  });

  describe('isTranscribing', () => {
    it('初始状态应该不在转录', () => {
      expect(getContext().service.isTranscribing()).toBe(false);
    });
  });

  describe('getRecordingDuration', () => {
    it('未录音时应该返回 0', () => {
      expect(getContext().service.getRecordingDuration()).toBe(0);
    });
  });

  describe('isSupported', () => {
    it('应该检测浏览器是否支持录音', () => {
      expect(typeof getContext().service.isSupported()).toBe('boolean');
    });
  });

  describe('getFallbackMessage', () => {
    it('应该返回提示消息', () => {
      expect(typeof getContext().service.getFallbackMessage()).toBe('string');
    });
  });

  describe('checkMicrophoneAvailability', () => {
    it('当没有音频输入设备时应该返回 false', async () => {
      const { service } = getContext();
      setMediaDevices({
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'videoinput', deviceId: 'test1' },
        ]),
        getUserMedia: vi.fn(),
      } as unknown as MediaDevices);

      await expect(service.checkMicrophoneAvailability()).resolves.toBe(false);
    });

    it('当有音频输入设备时应该返回 true', async () => {
      const { service } = getContext();
      setMediaDevices({
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'test1' },
          { kind: 'videoinput', deviceId: 'test2' },
        ]),
        getUserMedia: vi.fn(),
      } as unknown as MediaDevices);

      await expect(service.checkMicrophoneAvailability()).resolves.toBe(true);
    });

    it('当 mediaDevices API 不可用时应该返回 false', async () => {
      const { service } = getContext();
      setMediaDevices(undefined);

      await expect(service.checkMicrophoneAvailability()).resolves.toBe(false);
    });
  });

  describe('startRecording', () => {
    it('设备不可用时应该优雅返回而不抛出错误', async () => {
      const { service } = getContext();
      vi.spyOn(service, 'checkMicrophoneAvailability').mockResolvedValue(false);

      await expect(service.startRecording()).resolves.toBe(false);
    });

    it('浏览器不支持时应该优雅返回', async () => {
      const { service } = getContext();
      setMediaDevices(undefined);

      await expect(service.startRecording()).resolves.toBe(false);
    });

    it('并发触发开始录音时只创建一个 MediaRecorder', async () => {
      const { service } = getContext();
      const getUserMedia = vi.fn().mockResolvedValue({
        getTracks: () => [] as MediaStreamTrack[],
      });
      const start = vi.fn();
      const mediaRecorderInstances: unknown[] = [];
      class MockMediaRecorder {
        static isTypeSupported = vi.fn(() => true);
        state = 'recording';
        mimeType = 'audio/webm';
        ondataavailable: null = null;
        onstop: null = null;

        constructor(readonly stream: MediaStream) {
          mediaRecorderInstances.push(this);
        }

        start = start;
        stop = vi.fn();
      }
      vi.stubGlobal('MediaRecorder', MockMediaRecorder);
      setMediaDevices({
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'audioinput', deviceId: 'test1' },
        ]),
        getUserMedia,
      } as unknown as MediaDevices);

      const results = await Promise.all([
        service.startRecording(),
        service.startRecording(),
      ]);

      expect(results).toEqual([true, false]);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(mediaRecorderInstances).toHaveLength(1);
      expect(start).toHaveBeenCalledTimes(1);
      service.cancelRecording();
    });

    it('取消 pending start 后晚到的媒体流不应再启动录音', async () => {
      const { service } = getContext();
      vi.spyOn(service, 'checkMicrophoneAvailability').mockResolvedValue(true);
      let resolveStream!: (stream: MediaStream) => void;
      const stopTrack = vi.fn();
      const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => {
        resolveStream = resolve;
      }));
      const recorderStart = vi.fn();
      const recorderConstructed = vi.fn();
      class MockMediaRecorder {
        static isTypeSupported = vi.fn(() => true);
        state = 'recording';
        mimeType = 'audio/webm';
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: (() => void | Promise<void>) | null = null;

        constructor(readonly stream: MediaStream) {
          recorderConstructed();
        }

        start = recorderStart;
        stop = vi.fn();
      }
      vi.stubGlobal('MediaRecorder', MockMediaRecorder);
      setMediaDevices({
        enumerateDevices: vi.fn(),
        getUserMedia,
      } as unknown as MediaDevices);

      const starting = service.startRecording();
      await Promise.resolve();
      service.cancelRecording();
      resolveStream({
        getTracks: () => [{ stop: stopTrack }] as unknown as MediaStreamTrack[],
      } as MediaStream);

      await starting;

      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(recorderConstructed).not.toHaveBeenCalled();
      expect(recorderStart).not.toHaveBeenCalled();
      expect(service.isRecording()).toBe(false);
      expect((service as unknown as { mediaRecorder: MediaRecorder | null }).mediaRecorder).toBeNull();
    });

    it('取消旧会话后其晚到数据不应污染新录音会话', async () => {
      const { service } = getContext();
      vi.spyOn(service, 'checkMicrophoneAvailability').mockResolvedValue(true);
      const streams = [
        { getTracks: () => [] as MediaStreamTrack[] },
        { getTracks: () => [] as MediaStreamTrack[] },
      ] as MediaStream[];
      const recorders: MockMediaRecorder[] = [];

      class MockMediaRecorder {
        static isTypeSupported = vi.fn(() => true);
        state = 'recording';
        mimeType = 'audio/webm';
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: (() => void | Promise<void>) | null = null;

        constructor(readonly stream: MediaStream) {
          recorders.push(this);
        }

        start = vi.fn();
        stop = vi.fn();
      }

      vi.stubGlobal('MediaRecorder', MockMediaRecorder);
      setMediaDevices({
        enumerateDevices: vi.fn(),
        getUserMedia: vi.fn()
          .mockResolvedValueOnce(streams[0])
          .mockResolvedValueOnce(streams[1]),
      } as unknown as MediaDevices);

      await service.startRecording();
      const lateOldDataHandler = recorders[0].ondataavailable;

      service.cancelRecording();
      await service.startRecording();
      lateOldDataHandler?.({
        data: new Blob(['old-session-audio'], { type: 'audio/webm' }),
      } as BlobEvent);

      expect((service as unknown as { audioChunks: Blob[] }).audioChunks).toEqual([]);
      service.cancelRecording();
    });

    it('MediaRecorder.start 失败时应释放媒体流并回滚会话状态', async () => {
      const { mockToastService, service } = getContext();
      vi.spyOn(service, 'checkMicrophoneAvailability').mockResolvedValue(true);
      const stopTrack = vi.fn();
      const stream = {
        getTracks: () => [{ stop: stopTrack }] as unknown as MediaStreamTrack[],
      } as MediaStream;

      class MockMediaRecorder {
        static isTypeSupported = vi.fn(() => true);
        state = 'inactive';
        mimeType = 'audio/webm';
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: (() => void | Promise<void>) | null = null;

        constructor(readonly stream: MediaStream) {}

        start = vi.fn(() => {
          throw new Error('recorder start failed');
        });
        stop = vi.fn();
      }

      vi.stubGlobal('MediaRecorder', MockMediaRecorder);
      setMediaDevices({
        enumerateDevices: vi.fn(),
        getUserMedia: vi.fn().mockResolvedValue(stream),
      } as unknown as MediaDevices);

      await expect(service.startRecording()).resolves.toBe(false);

      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(service.isRecording()).toBe(false);
      expect((service as unknown as { mediaRecorder: MediaRecorder | null }).mediaRecorder).toBeNull();
      expect((service as unknown as { audioChunks: Blob[] }).audioChunks).toEqual([]);
      expect((service as unknown as { recordingOwnerUserId: string | null }).recordingOwnerUserId).toBeNull();
      expect(mockToastService.error).toHaveBeenCalledTimes(1);
    });

    it('带 owner token 的录音会话不应被其他入口取消或停止', async () => {
      const { service } = getContext();
      vi.spyOn(service, 'checkMicrophoneAvailability').mockResolvedValue(true);
      const stopTrack = vi.fn();
      const recorderStop = vi.fn();
      const stream = {
        getTracks: () => [{ stop: stopTrack }] as unknown as MediaStreamTrack[],
      } as MediaStream;
      class MockMediaRecorder {
        static isTypeSupported = vi.fn(() => true);
        state = 'recording';
        mimeType = 'audio/webm';
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: (() => void | Promise<void>) | null = null;
        constructor(readonly stream: MediaStream) {}
        start = vi.fn();
        stop = recorderStop;
      }
      vi.stubGlobal('MediaRecorder', MockMediaRecorder);
      setMediaDevices({
        enumerateDevices: vi.fn(),
        getUserMedia: vi.fn().mockResolvedValue(stream),
      } as unknown as MediaDevices);
      const scopedService = service as unknown as {
        startRecording: (ownerToken?: symbol) => Promise<boolean>;
        cancelRecording: (ownerToken?: symbol) => boolean;
        stopAndTranscribe: (ownerToken?: symbol) => Promise<string>;
      };
      const ownerA = Symbol('owner-a');
      const ownerB = Symbol('owner-b');

      await expect(scopedService.startRecording(ownerA)).resolves.toBe(true);
      await expect(scopedService.startRecording(ownerB)).resolves.toBe(false);
      expect(scopedService.cancelRecording(ownerB)).toBe(false);
      expect(service.isRecording()).toBe(true);
      expect(stopTrack).not.toHaveBeenCalled();
      await expect(scopedService.stopAndTranscribe(ownerB)).rejects.toThrow('录音会话不属于当前调用方');
      expect(recorderStop).not.toHaveBeenCalled();

      expect(scopedService.cancelRecording(ownerA)).toBe(true);
      expect(stopTrack).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopRecording', () => {
    it('未录音时调用不应该抛出错误', () => {
      expect(() => getContext().service.stopRecording()).not.toThrow();
    });
  });

  describe('destroy cleanup', () => {
    it('销毁录音中服务时应释放录音资源并停止时长 ticker', () => {
      const { attachRecordedAudioWithTracks, service } = getContext();
      vi.useFakeTimers();
      const { recorder, stopTrack } = attachRecordedAudioWithTracks([
        new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
      ]);
      isRecording.set(true);
      (service as unknown as { recordingStartTime: number }).recordingStartTime = Date.now();
      const durationTicker = (service as unknown as {
        durationTicker: { start: () => void };
      }).durationTicker;
      durationTicker.start();

      TestBed.resetTestingModule();
      vi.advanceTimersByTime(500);

      expect(recorder.stop).toHaveBeenCalledTimes(1);
      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(service.isRecording()).toBe(false);
      expect((service as unknown as { mediaRecorder: unknown | null }).mediaRecorder).toBeNull();
      expect(service.recordingDurationSec()).toBe(0);
    });
  });
}
