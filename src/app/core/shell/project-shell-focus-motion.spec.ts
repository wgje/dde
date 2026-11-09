import { describe, expect, it } from 'vitest';
import {
  resolveProjectShellTakeoverPresentation,
  resolveProjectShellTakeoverFilter,
  resolveProjectShellTakeoverOpacity,
  resolveProjectShellTakeoverTransition,
  resolveProjectShellTakeoverTransform,
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

  it('clears blur transition immediately in idle phase so scrim-off does not linger visually', () => {
    expect(resolveProjectShellTakeoverTransition('idle')).toContain('filter 0ms');
    expect(resolveProjectShellTakeoverTransition('entering')).toContain(
      'filter calc(var(--pk-shell-enter) + 40ms)',
    );
    expect(resolveProjectShellTakeoverTransition('entering')).not.toContain('visibility');
  });

  it('resolves a single shell presentation object for hide mode focus', () => {
    expect(resolveProjectShellTakeoverPresentation({
      phase: 'focused',
      contentEffect: 'hide',
      focusMode: true,
      scrimOn: true,
    })).toEqual({
      hidden: true,
      dimmed: false,
      nonInteractive: true,
      opacity: 0,
      filter: 'blur(8px)',
      transform: 'translateY(-10px) scale(0.988)',
      transition: resolveProjectShellTakeoverTransition('focused'),
    });
  });

  it('keeps current hide-mode exiting behavior visible while exiting takeover', () => {
    expect(resolveProjectShellTakeoverPresentation({
      phase: 'exiting',
      contentEffect: 'hide',
      focusMode: true,
      scrimOn: true,
    })).toMatchObject({
      hidden: false,
      dimmed: false,
      nonInteractive: true,
      opacity: 0.96,
      filter: 'none',
      transform: 'translateY(0) scale(1)',
    });
  });

  it('marks dimmed presentation only when dim effect, focus mode, and scrim are active', () => {
    expect(resolveProjectShellTakeoverPresentation({
      phase: 'focused',
      contentEffect: 'dim',
      focusMode: true,
      scrimOn: true,
    })).toMatchObject({
      hidden: false,
      dimmed: true,
      nonInteractive: true,
      opacity: 0.5,
      filter: 'blur(3.5px)',
      transform: 'translateY(-3px) scale(0.997)',
    });

    expect(resolveProjectShellTakeoverPresentation({
      phase: 'idle',
      contentEffect: 'dim',
      focusMode: false,
      scrimOn: false,
    })).toMatchObject({
      hidden: false,
      dimmed: false,
      nonInteractive: false,
      opacity: 1,
      filter: 'none',
      transform: 'translateY(0) scale(1)',
    });
  });
});
