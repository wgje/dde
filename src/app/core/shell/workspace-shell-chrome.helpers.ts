import {
  computed,
  type Signal,
} from '@angular/core';
import {
  resolveDockFocusChromeLayoutLocked,
  type DockFocusChromePhase,
} from '../../../utils/dock-focus-phase';

const SAFE_AREA_TOP = 'env(safe-area-inset-top, 0px)';
const HIDDEN_MOBILE_SIDEBAR_TRANSFORM = 'translateX(calc(-100% - 12px))';
const DESKTOP_SIDEBAR_TRANSFORM = 'translateX(0) scale(1)';
const FOCUSED_DESKTOP_SIDEBAR_TRANSFORM = 'translateX(-8px) scale(0.992)';
const ENTER_TRANSITION =
  'width var(--pk-shell-enter) var(--pk-ease-standard),';
const MOBILE_SMOOTH_RESTORE_TRANSITION =
  'opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore),'
  + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';

export interface FloatingNoticeState {
  isMobile: boolean;
  mobileDemoBannerVisible: boolean;
  mobileOfflineNoticeVisible: boolean;
  installPromptVisible?: boolean;
}

export interface StartupHintVisibilityState {
  hintOnlyStartupPlaceholderVisible: boolean;
  isMobile: boolean;
}

export interface CompactStartupHintState {
  isMobile: boolean;
  mobileOfflineNoticeVisible: boolean;
  mobileFloatingNoticeBaseTopOffsetPx: number;
  installPromptVisible: boolean;
}

