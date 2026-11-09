import { describe, expect, it } from 'vitest';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import {
  resolveDockFocusSceneMode,
  resolveFocusStageTransform,
  resolveHudContainerStyle,
  resolveDockCenterLeft,
  resolveDockSecondaryRailActive,
  resolveHudMinimalMode,
  resolveFocusSceneTransitionPhase,
  shouldHideSemicircleOnMobileFlow,
  shouldMountFocusConsoleStage,
  shouldMountFocusFloatingUi,
  shouldShowInlineDockCreate,
  shouldShowZenMode,
  resolveSidebarEffectiveWidth,
  canOpenFloatingHudWindow,
  canToggleFocusScrim,
  canUseInlineDockCreate,
  isFocusSessionInteractive,
  isFocusSessionMounted,
  shouldPassThroughMinimalHud,
} from './dock-focus-ui';

describe('dock-focus-ui', () => {
  describe('resolveDockFocusSceneMode', () => {
    it('prioritizes zen, burnout, fragment, decision, then steady', () => {
      expect(resolveDockFocusSceneMode({
        focusSessionMounted: true,
        fragmentDefenseLevel: 4,
        burnoutActive: true,
        fragmentPhase: true,
        blankPeriodActive: true,
        pendingDecisionActive: true,
      })).toBe('zen');

      expect(resolveDockFocusSceneMode({
        focusSessionMounted: false,
        fragmentDefenseLevel: 4,
        burnoutActive: true,
        fragmentPhase: true,
        blankPeriodActive: true,
        pendingDecisionActive: true,
      })).toBe('burnout');

      expect(resolveDockFocusSceneMode({
        focusSessionMounted: false,
        fragmentDefenseLevel: 1,
        burnoutActive: false,
        fragmentPhase: true,
        blankPeriodActive: false,
        pendingDecisionActive: true,
      })).toBe('fragment');

      expect(resolveDockFocusSceneMode({
        focusSessionMounted: false,
        fragmentDefenseLevel: 1,
        burnoutActive: false,
        fragmentPhase: false,
        blankPeriodActive: false,
        pendingDecisionActive: true,
      })).toBe('decision');

      expect(resolveDockFocusSceneMode({
        focusSessionMounted: false,
        fragmentDefenseLevel: 1,
        burnoutActive: false,
        fragmentPhase: false,
        blankPeriodActive: false,
        pendingDecisionActive: false,
      })).toBe('steady');
    });
  });

  describe('resolveFocusStageTransform', () => {
    it('keeps the existing mobile and desktop stage offsets', () => {
      expect(resolveFocusStageTransform(true, true)).toBe('translateY(-128px)');
      expect(resolveFocusStageTransform(true, false)).toBe('translateY(calc(50vh - 260px))');
      expect(resolveFocusStageTransform(false, true)).toBe('translateY(-80px)');
      expect(resolveFocusStageTransform(false, false)).toBe('translateY(calc(50vh - 240px))');
    });
  });

  describe('resolveHudContainerStyle', () => {
    it('centers the minimal HUD with mobile safe-area top offset', () => {
      expect(resolveHudContainerStyle({
        minimalMode: true,
        mobile: true,
        dragging: false,
        position: null,
        fallbackPosition: { x: 10, y: 20 },
      })).toEqual({
        top: `calc(env(safe-area-inset-top) + ${PARKING_CONFIG.HUD_MINIMAL_MOBILE_TOP_PX}px)`,
        left: '50%',
        right: 'auto',
        transform: 'translateX(-50%)',
        cursor: 'default',
        width: `${PARKING_CONFIG.HUD_MINIMAL_WIDTH_PX}px`,
      });
    });

    it('uses saved position and grabbing cursor in full HUD mode', () => {
      expect(resolveHudContainerStyle({
        minimalMode: false,
        mobile: false,
        dragging: true,
        position: { x: 15, y: 25 },
        fallbackPosition: { x: 10, y: 20 },
      })).toEqual({
        top: '25px',
        left: '15px',
        right: 'auto',
        transform: 'none',
        cursor: 'grabbing',
        width: 'auto',
      });
    });
  });

  describe('dock layout helpers', () => {
    it('ignores sidebar width on mobile or when the sidebar is closed', () => {
      expect(resolveSidebarEffectiveWidth({ mobile: true, sidebarOpen: true, sidebarWidth: 320 })).toBe(0);
      expect(resolveSidebarEffectiveWidth({ mobile: false, sidebarOpen: false, sidebarWidth: 320 })).toBe(0);
      expect(resolveSidebarEffectiveWidth({ mobile: false, sidebarOpen: true, sidebarWidth: 320 })).toBe(320);
    });

    it('keeps the dock centered when there is no desktop sidebar offset', () => {
      expect(resolveDockCenterLeft(0)).toBe('50%');
      expect(resolveDockCenterLeft(320)).toBe('calc(50% + 160px)');
    });

    it('hides the semicircle only for the mobile flow view', () => {
      expect(shouldHideSemicircleOnMobileFlow({ mobile: true, activeView: 'flow' })).toBe(true);
      expect(shouldHideSemicircleOnMobileFlow({ mobile: true, activeView: 'text' })).toBe(false);
      expect(shouldHideSemicircleOnMobileFlow({ mobile: false, activeView: 'flow' })).toBe(false);
    });

    it('keeps secondary rail active only while a mounted focus session has scrim enabled', () => {
      expect(resolveDockSecondaryRailActive({ focusSessionMounted: true, focusScrimOn: true })).toBe(true);
      expect(resolveDockSecondaryRailActive({ focusSessionMounted: true, focusScrimOn: false })).toBe(false);
      expect(resolveDockSecondaryRailActive({ focusSessionMounted: false, focusScrimOn: true })).toBe(false);
    });
  });

  describe('floating HUD helpers', () => {
    it('uses minimal HUD mode only for focused sessions with scrim disabled or external HUD active', () => {
      expect(resolveHudMinimalMode({ focusSessionPhase: 'focused', focusScrimOn: false, externalHudActive: false })).toBe(true);
      expect(resolveHudMinimalMode({ focusSessionPhase: 'focused', focusScrimOn: true, externalHudActive: true })).toBe(true);
      expect(resolveHudMinimalMode({ focusSessionPhase: 'focused', focusScrimOn: true, externalHudActive: false })).toBe(false);
      expect(resolveHudMinimalMode({ focusSessionPhase: 'idle', focusScrimOn: false, externalHudActive: true })).toBe(false);
    });

    it('passes pointer events through only for mobile minimal HUD', () => {
      expect(shouldPassThroughMinimalHud({ mobile: true, minimalMode: true })).toBe(true);
      expect(shouldPassThroughMinimalHud({ mobile: false, minimalMode: true })).toBe(false);
      expect(shouldPassThroughMinimalHud({ mobile: true, minimalMode: false })).toBe(false);
    });

    it('allows external HUD only in focused desktop sessions when supported', () => {
      expect(canOpenFloatingHudWindow({ focusSessionPhase: 'focused', mobile: false, supported: true })).toBe(true);
      expect(canOpenFloatingHudWindow({ focusSessionPhase: 'focused', mobile: true, supported: true })).toBe(false);
      expect(canOpenFloatingHudWindow({ focusSessionPhase: 'focused', mobile: false, supported: false })).toBe(false);
      expect(canOpenFloatingHudWindow({ focusSessionPhase: 'idle', mobile: false, supported: true })).toBe(false);
    });
  });

  describe('focus session helpers', () => {
    it('derives mounted and interactive flags from the focus UI phase', () => {
      expect(isFocusSessionMounted('idle')).toBe(false);
      expect(isFocusSessionMounted('entering')).toBe(true);
      expect(isFocusSessionMounted('focused')).toBe(true);
      expect(isFocusSessionInteractive('focused')).toBe(true);
      expect(isFocusSessionInteractive('entering')).toBe(false);
    });

    it('maps idle to no scene transition phase', () => {
      expect(resolveFocusSceneTransitionPhase('idle')).toBeNull();
      expect(resolveFocusSceneTransitionPhase('entering')).toBe('entering');
      expect(resolveFocusSceneTransitionPhase('focused')).toBe('focused');
    });

    it('keeps console mounted during active focus except the exiting phase', () => {
      expect(shouldMountFocusConsoleStage({ focusSessionMounted: true, focusSessionPhase: 'focused' })).toBe(true);
      expect(shouldMountFocusConsoleStage({ focusSessionMounted: true, focusSessionPhase: 'exiting' })).toBe(false);
      expect(shouldMountFocusConsoleStage({ focusSessionMounted: false, focusSessionPhase: 'idle' })).toBe(false);
    });

    it('keeps floating UI mounted while focused or while the transition service says it remains visible', () => {
      expect(shouldMountFocusFloatingUi({ focusSessionPhase: 'focused', floatingUiVisible: false })).toBe(true);
      expect(shouldMountFocusFloatingUi({ focusSessionPhase: 'exiting', floatingUiVisible: true })).toBe(true);
      expect(shouldMountFocusFloatingUi({ focusSessionPhase: 'idle', floatingUiVisible: false })).toBe(false);
    });

    it('keeps inline create and scrim controls gated by mutation and focus state', () => {
      expect(canUseInlineDockCreate({ canMutateDock: true, focusSessionMounted: true, focusScrimOn: true })).toBe(false);
      expect(canUseInlineDockCreate({ canMutateDock: true, focusSessionMounted: true, focusScrimOn: false })).toBe(true);
      expect(shouldShowInlineDockCreate({ focusSessionMounted: true, focusScrimOn: true })).toBe(false);
      expect(shouldShowInlineDockCreate({ focusSessionMounted: false, focusScrimOn: true })).toBe(true);
      expect(canToggleFocusScrim({ focusSessionInteractive: true, canMutateDock: true })).toBe(true);
      expect(canToggleFocusScrim({ focusSessionInteractive: false, canMutateDock: true })).toBe(false);
    });

    it('shows zen mode only for mounted sessions at defense level four or higher', () => {
      expect(shouldShowZenMode({ focusSessionMounted: true, fragmentDefenseLevel: 4 })).toBe(true);
      expect(shouldShowZenMode({ focusSessionMounted: true, fragmentDefenseLevel: 3 })).toBe(false);
      expect(shouldShowZenMode({ focusSessionMounted: false, fragmentDefenseLevel: 4 })).toBe(false);
    });
  });
});
