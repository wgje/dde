import type { DockFocusChromePhase } from '../../../utils/dock-focus-phase';

export interface ProjectShellTakeoverVisualState {
  phase: DockFocusChromePhase;
  hiddenMode: boolean;
  scrimOn?: boolean;
}

export function resolveProjectShellTakeoverVisibility(
  state: ProjectShellTakeoverVisualState,
): 'visible' | 'hidden' {
  if (!state.hiddenMode) return 'visible';
  if (state.phase === 'exiting' || state.phase === 'restoring') return 'visible';
  return 'hidden';
}

export function resolveProjectShellTakeoverOpacity(
  state: ProjectShellTakeoverVisualState,
): number {
  if (state.hiddenMode) {
    if (state.phase === 'exiting') return 0.24;
    if (state.phase === 'restoring') return 1;
    return 0;
  }

  if (state.phase === 'focused') return 0.56;
  if (state.phase === 'entering') return 0.82;
  if (state.phase === 'exiting') return 0.9;
  return 1;
}

export function resolveProjectShellTakeoverFilter(
  state: ProjectShellTakeoverVisualState,
): string {
  if (state.hiddenMode) {
    if (state.phase === 'exiting') return 'blur(4px)';
    if (state.phase === 'restoring') return 'none';
    return 'blur(8px)';
  }

  if (state.phase === 'focused') return 'blur(4px)';
  if (state.phase === 'entering') return 'blur(1.5px)';
  if (state.phase === 'exiting') return 'blur(1px)';
  return 'none';
}

export function resolveProjectShellTakeoverTransform(
  state: ProjectShellTakeoverVisualState,
): string {
  if (state.hiddenMode) {
    if (state.phase === 'exiting') return 'translateY(-4px) scale(0.994)';
    if (state.phase === 'restoring') return 'translateY(0) scale(1)';
    return 'translateY(-12px) scale(0.985)';
  }

  if (state.phase === 'focused') return 'translateY(-4px) scale(0.996)';
  if (state.phase === 'entering') return 'translateY(-2px) scale(0.998)';
  if (state.phase === 'exiting') return 'translateY(-1px) scale(0.999)';
  return 'translateY(0) scale(1)';
}
