import { describe, expect, it } from 'vitest';
import {
  resolveProjectShellTakeoverFilter,
  resolveProjectShellTakeoverOpacity,
  resolveProjectShellTakeoverTransition,
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
    ).toBe(0.96);
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
    ).toBe('none');
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
    ).toBe('translateY(0) scale(1)');
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

  it('clears blur transition immediately in idle phase so scrim-off does not linger visually', () => {
    expect(resolveProjectShellTakeoverTransition('idle')).toContain('filter 0ms');
    expect(resolveProjectShellTakeoverTransition('entering')).toContain(
      'filter calc(var(--pk-shell-enter) + 40ms)',
    );
  });
});
