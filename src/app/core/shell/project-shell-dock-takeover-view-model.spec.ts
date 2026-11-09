import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';

import { PARKING_CONFIG } from '../../../config/parking.config';
import type { DockFocusChromePhase } from '../../../utils/dock-focus-phase';
import { createProjectShellDockTakeoverViewModel } from './project-shell-dock-takeover-view-model';
import { resolveProjectShellTakeoverPresentation } from './project-shell-focus-motion';

describe('project-shell dock takeover view model', () => {
  it('projects dock takeover state into template-facing presentation signals', () => {
    const phase = signal<DockFocusChromePhase>('idle');
    const focusMode = signal(false);
    const scrimOn = signal(false);
    const viewModel = createProjectShellDockTakeoverViewModel({
      contentEffect: 'dim',
      focusMode,
      phase,
      scrimOn,
    });

    expect(viewModel.phase()).toBe('idle');
    expect(viewModel.mainNonInteractive()).toBe(false);
    expect(viewModel.mainOpacity()).toBe(1);

    focusMode.set(true);
    scrimOn.set(true);
    phase.set('focused');

    expect(viewModel.phase()).toBe('focused');
    expect(viewModel.mainDimmed()).toBe(true);
    expect(viewModel.mainNonInteractive()).toBe(true);
    expect(viewModel.mainOpacity()).toBe(0.5);
    expect(viewModel.mainFilter()).toBe('blur(3.5px)');
    expect(viewModel.mainTransform()).toBe('translateY(-3px) scale(0.997)');
  });

  it('uses the parking config content effect by default', () => {
    const phase = signal<DockFocusChromePhase>('focused');
    const focusMode = signal(true);
    const scrimOn = signal(true);
    const viewModel = createProjectShellDockTakeoverViewModel({
      focusMode,
      phase,
      scrimOn,
    });

    const expected = resolveProjectShellTakeoverPresentation({
      contentEffect: PARKING_CONFIG.DOCK_FOCUS_CONTENT_EFFECT,
      focusMode: true,
      phase: 'focused',
      scrimOn: true,
    });

    expect(viewModel.mainHidden()).toBe(expected.hidden);
    expect(viewModel.mainDimmed()).toBe(expected.dimmed);
    expect(viewModel.mainTransition()).toBe(expected.transition);
  });
});
