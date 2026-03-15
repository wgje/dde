import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockHelpFeedbackService } from './dock-help-feedback.service';
import { PARKING_CONFIG } from '../../../../config/parking.config';

describe('DockHelpFeedbackService', () => {
  let service: DockHelpFeedbackService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new DockHelpFeedbackService();
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
  });

  // ── Initial state ──────────────────────────────────────────

  it('should have all signals at default (false/null)', () => {
    expect(service.showHelpOverlay()).toBe(false);
    expect(service.showHelpNudge()).toBe(false);
    expect(service.dockActionFeedback()).toBeNull();
    expect(service.showRestoreHint()).toBe(false);
  });

  it('should expose focusHelpSections with 3 sections', () => {
    expect(service.focusHelpSections).toHaveLength(3);
    for (const section of service.focusHelpSections) {
      expect(section.title).toBeTruthy();
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  // ── toggleHelpOverlay ──────────────────────────────────────

  it('should open help overlay on first toggle', () => {
    service.toggleHelpOverlay();
    expect(service.showHelpOverlay()).toBe(true);
  });

  it('should close help overlay on second toggle', () => {
    service.toggleHelpOverlay(); // open
    service.toggleHelpOverlay(); // close
    expect(service.showHelpOverlay()).toBe(false);
  });

  it('should dismiss nudge when overlay is opened', () => {
    service.showHelpNudge.set(true);
    service.toggleHelpOverlay();
    expect(service.showHelpNudge()).toBe(false);
  });

  // ── closeHelpOverlay ───────────────────────────────────────

  it('should reset both overlay and nudge signals', () => {
    service.showHelpOverlay.set(true);
    service.showHelpNudge.set(true);
    service.closeHelpOverlay();
    expect(service.showHelpOverlay()).toBe(false);
    expect(service.showHelpNudge()).toBe(false);
  });

  // ── showFocusHelpNudgeOnce ─────────────────────────────────

  it('should show nudge and auto-dismiss after 4200ms', () => {
    service.showFocusHelpNudgeOnce();
    expect(service.showHelpNudge()).toBe(true);

    vi.advanceTimersByTime(4199);
    expect(service.showHelpNudge()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(service.showHelpNudge()).toBe(false);
  });

  it('should only fire once per instance', () => {
    service.showFocusHelpNudgeOnce();
    expect(service.showHelpNudge()).toBe(true);

    // Dismiss it manually
    service.showHelpNudge.set(false);

    // Second call should be no-op
    service.showFocusHelpNudgeOnce();
    expect(service.showHelpNudge()).toBe(false);
  });

  // ── showDockFeedback ───────────────────────────────────────

  it('should set feedback and auto-clear after 2400ms', () => {
    service.showDockFeedback('已切换', 'success');
    expect(service.dockActionFeedback()).toEqual({ message: '已切换', tone: 'success' });

    vi.advanceTimersByTime(2399);
    expect(service.dockActionFeedback()).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(service.dockActionFeedback()).toBeNull();
  });

  it('should replace previous feedback when called rapidly', () => {
    service.showDockFeedback('first', 'info');
    vi.advanceTimersByTime(1000);

    service.showDockFeedback('second', 'success');
    expect(service.dockActionFeedback()!.message).toBe('second');

    // First timer should have been cleared; advance only 2400ms from second call
    vi.advanceTimersByTime(2400);
    expect(service.dockActionFeedback()).toBeNull();
  });

  // ── showRestoreHintToast ───────────────────────────────────

  it('should set and auto-clear restore hint', () => {
    const duration = PARKING_CONFIG.DOCK_EXIT_CONFIRM_RESTORE_HINT_MS;

    service.showRestoreHintToast();
    expect(service.showRestoreHint()).toBe(true);

    vi.advanceTimersByTime(duration - 1);
    expect(service.showRestoreHint()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(service.showRestoreHint()).toBe(false);
  });

  // ── ngOnDestroy ────────────────────────────────────────────

  it('should clear all active timers on destroy', () => {
    service.showFocusHelpNudgeOnce();
    service.showDockFeedback('msg', 'info');
    service.showRestoreHintToast();

    service.ngOnDestroy();

    // Advance well past all timers — signals should remain as they were at destroy time
    // (timers were cleared, so the callbacks never fire)
    const snapshot = {
      nudge: service.showHelpNudge(),
      feedback: service.dockActionFeedback(),
      hint: service.showRestoreHint(),
    };

    vi.advanceTimersByTime(60_000);

    expect(service.showHelpNudge()).toBe(snapshot.nudge);
    expect(service.dockActionFeedback()).toBe(snapshot.feedback);
    expect(service.showRestoreHint()).toBe(snapshot.hint);
  });
});
