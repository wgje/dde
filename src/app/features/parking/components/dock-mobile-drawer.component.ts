import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal } from '@angular/core';
import type { Project } from '../../../../models';
import type { DockEntry } from '../../../../models/parking-dock';
import { formatDockMinutes } from '../utils/dock-format';
import { trapDialogFocus } from '../utils/dock-focus-trap';

/** Mobile presentation only. Task mutations remain owned by ParkingDockComponent. */
@Component({
  selector: 'app-dock-mobile-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dock-mobile-drawer.component.html',
  styleUrl: './dock-mobile-drawer.component.scss',
  host: { '[class.focus-active]': 'focusActive()' },
})
export class DockMobileDrawerComponent implements OnDestroy {
  readonly entries = input<readonly DockEntry[]>([]);
  readonly projects = input<readonly Pick<Project, 'id' | 'name'>[]>([]);
  readonly focusActive = input(false);
  readonly showTrigger = input(true);
  readonly interactive = input(true);
  readonly readOnly = input(false);
  readonly activeView = input<'text' | 'flow'>('text');
  readonly taskConfirmed = output<string>();
  readonly focusRequested = output<void>();
  readonly createRequested = output<void>();
  readonly dismissed = output<void>();

  readonly opened = signal(false);
  readonly previewTaskId = signal<string | null>(null);
  readonly activeEntries = computed(() => this.entries().filter(entry => entry.status !== 'completed'));
  readonly currentEntry = computed(() => this.activeEntries().find(entry => entry.status === 'focusing')
    ?? this.activeEntries().find(entry => entry.isMain) ?? null);
  readonly waitingEntries = computed(() => this.activeEntries().filter(entry =>
    entry.taskId !== this.currentEntry()?.taskId && this.isWaiting(entry)));
  readonly candidates = computed(() => this.activeEntries().filter(entry =>
    entry.taskId !== this.currentEntry()?.taskId && !this.isWaiting(entry)));
  readonly previewEntry = computed(() => this.activeEntries().find(entry => entry.taskId === this.previewTaskId()) ?? null);
  readonly formatTime = formatDockMinutes;

  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private triggerElement: HTMLElement | null = null;
  private previewTrigger: HTMLElement | null = null;
  private destroyed = false;

  constructor() {
    effect(onCleanup => {
      if (!this.opened()) return;
      const originalOverflow = this.document.body.style.overflow;
      this.document.body.style.overflow = 'hidden';
      onCleanup(() => {
        if (this.document.body.style.overflow === 'hidden') this.document.body.style.overflow = originalOverflow;
      });
    });
    effect(() => {
      const view = this.activeView();
      if (view === 'flow') this.close();
    });
    effect(() => {
      const selected = this.previewTaskId();
      if (selected && !this.previewEntry()) this.closePreview();
    });
  }

  openDrawer(trigger?: EventTarget | null): void {
    if (!this.interactive()) return;
    this.triggerElement = trigger instanceof HTMLElement ? trigger : this.document.activeElement as HTMLElement | null;
    this.previewTaskId.set(null);
    this.opened.set(true);
    this.focusAfterRender('[data-testid="dock-v3-mobile-drawer-close"]');
  }

  toggle(): void {
    if (this.opened()) this.close(); else this.openDrawer();
  }

  close(): void {
    if (!this.opened()) return;
    this.opened.set(false);
    this.previewTaskId.set(null);
    this.dismissed.emit();
    queueMicrotask(() => {
      if (this.destroyed || this.opened()) return;
      const trigger = this.triggerElement?.isConnected ? this.triggerElement
        : this.host.nativeElement.querySelector<HTMLElement>('[data-testid="dock-v3-mobile-drawer-trigger"]');
      trigger?.focus();
    });
  }

  preview(taskId: string, trigger?: EventTarget | null): void {
    if (!this.activeEntries().some(entry => entry.taskId === taskId)) return;
    this.previewTrigger = trigger instanceof HTMLElement ? trigger : null;
    this.previewTaskId.set(taskId);
    this.focusAfterRender('[data-testid="dock-v3-mobile-preview-back"]');
  }

  closePreview(): void {
    this.previewTaskId.set(null);
    queueMicrotask(() => { if (!this.destroyed && this.opened()) this.previewTrigger?.focus(); });
  }

  confirmPreview(): void {
    const entry = this.previewEntry();
    if (!entry || this.readOnly() || !this.interactive()) return;
    if (entry.taskId !== this.currentEntry()?.taskId) this.taskConfirmed.emit(entry.taskId);
    this.close();
  }

  requestFocus(): void {
    if (this.readOnly() || !this.interactive()) return;
    this.close();
    this.focusRequested.emit();
  }

  dismissTop(): boolean {
    if (!this.opened()) return false;
    if (this.previewTaskId()) this.closePreview(); else this.close();
    return true;
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.dismissTop();
    } else if (event.key === 'Tab') {
      event.stopPropagation();
      trapDialogFocus(event, '[data-testid="dock-v3-mobile-task-drawer"]');
    }
  }

  projectName(entry: DockEntry): string {
    return entry.sourceProjectId ? this.projects().find(project => project.id === entry.sourceProjectId)?.name ?? '未知项目' : '共享仓';
  }

  statusLabel(entry: DockEntry): string {
    const labels: Record<DockEntry['status'], string> = {
      focusing: '专注中', pending_start: '可行动', suspended_waiting: '等待中',
      wait_finished: '等待结束', stalled: '停滞', completed: '已完成',
    };
    return labels[entry.status];
  }

  ngOnDestroy(): void { this.destroyed = true; }

  private isWaiting(entry: DockEntry): boolean {
    return entry.lane === 'backup' || entry.status === 'suspended_waiting' || entry.status === 'wait_finished';
  }

  readonly isPreviewWaiting = (entry: DockEntry): boolean => this.isWaiting(entry);

  private focusAfterRender(selector: string): void {
    queueMicrotask(() => {
      if (!this.destroyed && this.opened()) this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus();
    });
  }
}
