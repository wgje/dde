import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import {
  createWorkspaceSidebarChromeSignals,
  resolveCompactStartupHintBannerTop,
  resolveFocusWorkspaceTakeoverActive,
  resolveInstallPromptTop,
  resolveMobileFloatingNoticeBaseTopOffsetPx,
  resolveBlockingStartupHintOverlayVisible,
  resolveCompactStartupHintBannerVisible,
  resolveWorkspaceSidebarContentOpacity,
  resolveWorkspaceSidebarContentTransform,
  resolveWorkspaceSidebarContentTransition,
  resolveWorkspaceCompactStartupHintBannerTop,
  resolveWorkspaceSidebarChromePresentation,
  resolveWorkspaceSidebarOpacity,
  resolveWorkspaceSidebarPointerEvents,
  resolveWorkspaceSidebarTransform,
  resolveWorkspaceSidebarTransition,
  resolveWorkspaceSidebarWidth,
  type FloatingNoticeState,
  type SidebarChromeState,
} from './workspace-shell-chrome.helpers';

function sidebarState(overrides: Partial<SidebarChromeState>): SidebarChromeState {
  return {
    phase: 'idle',
    isMobile: false,
    sidebarOpen: true,
    sidebarWidth: 320,
    ...overrides,
  };
}

function noticeState(overrides: Partial<FloatingNoticeState>): FloatingNoticeState {
  return {
    isMobile: true,
    mobileDemoBannerVisible: false,
    mobileOfflineNoticeVisible: false,
    installPromptVisible: false,
    ...overrides,
  };
}

