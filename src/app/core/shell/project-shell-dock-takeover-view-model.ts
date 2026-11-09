import { computed, type Signal } from '@angular/core';

import { PARKING_CONFIG } from '../../../config/parking.config';
import type { DockFocusChromePhase } from '../../../utils/dock-focus-phase';
import {
  resolveProjectShellTakeoverPresentation,
} from './project-shell-focus-motion';

export interface ProjectShellDockTakeoverViewModelOptions {
  phase: Signal<DockFocusChromePhase>;
  focusMode: Signal<boolean>;
  scrimOn: Signal<boolean>;
  contentEffect?: string;
}

export interface ProjectShellDockTakeoverViewModel {
  phase: Signal<DockFocusChromePhase>;
  mainHidden: Signal<boolean>;
  mainDimmed: Signal<boolean>;
  mainNonInteractive: Signal<boolean>;
  mainOpacity: Signal<number>;
  mainFilter: Signal<string>;
  mainTransform: Signal<string>;
  mainTransition: Signal<string>;
}

export function createProjectShellDockTakeoverViewModel(
  options: ProjectShellDockTakeoverViewModelOptions,
): ProjectShellDockTakeoverViewModel {
  const presentation = computed(() => resolveProjectShellTakeoverPresentation({
    contentEffect: options.contentEffect ?? PARKING_CONFIG.DOCK_FOCUS_CONTENT_EFFECT,
    focusMode: options.focusMode(),
    phase: options.phase(),
    scrimOn: options.scrimOn(),
  }));

  return {
    phase: options.phase,
    mainHidden: computed(() => presentation().hidden),
    mainDimmed: computed(() => presentation().dimmed),
    mainNonInteractive: computed(() => presentation().nonInteractive),
    mainOpacity: computed(() => presentation().opacity),
    mainFilter: computed(() => presentation().filter),
    mainTransform: computed(() => presentation().transform),
    mainTransition: computed(() => presentation().transition),
  };
}
