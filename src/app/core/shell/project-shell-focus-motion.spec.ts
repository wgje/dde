import { describe, expect, it } from 'vitest';
import {
  resolveProjectShellTakeoverFilter,
  resolveProjectShellTakeoverOpacity,
  resolveProjectShellTakeoverTransform,
  resolveProjectShellTakeoverVisibility,
} from './project-shell-focus-motion';

describe('project-shell focus motion', () => {
  it('uses restrained exit opacity and fully recovers on restoring', () => {
    expect(
      resolveProjectShellTakeoverOpacity({
        phase: 'exiting',
        hiddenMode: false,
        scrimOn: true,
      }),
    ).toBe(0.9);
    expect(
      resolveProjectShellTakeoverOpacity({
        phase: 'restoring',
        hiddenMode: false,
        scrimOn: true,
      }),
    ).toBe(1);
  });

  it('clears filter and transform jitter during restoring', () => {
    expect(
      resolveProjectShellTakeoverFilter({
        phase: 'exiting',
        hiddenMode: false,
        scrimOn: true,
      }),
    ).toBe('blur(1px)');
    expect(
      resolveProjectShellTakeoverFilter({
        phase: 'restoring',
        hiddenMode: false,
        scrimOn: true,
      }),
    ).toBe('none');

    expect(
      resolveProjectShellTakeoverTransform({
        phase: 'exiting',
        hiddenMode: false,
        scrimOn: true,
      }),
    ).toBe('translateY(-1px) scale(0.999)');
    expect(
      resolveProjectShellTakeoverTransform({
        phase: 'restoring',
        hiddenMode: false,
        scrimOn: true,
      }),
    ).toBe('translateY(0) scale(1)');
  });

  it('keeps hidden-mode content visible while exiting or restoring so recovery can animate', () => {
    expect(
      resolveProjectShellTakeoverVisibility({
        phase: 'exiting',
        hiddenMode: true,
      }),
    ).toBe('visible');
    expect(
      resolveProjectShellTakeoverVisibility({
        phase: 'restoring',
        hiddenMode: true,
      }),
    ).toBe('visible');
    expect(
      resolveProjectShellTakeoverVisibility({
        phase: 'focused',
        hiddenMode: true,
      }),
    ).toBe('hidden');
  });
});
