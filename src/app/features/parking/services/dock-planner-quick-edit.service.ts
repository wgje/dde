import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { CognitiveLoad } from '../../../../models/parking-dock';
import type { DockPlannerQuickEditPresentation } from '../components/dock-planner-quick-edit.component';

/**
 * Manages the planner quick-edit panel state, computeds, and mutation
 * methods that were previously inlined in ParkingDockComponent.
 *
 * Provided at the component level (not root) so each dock instance
 * gets its own planner state.
 */
@Injectable()
export class DockPlannerQuickEditService implements OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly uiState = inject(UiStateService);

  // ── Presets (constants) ─────────────────────────────────────
  readonly expectedPresets = [15, 30, 45, 60, 90, 120];
  readonly waitPresets = [5, 10, 15, 30, 45, 60];

  // ── Signals ─────────────────────────────────────────────────
  readonly plannerQuickEditTaskId = signal<string | null>(null);
  readonly recentlyDockedTaskId = signal<string | null>(null);

  // ── Computeds ───────────────────────────────────────────────

  /** Mobile shows bottom sheet; desktop shows popover */
  readonly presentation = computed<DockPlannerQuickEditPresentation>(
    () => this.uiState.isMobile() ? 'sheet' : 'popover',
  );

  /** The dock entry that matches the currently-open planner, or null */
  readonly activeEntry = computed(() => {
    const taskId = this.plannerQuickEditTaskId();
    if (!taskId) return null;
    return this.engine.orderedDockEntries().find(entry => entry.taskId === taskId) ?? null;
  });

  /** Whether a bottom-sheet backdrop should be rendered */
  readonly backdropVisible = computed(
    () => this.activeEntry() !== null && this.presentation() === 'sheet',
  );

  /** Number of required fields still missing on the active planner entry */
  readonly missingFieldCount = computed(() => {
    const entry = this.activeEntry();
    if (!entry) return 0;
    let count = 0;
    if (entry.expectedMinutes === null) count += 1;
    // waitMinutes is optional and does not count as missing
    return count;
  });

  /** First dock entry that is missing required attributes (for the banner) */
  readonly bannerTarget = computed(() => {
    // Don't show the banner when a planner panel is already open
    if (this.activeEntry()) return null;
    const entries = this.engine.orderedDockEntries();
    // Prefer the main task
    const main = entries.find(e => e.isMain && e.expectedMinutes === null);
    if (main) return main;
    return entries.find(e => e.expectedMinutes === null) ?? null;
  });

  /** Missing-field count for the banner target */
  readonly bannerMissingCount = computed(() => {
    const entry = this.bannerTarget();
    if (!entry) return 0;
    let count = 0;
    if (entry.expectedMinutes === null) count += 1;
    return count;
  });

  /** CSS class string for the inline planner panel */
  readonly panelClasses = computed(() => {
    return 'mx-2 rounded-2xl border border-slate-600/55 bg-slate-950/97 p-3.5 shadow-[0_8px_32px_rgba(2,6,23,0.4)] backdrop-blur-md overflow-hidden animate-[plannerSlideOpen_200ms_ease-out]';
  });

  // ── Timers ──────────────────────────────────────────────────
  private recentlyDockedTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Public methods ──────────────────────────────────────────

  isPlannerQuickEditOpen(taskId: string): boolean {
    return this.plannerQuickEditTaskId() === taskId;
  }

  /**
   * Toggle the planner panel for a given task.
   * The caller must verify `canUsePlannerQuickEdit()` before calling.
   */
  togglePlannerQuickEdit(taskId: string): void {
    if (this.plannerQuickEditTaskId() === taskId) {
      this.closePlannerQuickEdit();
      return;
    }
    this.plannerQuickEditTaskId.set(taskId);
    this.engine.setDockExpanded(true);
  }

  /**
   * Close the planner panel.
   * Returns the task ID that was open (or null) so the caller can
   * restore focus to the trigger button if desired.
   */
  closePlannerQuickEdit(): string | null {
    const taskId = this.plannerQuickEditTaskId();
    this.plannerQuickEditTaskId.set(null);
    return taskId;
  }

  /**
   * Set cognitive load for a dock entry via the planner panel.
   * The caller must verify `canUsePlannerQuickEdit()` before calling.
   */
  setPlannerQuickEditLoad(taskId: string, nextLoad: CognitiveLoad): void {
    const entry = this.engine.orderedDockEntries().find(item => item.taskId === taskId) ?? null;
    if (!entry || entry.load === nextLoad) return;
    this.engine.toggleLoad(taskId, nextLoad === 'high' ? 'up' : 'down');
  }

  /**
   * Set expected-time for a dock entry via the planner panel.
   * The caller must verify `canUsePlannerQuickEdit()` before calling.
   */
  setPlannerQuickEditExpected(taskId: string, minutes: number | null): void {
    this.engine.setExpectedTime(taskId, minutes);
  }

  /**
   * Set wait-window for a dock entry via the planner panel.
   * The caller must verify `canUsePlannerQuickEdit()` before calling.
   */
  setPlannerQuickEditWait(taskId: string, minutes: number | null): void {
    this.engine.setWaitTime(taskId, minutes);
  }

  /**
   * Mark a task as recently docked (highlight ring for 3 seconds).
   * Also dismisses the planner panel if it was open for this task.
   */
  markRecentlyDocked(taskId: string): void {
    this.recentlyDockedTaskId.set(taskId);
    if (this.recentlyDockedTimer) {
      clearTimeout(this.recentlyDockedTimer);
    }
    this.recentlyDockedTimer = setTimeout(() => {
      this.recentlyDockedTaskId.set(null);
      this.recentlyDockedTimer = null;
    }, 3000);

    this.plannerQuickEditTaskId.update(current => (current === taskId ? null : current));
  }

  /**
   * Called by the component's effect when the active entry disappears
   * (task removed from dock while planner was open).
   */
  closeIfEntryGone(): void {
    if (!this.plannerQuickEditTaskId()) return;
    if (this.activeEntry()) return;
    this.closePlannerQuickEdit();
  }

  ngOnDestroy(): void {
    if (this.recentlyDockedTimer) clearTimeout(this.recentlyDockedTimer);
  }
}
