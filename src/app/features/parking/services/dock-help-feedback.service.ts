import { Injectable, OnDestroy, signal } from '@angular/core';
import { PARKING_CONFIG } from '../../../../config/parking.config';

// ── Types ─────────────────────────────────────────────────────

export interface DockActionFeedback {
  message: string;
  tone: 'info' | 'success';
}

export interface FocusHelpSection {
  title: string;
  subtitle: string;
  items: string[];
}

/**
 * Manages the help-overlay, help-nudge, dock-action-feedback,
 * and restore-hint ephemeral-UI states that were previously
 * inlined in ParkingDockComponent.
 *
 * Provided at the component level (not root) so each dock
 * instance gets its own help/feedback state.
 */
@Injectable()
export class DockHelpFeedbackService implements OnDestroy {
  // ── Signals ─────────────────────────────────────────────────
  readonly showHelpOverlay = signal(false);
  readonly showHelpNudge = signal(false);
  readonly dockActionFeedback = signal<DockActionFeedback | null>(null);
  readonly showRestoreHint = signal(false);

  // ── Constants ───────────────────────────────────────────────

  /** Structured help content displayed in the focus-mode help overlay */
  readonly focusHelpSections: FocusHelpSection[] = [
    {
      title: '点击',
      subtitle: '把主要动作显式摆到眼前',
      items: [
        '点击背景卡片可切到前台，系统会给出"已切换到前台"的即时反馈。',
        '补全属性按钮会打开属性面板，关闭后仍留在当前专注上下文。',
        '右上角关闭按钮会先进入退出确认，而不是直接把你踢出专注。',
      ],
    },
    {
      title: '键盘',
      subtitle: '保留快捷方式，但不让它们承担主路径',
      items: [
        'Alt + H 打开这份帮助。',
        'Alt + Shift + F 切换背景虚化；Alt + Shift + D 展开或收起停泊坞。',
        'Esc 只关闭当前层级：先关属性面板/帮助层，再处理虚化或退出确认。',
      ],
    },
    {
      title: '触控',
      subtitle: '移动端不需要记忆隐藏手势也能完成主要操作',
      items: [
        '完成、等待、负荷切换都有明确按钮，优先用按钮而不是手势。',
        '上滑完成仍可用，但现在属于专家快捷方式。',
        'Planner 在手机上会以底部面板展开，便于单手补全属性。',
      ],
    },
  ];

  // ── Timers & Flags ──────────────────────────────────────────
  private helpNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private dockActionFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreHintTimer: ReturnType<typeof setTimeout> | null = null;
  private helpNudgeShownOnce = false;

  // ── Help overlay methods ────────────────────────────────────

  toggleHelpOverlay(): void {
    if (this.showHelpOverlay()) {
      this.closeHelpOverlay();
      return;
    }
    this.showHelpOverlay.set(true);
    this.showHelpNudge.set(false);
  }

  closeHelpOverlay(): void {
    this.showHelpOverlay.set(false);
    this.showHelpNudge.set(false);
  }

  // ── Help nudge ──────────────────────────────────────────────

  /**
   * Show a brief "press Alt+H for help" nudge the first time
   * the user enters focus mode.
   */
  showFocusHelpNudgeOnce(): void {
    if (this.helpNudgeShownOnce) return;
    this.helpNudgeShownOnce = true;
    this.showHelpNudge.set(true);
    if (this.helpNudgeTimer) clearTimeout(this.helpNudgeTimer);
    this.helpNudgeTimer = setTimeout(() => {
      this.showHelpNudge.set(false);
      this.helpNudgeTimer = null;
    }, 4200);
  }

  // ── Dock action feedback ────────────────────────────────────

  /**
   * Show a short-lived feedback toast near the dock bar.
   * Auto-dismisses after 2 400 ms.
   */
  showDockFeedback(message: string, tone: DockActionFeedback['tone']): void {
    this.dockActionFeedback.set({ message, tone });
    if (this.dockActionFeedbackTimer) clearTimeout(this.dockActionFeedbackTimer);
    this.dockActionFeedbackTimer = setTimeout(() => {
      this.dockActionFeedback.set(null);
      this.dockActionFeedbackTimer = null;
    }, 2400);
  }

  // ── Restore hint ────────────────────────────────────────────

  /**
   * Show a transient "session preserved" hint after the user
   * dismisses the focus scrim without ending focus.
   */
  showRestoreHintToast(): void {
    this.showRestoreHint.set(true);
    if (this.restoreHintTimer) clearTimeout(this.restoreHintTimer);
    this.restoreHintTimer = setTimeout(() => {
      this.showRestoreHint.set(false);
      this.restoreHintTimer = null;
    }, PARKING_CONFIG.DOCK_EXIT_CONFIRM_RESTORE_HINT_MS);
  }

  // ── Lifecycle ───────────────────────────────────────────────

  ngOnDestroy(): void {
    if (this.helpNudgeTimer) clearTimeout(this.helpNudgeTimer);
    if (this.dockActionFeedbackTimer) clearTimeout(this.dockActionFeedbackTimer);
    if (this.restoreHintTimer) clearTimeout(this.restoreHintTimer);
  }
}