export interface SidebarChromeState {
  phase: DockFocusChromePhase;
  isMobile: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

export interface WorkspaceSidebarChromePresentation {
  takeoverActive: boolean;
  phase: DockFocusChromePhase;
  widthPx: number;
  opacity: string;
  transform: string;
  pointerEvents: 'none' | 'auto';
  transition: string;
  contentOpacity: string;
  contentTransform: string;
  contentTransition: string;
}

export interface WorkspaceSidebarChromeSignalSources {
  phase: Signal<DockFocusChromePhase>;
  isMobile: Signal<boolean>;
  sidebarOpen: Signal<boolean>;
  sidebarWidth: Signal<number>;
}

export interface WorkspaceSidebarChromeSignals {
  focusWorkspaceTakeoverActive: Signal<boolean>;
  focusWorkspaceTakeoverPhase: Signal<DockFocusChromePhase>;
  mobileSidebarBackdropVisible: Signal<boolean>;
  workspaceSidebarContentOpacity: Signal<string>;
  workspaceSidebarContentTransform: Signal<string>;
  workspaceSidebarContentTransition: Signal<string>;
  workspaceSidebarOpacity: Signal<string>;
  workspaceSidebarPointerEvents: Signal<'none' | 'auto'>;
  workspaceSidebarTransform: Signal<string>;
  workspaceSidebarTransition: Signal<string>;
  workspaceSidebarWidthPx: Signal<number>;
}

export function resolveFocusWorkspaceTakeoverActive(phase: DockFocusChromePhase): boolean {
  return phase !== 'idle';
}

export function resolveMobileFloatingNoticeBaseTopOffsetPx(
  state: Pick<FloatingNoticeState, 'mobileDemoBannerVisible' | 'mobileOfflineNoticeVisible'>,
): number {
  const demoOffset = state.mobileDemoBannerVisible ? 104 : 0;
  if (state.mobileOfflineNoticeVisible) {
    const offlineTopOffset = demoOffset > 0 ? demoOffset : 42;
    return offlineTopOffset + 42;
  }

  return demoOffset;
}

export function resolveInstallPromptTop(isMobile: boolean, baseTopOffsetPx: number): string {
  const topOffset = isMobile ? Math.max(12, baseTopOffsetPx) : 12;
  return `calc(${SAFE_AREA_TOP} + ${topOffset}px)`;
}

export function resolveBlockingStartupHintOverlayVisible(state: StartupHintVisibilityState): boolean {
  return state.hintOnlyStartupPlaceholderVisible && !state.isMobile;
}

export function resolveCompactStartupHintBannerVisible(state: StartupHintVisibilityState): boolean {
  return state.hintOnlyStartupPlaceholderVisible && state.isMobile;
}

export function resolveWorkspaceCompactStartupHintBannerTop(state: CompactStartupHintState): string {
  let topOffset = state.isMobile && state.mobileOfflineNoticeVisible ? 84 : 56;
  topOffset = Math.max(topOffset, state.mobileFloatingNoticeBaseTopOffsetPx);
  if (state.installPromptVisible) {
    topOffset = Math.max(topOffset, Math.max(12, state.mobileFloatingNoticeBaseTopOffsetPx) + 44);
  }
  return formatSafeAreaTop(topOffset);
}

export function resolveCompactStartupHintBannerTop(state: FloatingNoticeState): string {
  let topOffset = 56;

  if (state.isMobile) {
    if (state.mobileOfflineNoticeVisible) {
      topOffset = Math.max(topOffset, 84);
    }

    const baseTopOffsetPx = resolveMobileFloatingNoticeBaseTopOffsetPx(state);
    topOffset = Math.max(topOffset, baseTopOffsetPx);

    if (state.installPromptVisible) {
      topOffset = Math.max(topOffset, Math.max(12, baseTopOffsetPx) + 44);
    }
  }

  return formatSafeAreaTop(topOffset);
}

export function resolveWorkspaceSidebarWidth(state: SidebarChromeState): number {
  if (state.isMobile) return 240;
  if (!state.sidebarOpen) return 0;
  return state.sidebarWidth;
}

export function resolveWorkspaceSidebarChromePresentation(
  state: SidebarChromeState,
): WorkspaceSidebarChromePresentation {
  return {
    takeoverActive: resolveFocusWorkspaceTakeoverActive(state.phase),
    phase: state.phase,
    widthPx: resolveWorkspaceSidebarWidth(state),
    opacity: resolveWorkspaceSidebarOpacity(state),
    transform: resolveWorkspaceSidebarTransform(state),
    pointerEvents: resolveWorkspaceSidebarPointerEvents(state),
    transition: resolveWorkspaceSidebarTransition(state),
    contentOpacity: resolveWorkspaceSidebarContentOpacity(state),
    contentTransform: resolveWorkspaceSidebarContentTransform(state),
    contentTransition: resolveWorkspaceSidebarContentTransition(state),
  };
}

export function createWorkspaceSidebarChromeSignals(
  sources: WorkspaceSidebarChromeSignalSources,
): WorkspaceSidebarChromeSignals {
  const presentation = computed(() => resolveWorkspaceSidebarChromePresentation({
    phase: sources.phase(),
    isMobile: sources.isMobile(),
    sidebarOpen: sources.sidebarOpen(),
    sidebarWidth: sources.sidebarWidth(),
  }));
  const focusWorkspaceTakeoverActive = computed(() => presentation().takeoverActive);

  return {
    focusWorkspaceTakeoverActive,
    focusWorkspaceTakeoverPhase: computed(() => presentation().phase),
    mobileSidebarBackdropVisible: computed(
      () => sources.isMobile() && sources.sidebarOpen() && !focusWorkspaceTakeoverActive(),
    ),
    workspaceSidebarContentOpacity: computed(() => presentation().contentOpacity),
    workspaceSidebarContentTransform: computed(() => presentation().contentTransform),
    workspaceSidebarContentTransition: computed(() => presentation().contentTransition),
    workspaceSidebarOpacity: computed(() => presentation().opacity),
    workspaceSidebarPointerEvents: computed(() => presentation().pointerEvents),
    workspaceSidebarTransform: computed(() => presentation().transform),
    workspaceSidebarTransition: computed(() => presentation().transition),
    workspaceSidebarWidthPx: computed(() => presentation().widthPx),
  };
}

export function resolveWorkspaceSidebarOpacity(state: Pick<SidebarChromeState, 'phase' | 'isMobile'>): string {
  if (state.phase === 'entering' || state.phase === 'focused') return '0';
  if (state.phase === 'exiting') return state.isMobile ? '0' : '1';
  return '1';
}

export function resolveWorkspaceSidebarTransform(state: SidebarChromeState): string {
  if (resolveDockFocusChromeLayoutLocked(state.phase)) {
    if (state.phase === 'restoring' || state.phase === 'exiting') {
      return state.isMobile ? HIDDEN_MOBILE_SIDEBAR_TRANSFORM : DESKTOP_SIDEBAR_TRANSFORM;
    }
    return state.isMobile ? HIDDEN_MOBILE_SIDEBAR_TRANSFORM : FOCUSED_DESKTOP_SIDEBAR_TRANSFORM;
  }

  if (state.isMobile) {
    return state.sidebarOpen ? 'translateX(0)' : HIDDEN_MOBILE_SIDEBAR_TRANSFORM;
  }

  return DESKTOP_SIDEBAR_TRANSFORM;
}

export function resolveWorkspaceSidebarPointerEvents(
  state: Pick<SidebarChromeState, 'phase' | 'isMobile' | 'sidebarOpen'>,
): 'none' | 'auto' {
  if (state.phase !== 'idle') return 'none';
  if (state.isMobile && !state.sidebarOpen) return 'none';
  return 'auto';
}

export function resolveWorkspaceSidebarTransition(
  state: Pick<SidebarChromeState, 'phase' | 'isMobile'>,
): string {
  if (state.isMobile) {
    return 'opacity var(--pk-shell-smooth-restore) var(--pk-ease-standard),'
      + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
  }

  if (state.phase === 'restoring') {
    return 'width var(--pk-shell-smooth-restore) var(--pk-ease-restore-snappy),'
      + ' opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore),'
      + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
  }

  if (state.phase === 'exiting') {
    return ENTER_TRANSITION
      + ' opacity var(--pk-shell-enter) var(--pk-ease-standard),'
      + ' transform var(--pk-shell-enter) var(--pk-ease-standard)';
  }

  return ENTER_TRANSITION
    + ' opacity var(--pk-overlay-exit) var(--pk-ease-exit),'
    + ' transform var(--pk-shell-enter) var(--pk-ease-enter)';
}

export function resolveWorkspaceSidebarContentOpacity(
  state: Pick<SidebarChromeState, 'phase' | 'isMobile'>,
): string {
  if (state.phase === 'entering' || state.phase === 'focused') return '0';
  if (state.phase === 'exiting') return state.isMobile ? '0' : '1';
  return '1';
}

export function resolveWorkspaceSidebarContentTransform(
  state: Pick<SidebarChromeState, 'phase' | 'isMobile'>,
): string {
  if (state.phase === 'entering' || state.phase === 'focused') {
    return 'translateX(-8px)';
  }
  if (state.phase === 'exiting') {
    return state.isMobile ? 'translateX(-4px)' : 'translateX(0)';
  }
  return 'translateX(0)';
}

export function resolveWorkspaceSidebarContentTransition(
  state: Pick<SidebarChromeState, 'phase' | 'isMobile'>,
): string {
  if (state.isMobile) {
    return MOBILE_SMOOTH_RESTORE_TRANSITION;
  }

  if (state.phase === 'restoring') {
    return 'opacity var(--pk-shell-smooth-restore) var(--pk-ease-restore) 120ms,'
      + ' transform var(--pk-shell-smooth-restore) var(--pk-ease-restore)';
  }

  return 'opacity var(--pk-overlay-exit) var(--pk-ease-standard),'
    + ' transform var(--pk-shell-exit) var(--pk-ease-standard)';
}

function formatSafeAreaTop(topOffsetPx: number): string {
  return `calc(${SAFE_AREA_TOP} + ${topOffsetPx}px)`;
}
