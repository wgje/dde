import type {
  DockFocusTransitionPhase,
  DockFocusTransitionState,
} from '../models/parking-dock';

export type DockFocusUiPhase = DockFocusTransitionPhase | 'idle';
export type DockFocusChromePhase = DockFocusUiPhase | 'restoring';

export function resolveDockFocusChromeLayoutLocked(
  phase: DockFocusChromePhase,
): boolean {
  return phase === 'entering' || phase === 'focused' || phase === 'exiting' || phase === 'restoring';
}

/**
 * 将持久 focusMode 与瞬时 transition 状态收敛为统一 UI phase。
 * transition 优先级更高，用于覆盖 enter / exit 窗口内的真实可视相位。
 */
export function resolveDockFocusUiPhase(
  focusMode: boolean,
  transition: DockFocusTransitionState | null,
): DockFocusUiPhase {
  const phase = transition?.phase;
  if (phase === 'entering' || phase === 'focused' || phase === 'exiting') {
    return phase;
  }
  return focusMode ? 'focused' : 'idle';
}

/**
 * 壳层相位在 session phase 基础上再叠加 restore 窗口：
 * - entering / exiting 期间优先跟随 transition；
 * - focused 仅在 scrim 开启时接管 workspace chrome；
 * - exit 动画结束后可进入 restoring，用于平滑恢复项目栏与主布局。
 */
export function resolveDockFocusChromePhase(
  focusMode: boolean,
  transition: DockFocusTransitionState | null,
  scrimOn: boolean,
  restoring: boolean,
): DockFocusChromePhase {
  const phase = resolveDockFocusUiPhase(focusMode, transition);
  if (phase === 'entering' || phase === 'exiting') {
    return phase;
  }
  if (phase === 'focused') {
    return scrimOn ? 'focused' : 'idle';
  }
  return restoring ? 'restoring' : 'idle';
}
