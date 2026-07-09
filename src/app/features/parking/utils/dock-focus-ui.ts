import { PARKING_CONFIG } from '../../../../config/parking.config';
import type { DockFocusTransitionPhase } from '../../../../models/parking-dock';
import type { DockFocusUiPhase } from '../../../../utils/dock-focus-phase';
import type { DockFocusSceneMode } from '../components/dock-focus-scene.component';
import type { HudPosition } from './dock-hud-position';

export interface DockFocusSceneModeState {
  focusSessionMounted: boolean;
  fragmentDefenseLevel: number;
  burnoutActive: boolean;
  fragmentPhase: boolean;
  blankPeriodActive: boolean;
  pendingDecisionActive: boolean;
}

export interface HudContainerStyleState {
  minimalMode: boolean;
  mobile: boolean;
  dragging: boolean;
  position: HudPosition | null;
  fallbackPosition: HudPosition;
}

export interface SidebarEffectiveWidthState {
  mobile: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

export interface MobileViewState {
  mobile: boolean;
  activeView: 'text' | 'flow' | null;
}

export interface DockSecondaryRailState {
  focusSessionMounted: boolean;
  focusScrimOn: boolean;
}

export interface HudMinimalModeState {
  focusSessionPhase: DockFocusUiPhase;
  focusScrimOn: boolean;
  externalHudActive: boolean;
}

export interface MinimalHudPassThroughState {
  mobile: boolean;
  minimalMode: boolean;
}

export interface FloatingHudWindowState {
  focusSessionPhase: DockFocusUiPhase;
  mobile: boolean;
  supported: boolean;
}

export interface FocusConsoleStageState {
  focusSessionMounted: boolean;
  focusSessionPhase: DockFocusUiPhase;
}

export interface FocusFloatingUiState {
  focusSessionPhase: DockFocusUiPhase;
  floatingUiVisible: boolean;
}

export interface InlineDockCreateState {
  canMutateDock: boolean;
  focusSessionMounted: boolean;
  focusScrimOn: boolean;
}

export interface InlineDockCreateVisibilityState {
  focusSessionMounted: boolean;
  focusScrimOn: boolean;
}

export interface FocusScrimToggleState {
  focusSessionInteractive: boolean;
  canMutateDock: boolean;
}

export interface ZenModeVisibilityState {
  focusSessionMounted: boolean;
  fragmentDefenseLevel: number;
}

export function resolveDockFocusSceneMode(state: DockFocusSceneModeState): DockFocusSceneMode {
  if (state.focusSessionMounted && state.fragmentDefenseLevel >= 4) {
    return 'zen';
  }
  if (state.burnoutActive) {
    return 'burnout';
  }
  if (state.fragmentPhase || state.blankPeriodActive) {
    return 'fragment';
  }
  if (state.pendingDecisionActive) {
    return 'decision';
  }
  return 'steady';
}

export function resolveSidebarEffectiveWidth(state: SidebarEffectiveWidthState): number {
  if (state.mobile || !state.sidebarOpen) return 0;
  return state.sidebarWidth;
}

export function resolveDockCenterLeft(sidebarEffectiveWidth: number): string {
  return sidebarEffectiveWidth === 0 ? '50%' : `calc(50% + ${sidebarEffectiveWidth / 2}px)`;
}

export function shouldHideSemicircleOnMobileFlow(state: MobileViewState): boolean {
  return state.mobile && state.activeView === 'flow';
}

export function isFocusSessionMounted(phase: DockFocusUiPhase): boolean {
  return phase !== 'idle';
}

export function isFocusSessionInteractive(phase: DockFocusUiPhase): boolean {
  return phase === 'focused';
}

export function resolveFocusSceneTransitionPhase(
  phase: DockFocusUiPhase,
): DockFocusTransitionPhase | null {
  return phase === 'idle' ? null : phase;
}

export function shouldMountFocusConsoleStage(state: FocusConsoleStageState): boolean {
  return state.focusSessionMounted && state.focusSessionPhase !== 'exiting';
}

export function shouldMountFocusFloatingUi(state: FocusFloatingUiState): boolean {
  return state.focusSessionPhase === 'focused' || state.floatingUiVisible;
}

export function canUseInlineDockCreate(state: InlineDockCreateState): boolean {
  return state.canMutateDock && !(state.focusSessionMounted && state.focusScrimOn);
}

export function shouldShowInlineDockCreate(state: InlineDockCreateVisibilityState): boolean {
  return !state.focusSessionMounted || !state.focusScrimOn;
}

export function canToggleFocusScrim(state: FocusScrimToggleState): boolean {
  return state.focusSessionInteractive && state.canMutateDock;
}

export function resolveDockSecondaryRailActive(state: DockSecondaryRailState): boolean {
  return state.focusSessionMounted && state.focusScrimOn;
}

export function shouldShowZenMode(state: ZenModeVisibilityState): boolean {
  return state.focusSessionMounted && state.fragmentDefenseLevel >= 4;
}

export function resolveHudMinimalMode(state: HudMinimalModeState): boolean {
  return state.focusSessionPhase === 'focused'
    && (!state.focusScrimOn || state.externalHudActive);
}

export function shouldPassThroughMinimalHud(state: MinimalHudPassThroughState): boolean {
  return state.mobile && state.minimalMode;
}

export function canOpenFloatingHudWindow(state: FloatingHudWindowState): boolean {
  return state.focusSessionPhase === 'focused' && !state.mobile && state.supported;
}

export function resolveFocusStageTransform(mobile: boolean, dockExpanded: boolean): string {
  if (mobile) {
    return dockExpanded ? 'translateY(-128px)' : 'translateY(calc(50vh - 260px))';
  }
  return dockExpanded ? 'translateY(-80px)' : 'translateY(calc(50vh - 240px))';
}

export function resolveHudContainerStyle(state: HudContainerStyleState): Record<string, string> {
  if (state.minimalMode) {
    return resolveMinimalHudContainerStyle(state.mobile);
  }

  const position = state.position ?? state.fallbackPosition;
  return {
    top: `${position.y}px`,
    left: `${position.x}px`,
    right: 'auto',
    transform: 'none',
    cursor: state.dragging ? 'grabbing' : 'default',
    width: 'auto',
  };
}

function resolveMinimalHudContainerStyle(mobile: boolean): Record<string, string> {
  const minimalTop = mobile
    ? `calc(env(safe-area-inset-top) + ${PARKING_CONFIG.HUD_MINIMAL_MOBILE_TOP_PX}px)`
    : `${PARKING_CONFIG.HUD_MINIMAL_TOP_PX}px`;

  return {
    top: minimalTop,
    left: '50%',
    right: 'auto',
    transform: 'translateX(-50%)',
    cursor: 'default',
    width: `${PARKING_CONFIG.HUD_MINIMAL_WIDTH_PX}px`,
  };
}