describe('workspace-shell-chrome.helpers', () => {
  it('resolves focus takeover state and desktop sidebar chrome', () => {
    expect(resolveFocusWorkspaceTakeoverActive('idle')).toBe(false);
    expect(resolveFocusWorkspaceTakeoverActive('entering')).toBe(true);
    expect(resolveWorkspaceSidebarWidth(sidebarState({ phase: 'entering' }))).toBe(320);
    expect(resolveWorkspaceSidebarWidth(sidebarState({ sidebarOpen: false }))).toBe(0);
    expect(resolveWorkspaceSidebarOpacity(sidebarState({ phase: 'focused' }))).toBe('0');
    expect(resolveWorkspaceSidebarOpacity(sidebarState({ phase: 'exiting' }))).toBe('1');
    expect(resolveWorkspaceSidebarTransform(sidebarState({ phase: 'entering' }))).toBe('translateX(-8px) scale(0.992)');
    expect(resolveWorkspaceSidebarTransform(sidebarState({ phase: 'exiting' }))).toBe('translateX(0) scale(1)');
    expect(resolveWorkspaceSidebarPointerEvents(sidebarState({ phase: 'restoring' }))).toBe('none');
  });

  it('resolves mobile sidebar as overlay transform with disabled hidden hit testing', () => {
    expect(resolveWorkspaceSidebarWidth(sidebarState({ isMobile: true }))).toBe(240);
    expect(resolveWorkspaceSidebarTransform(sidebarState({ isMobile: true, sidebarOpen: true }))).toBe('translateX(0)');
    expect(resolveWorkspaceSidebarTransform(sidebarState({ isMobile: true, sidebarOpen: false }))).toBe('translateX(calc(-100% - 12px))');
    expect(resolveWorkspaceSidebarPointerEvents(sidebarState({ isMobile: true, sidebarOpen: false }))).toBe('none');
    expect(resolveWorkspaceSidebarPointerEvents(sidebarState({ isMobile: true, sidebarOpen: true }))).toBe('auto');
  });

  it('resolves sidebar content transitions across focus phases', () => {
    expect(resolveWorkspaceSidebarContentOpacity(sidebarState({ phase: 'focused' }))).toBe('0');
    expect(resolveWorkspaceSidebarContentOpacity(sidebarState({ phase: 'restoring' }))).toBe('1');
    expect(resolveWorkspaceSidebarContentTransform(sidebarState({ phase: 'exiting', isMobile: true }))).toBe('translateX(-4px)');
    expect(resolveWorkspaceSidebarContentTransition(sidebarState({ phase: 'restoring' }))).toContain('120ms');
    expect(resolveWorkspaceSidebarTransition(sidebarState({ phase: 'restoring' }))).toContain('var(--pk-ease-restore-snappy)');
  });

  it('resolves the full sidebar chrome presentation from one state snapshot', () => {
    expect(resolveWorkspaceSidebarChromePresentation(sidebarState({
      phase: 'focused',
      isMobile: false,
      sidebarOpen: true,
      sidebarWidth: 320,
    }))).toEqual({
      takeoverActive: true,
      phase: 'focused',
      widthPx: 320,
      opacity: '0',
      transform: 'translateX(-8px) scale(0.992)',
      pointerEvents: 'none',
      transition: resolveWorkspaceSidebarTransition(sidebarState({ phase: 'focused' })),
      contentOpacity: '0',
      contentTransform: 'translateX(-8px)',
      contentTransition: resolveWorkspaceSidebarContentTransition(sidebarState({ phase: 'focused' })),
    });
  });

  it('creates reactive sidebar chrome signals from shell state signals', () => {
    const phase = signal<SidebarChromeState['phase']>('idle');
    const isMobile = signal(false);
    const sidebarOpen = signal(true);
    const sidebarWidth = signal(320);
    const chrome = createWorkspaceSidebarChromeSignals({
      phase,
      isMobile,
      sidebarOpen,
      sidebarWidth,
    });

    expect(chrome.focusWorkspaceTakeoverActive()).toBe(false);
    expect(chrome.workspaceSidebarWidthPx()).toBe(320);
    expect(chrome.mobileSidebarBackdropVisible()).toBe(false);

    phase.set('focused');
    expect(chrome.focusWorkspaceTakeoverActive()).toBe(true);
    expect(chrome.workspaceSidebarOpacity()).toBe('0');

    phase.set('idle');
    isMobile.set(true);
    sidebarOpen.set(true);
    expect(chrome.workspaceSidebarWidthPx()).toBe(240);
    expect(chrome.mobileSidebarBackdropVisible()).toBe(true);
  });

  it('stacks mobile floating notices below demo, offline, and install banners', () => {
    expect(resolveMobileFloatingNoticeBaseTopOffsetPx(noticeState({ mobileDemoBannerVisible: true }))).toBe(104);
    expect(resolveMobileFloatingNoticeBaseTopOffsetPx(noticeState({ mobileOfflineNoticeVisible: true }))).toBe(84);
    expect(resolveMobileFloatingNoticeBaseTopOffsetPx(noticeState({
      mobileDemoBannerVisible: true,
      mobileOfflineNoticeVisible: true,
    }))).toBe(146);

    expect(resolveInstallPromptTop(true, 146)).toBe('calc(env(safe-area-inset-top, 0px) + 146px)');
    expect(resolveInstallPromptTop(false, 146)).toBe('calc(env(safe-area-inset-top, 0px) + 12px)');
    expect(resolveCompactStartupHintBannerTop(noticeState({}))).toBe('calc(env(safe-area-inset-top, 0px) + 56px)');
    expect(resolveCompactStartupHintBannerTop(noticeState({ mobileOfflineNoticeVisible: true }))).toBe('calc(env(safe-area-inset-top, 0px) + 84px)');
    expect(resolveCompactStartupHintBannerTop(noticeState({
      mobileDemoBannerVisible: true,
      mobileOfflineNoticeVisible: true,
      installPromptVisible: true,
    }))).toBe('calc(env(safe-area-inset-top, 0px) + 190px)');
  });

  it('resolves startup hint visibility outside the shell component', () => {
    expect(resolveBlockingStartupHintOverlayVisible({
      hintOnlyStartupPlaceholderVisible: true,
      isMobile: false,
    })).toBe(true);
    expect(resolveBlockingStartupHintOverlayVisible({
      hintOnlyStartupPlaceholderVisible: true,
      isMobile: true,
    })).toBe(false);
    expect(resolveCompactStartupHintBannerVisible({
      hintOnlyStartupPlaceholderVisible: true,
      isMobile: true,
    })).toBe(true);
    expect(resolveCompactStartupHintBannerVisible({
      hintOnlyStartupPlaceholderVisible: false,
      isMobile: true,
    })).toBe(false);
  });

  it('resolves compact startup hint stacking from shell-ready notice offsets', () => {
    expect(resolveWorkspaceCompactStartupHintBannerTop({
      isMobile: true,
      mobileOfflineNoticeVisible: true,
      mobileFloatingNoticeBaseTopOffsetPx: 72,
      installPromptVisible: false,
    })).toBe('calc(env(safe-area-inset-top, 0px) + 84px)');
    expect(resolveWorkspaceCompactStartupHintBannerTop({
      isMobile: true,
      mobileOfflineNoticeVisible: false,
      mobileFloatingNoticeBaseTopOffsetPx: 104,
      installPromptVisible: false,
    })).toBe('calc(env(safe-area-inset-top, 0px) + 104px)');
    expect(resolveWorkspaceCompactStartupHintBannerTop({
      isMobile: true,
      mobileOfflineNoticeVisible: true,
      mobileFloatingNoticeBaseTopOffsetPx: 146,
      installPromptVisible: true,
    })).toBe('calc(env(safe-area-inset-top, 0px) + 190px)');
  });
});
