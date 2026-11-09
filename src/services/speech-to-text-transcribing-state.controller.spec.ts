import { describe, expect, it, vi } from 'vitest';
import { SpeechToTextTranscribingStateController } from './speech-to-text-transcribing-state.controller';

describe('SpeechToTextTranscribingStateController', () => {
  it('keeps transcribing true until every active operation releases', () => {
    const setTranscribing = vi.fn();
    const controller = new SpeechToTextTranscribingStateController(setTranscribing);

    const releaseFirst = controller.begin();
    const releaseSecond = controller.begin();

    releaseFirst();
    expect(setTranscribing.mock.calls).toEqual([[true], [true]]);

    releaseSecond();
    expect(setTranscribing.mock.calls).toEqual([[true], [true], [false]]);
  });

  it('ignores duplicate releases', () => {
    const setTranscribing = vi.fn();
    const controller = new SpeechToTextTranscribingStateController(setTranscribing);

    const release = controller.begin();
    release();
    release();

    expect(setTranscribing.mock.calls).toEqual([[true], [false]]);
  });

  it('resets active operations immediately while preserving old release semantics', () => {
    const setTranscribing = vi.fn();
    const controller = new SpeechToTextTranscribingStateController(setTranscribing);

    const release = controller.begin();
    controller.reset();
    release();

    expect(setTranscribing.mock.calls).toEqual([[true], [false], [false]]);
  });

  it('releases after successful and failed async operations', async () => {
    const setTranscribing = vi.fn();
    const controller = new SpeechToTextTranscribingStateController(setTranscribing);

    await expect(controller.run(async () => 'done')).resolves.toBe('done');
    await expect(controller.run(async () => {
      throw new Error('failed');
    })).rejects.toThrow('failed');

    expect(setTranscribing.mock.calls).toEqual([[true], [false], [true], [false]]);
  });
});
