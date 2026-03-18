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
  // hide 模式：exiting 和 restoring 需要可见以便看到退出动画
  if (state.phase === 'exiting' || state.phase === 'restoring') return 'visible';
  return 'hidden';
}

export function resolveProjectShellTakeoverOpacity(
  state: ProjectShellTakeoverVisualState,
): number {
  if (state.hiddenMode) {
    // hide 模式：进入时即隐藏，退出时渐现
    if (state.phase === 'exiting') return 0.55;
    if (state.phase === 'restoring') return 1;
    return 0;
  }

  // dim 模式：各阶段平滑连续，避免大幅突变
  // restoring：恢复到完全不透明（由 CSS transition 承载动画）
  if (state.phase === 'restoring') return 1;
  // focused：scrim 开启时主内容轻度虚化
  if (state.phase === 'focused') return 0.5;
  // entering：入场时轻度虚化，比 focused 略亮（让用户感知到内容正在淡出而非突然消失）
  if (state.phase === 'entering') return 0.75;
  // exiting：退出时几乎回到正常态，只保留轻微透明度过渡
  if (state.phase === 'exiting') return 0.96;
  // idle：正常状态
  return 1;
}

export function resolveProjectShellTakeoverFilter(
  state: ProjectShellTakeoverVisualState,
): string {
  if (state.hiddenMode) {
    if (state.phase === 'exiting') return 'none';
    if (state.phase === 'restoring') return 'none';
    return 'blur(8px)';
  }

  // dim 模式：filter 与 opacity 同步，由 CSS transition 承载渐变
  // restoring：清除虚化，回到正常
  if (state.phase === 'restoring') return 'none';
  // focused：主内容轻度虚化，强调停泊坞层
  if (state.phase === 'focused') return 'blur(3.5px)';
  // entering：开始入场，轻微虚化
  if (state.phase === 'entering') return 'blur(1px)';
  // exiting：退出时直接回到无虚化，由 CSS transition 承载恢复
  if (state.phase === 'exiting') return 'none';
  return 'none';
}

export function resolveProjectShellTakeoverTransform(
  state: ProjectShellTakeoverVisualState,
): string {
  if (state.hiddenMode) {
    if (state.phase === 'exiting') return 'translateY(0) scale(1)';
    if (state.phase === 'restoring') return 'translateY(0) scale(1)';
    return 'translateY(-10px) scale(0.988)';
  }

  // dim 模式：整体用更小的 transform 幅度，减少"缩进"的视觉焦虑感
  if (state.phase === 'restoring') return 'translateY(0) scale(1)';
  // focused：轻微下沉感，暗示被压在专注层之下
  if (state.phase === 'focused') return 'translateY(-3px) scale(0.997)';
  // entering：比 focused 更接近正常态
  if (state.phase === 'entering') return 'translateY(-1px) scale(0.999)';
  // exiting：直接回到正常态，避免“缩回卡片”的感知
  if (state.phase === 'exiting') return 'translateY(0) scale(1)';
  return 'translateY(0) scale(1)';
}

export function resolveProjectShellTakeoverTransition(
  phase: DockFocusChromePhase,
): string {
  if (phase === 'idle') {
    return 'opacity 0ms linear, transform 0ms linear, filter 0ms linear, visibility 0ms linear 0ms';
  }

  return 'opacity var(--pk-shell-enter) var(--pk-ease-standard), '
    + 'transform var(--pk-shell-enter) var(--pk-ease-enter), '
    + 'filter calc(var(--pk-shell-enter) + 40ms) var(--pk-ease-standard), '
    + 'visibility 0ms linear 0ms';
}
