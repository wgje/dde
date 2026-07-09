import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpeechToTextDurationTickerController } from './speech-to-text-duration-ticker.controller';

describe('SpeechToTextDurationTickerController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets duration and updates elapsed seconds on an interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));
    const setDuration = vi.fn();
    const controller = new SpeechToTextDurationTickerController({
      getRecordingStartTime: () => new Date('2026-06-18T00:00:00.000Z').getTime(),
      setDuration,
    });

    controller.start();
    vi.advanceTimersByTime(1_500);

    expect(setDuration).toHaveBeenNthCalledWith(1, 0);
    expect(setDuration).toHaveBeenLastCalledWith(2);
  });

  it('stops the active ticker and resets duration', () => {
    vi.useFakeTimers();
    const setDuration = vi.fn();
    const controller = new SpeechToTextDurationTickerController({
      getRecordingStartTime: () => Date.now(),
      setDuration,
    });

    controller.start();
    controller.stop();
    vi.advanceTimersByTime(500);

    expect(setDuration).toHaveBeenCalledTimes(2);
    expect(setDuration).toHaveBeenLastCalledWith(0);
  });

  it('replaces an existing ticker when restarted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));
    let startTime = Date.now();
    const setDuration = vi.fn();
    const controller = new SpeechToTextDurationTickerController({
      getRecordingStartTime: () => startTime,
      setDuration,
    });

    controller.start();
    vi.advanceTimersByTime(500);
    vi.setSystemTime(new Date('2026-06-18T00:00:10.000Z'));
    startTime = Date.now();
    controller.start();
    vi.advanceTimersByTime(500);

    expect(setDuration).toHaveBeenLastCalledWith(1);
  });
});
