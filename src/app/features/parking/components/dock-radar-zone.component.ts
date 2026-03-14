import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { DockEntry, DockLane, CognitiveLoad, RecommendationGroupType } from '../../../../models/parking-dock';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { ProjectStore } from '../../../core/state/stores';
import {
  RadarLayoutItem,
  ComboSector,
  RadarAvoidRect,
  DEFAULT_RADAR_LAYOUT_CONFIG,
  layoutEntries,
  hashCode,
  rand,
} from '../utils/dock-radar-layout';

interface RadarProjectMeta {
  name: string;
  color: string | null;
}

@Component({
  selector: 'app-dock-radar-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  styles: [`
    :host {
      display: block;
      width: 0;
      height: 0;
      pointer-events: none;
      opacity: 1;
      transform: translateY(0) scale(1);
      transition:
        opacity var(--pk-shell-enter) var(--pk-ease-standard),
        transform var(--pk-shell-enter) var(--pk-ease-standard);
    }

    @keyframes radarStageEnter {
      0% {
        opacity: 0;
        transform: translateY(calc(var(--pk-dist-focus-shift) + 2px)) scale(0.982);
      }
      100% {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    :host-context(.console-stage[data-transition='entering']) {
      animation: radarStageEnter var(--pk-focus-enter) var(--pk-ease-enter) var(--scene-entry-radar-delay, 90ms) both;
    }

    :host-context(.console-stage[data-transition='exiting']) {
      opacity: 0;
      transform: translateY(var(--pk-dist-focus-exit-shift)) scale(0.985);
    }

    :host-context(.console-stage[data-scene='fragment']) {
      opacity: 0.8;
      transform: translateY(var(--pk-dist-focus-shift)) scale(0.985);
    }

    :host-context(.console-stage[data-scrim='off']) {
      opacity: 0.88;
    }

    :host-context(.console-stage[data-performance-tier='T2']),
    :host-context(.console-stage[data-reduced-motion='true']) {
      animation: none !important;
      transition: none !important;
    }

    .orbit-ring {
      pointer-events: none;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      border: 1px dashed rgba(148, 163, 184, 0.08);
    }
    .orbit-ring-combo {
      width: calc(var(--combo-r) * 2);
      height: calc(var(--combo-r) * 1.45);
    }
    .orbit-ring-backup {
      width: calc(var(--backup-r) * 2);
      height: calc(var(--backup-r) * 1.45);
    }

    .region-label {
      pointer-events: none;
      opacity: 0.22;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .radar-item {
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
      transform: translate(-50%, -50%);
      transition:
        opacity var(--pk-radar-hover) var(--pk-ease-standard),
        transform var(--pk-radar-hover) var(--pk-ease-enter);
      contain: layout paint style;
    }
    .radar-item-inner {
      transition:
        transform var(--pk-radar-hover) var(--pk-ease-enter),
        box-shadow var(--pk-radar-hover) var(--pk-ease-standard);
    }
    .radar-item-inner.radar-entering {
      animation-name: radarItemAppear;
      animation-duration: var(--pk-radar-appear);
      animation-timing-function: var(--pk-ease-enter);
      animation-delay: calc(var(--scene-entry-radar-delay, 0ms) + var(--appear-delay, 0ms));
      animation-fill-mode: backwards;
    }
    .radar-item:hover .radar-item-inner,
    .radar-item:focus-visible .radar-item-inner {
      transform: translateY(calc(-1 * var(--pk-dist-radar-float))) scale(1.01);
      box-shadow: 0 5px 16px rgba(15, 23, 42, 0.2);
    }
    .radar-item:focus-visible {
      outline: 1px solid rgba(99, 102, 241, 0.7);
      outline-offset: 2px;
    }

    .glass-pill {
      background: linear-gradient(165deg, rgba(22, 28, 36, 0.84), rgba(16, 22, 32, 0.8));
      border: 1px solid rgba(148, 163, 184, 0.11);
      box-shadow:
        0 4px 20px rgba(0, 0, 0, 0.32),
        0 0 0 1px rgba(99, 102, 241, 0.06);
      contain: layout style;
    }
    .glass-pill-backup {
      background: linear-gradient(165deg, rgba(22, 28, 36, 0.66), rgba(16, 22, 32, 0.58));
      border: 1px solid rgba(148, 163, 184, 0.06);
      box-shadow: 0 3px 14px rgba(0, 0, 0, 0.2);
      contain: layout style;
    }
    .glass-pill-high-load {
      border-left: 2px solid rgba(239, 68, 68, 0.35);
      box-shadow:
        0 4px 20px rgba(0, 0, 0, 0.38),
        -3px 0 12px -4px rgba(239, 68, 68, 0.14);
    }

    .load-dot-high { background: #ef4444; box-shadow: 0 0 6px rgba(239, 68, 68, 0.5); }
    .load-dot-low { background: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.5); }

    @keyframes radarFloat {
      0%, 100% { transform: translate(-50%, -50%) translateY(0); }
      50% { transform: translate(-50%, -50%) translateY(calc(-1 * var(--pk-dist-radar-float))); }
    }
    .radar-float {
      animation: radarFloat var(--float-duration, 3.6s) ease-in-out infinite;
      animation-delay: var(--float-delay, 0s);
    }

    @keyframes radarItemAppear {
      0% {
        opacity: 0;
        transform: scale(0.88)
          translateX(var(--appear-dx, 0px))
          translateY(var(--appear-dy, 0px));
      }
      100% {
        opacity: 1;
        transform: scale(1) translateX(0px) translateY(0px);
      }
    }

    /* ===== 动画: 从主控台淘汰回备选区（从中心向外掉落） ===== */
    @keyframes radarReturnFromConsole {
      0% {
        opacity: 0;
        transform: scale(0.92) translateY(calc(-1 * var(--pk-dist-card-push-start)));
      }
      100% {
        opacity: 1;
        transform: scale(1) translateY(0px);
      }
    }
    .radar-item-inner.radar-returning {
      animation-name: radarReturnFromConsole;
      animation-duration: var(--pk-radar-return);
      animation-timing-function: var(--pk-ease-enter);
      animation-delay: 0ms;
    }

    @keyframes highlightPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    .radar-highlight {
      border: 2px dashed rgba(99, 102, 241, 0.85) !important;
      position: relative;
    }
    .radar-highlight::before {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: inherit;
      border: 3px solid rgba(99, 102, 241, 0.25);
      animation: highlightPulse var(--pk-radar-highlight-pulse) var(--pk-ease-standard) 2;
      pointer-events: none;
    }

    @keyframes magnetSlide {
      0% {
        opacity: var(--start-opacity, 0.65);
        transform: translate(-50%, -50%) scale(1);
      }
      100% {
        opacity: 0;
        transform: translate(
          calc(-50% + var(--magnet-dx, 0px)),
          calc(-50% + var(--magnet-dy, 0px))
        ) scale(1.03);
      }
    }
    .magnet-slide {
      animation: magnetSlide var(--pk-radar-promote) var(--pk-ease-enter) forwards;
      pointer-events: none;
    }

    :host-context(.console-stage[data-performance-tier='T1']) .radar-float {
      animation: none !important;
    }
    :host-context(.console-stage[data-performance-tier='T2']) .radar-float,
    :host-context(.console-stage[data-performance-tier='T2']) .radar-highlight::before {
      animation: none !important;
    }

    .radar-create-form {
      pointer-events: auto;
      background: linear-gradient(165deg, rgba(22, 28, 36, 0.95), rgba(16, 22, 32, 0.92));
      border: 1px solid rgba(148, 163, 184, 0.12);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
      animation: formAppear var(--pk-panel-enter) var(--pk-ease-enter);
    }
    @keyframes formAppear {
      0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
      100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }

    @media (prefers-reduced-motion: reduce) {
      .radar-float, .magnet-slide, .radar-create-form, .radar-highlight::before, .radar-item-inner {
        animation: none;
      }
      .radar-item, .radar-item-inner {
        transition: none;
      }
    }
  `],
  template: `
    <div class="orbit-ring orbit-ring-combo" [style.--combo-r.px]="comboRadius"></div>
    <div class="orbit-ring orbit-ring-backup" [style.--backup-r.px]="backupRadius"></div>

    @if (comboItems().length > 0) {
      <div
        class="region-label absolute text-slate-400 font-mono"
        [style.left.px]="0"
        [style.top.px]="-(comboRadius + 30)"
        style="transform: translateX(-50%);">
        组合选择区
      </div>
    }
    @if (backupItems().length > 0) {
      <div
        class="region-label absolute text-slate-500 font-mono"
        [style.left.px]="0"
        [style.top.px]="-(backupRadius + 30)"
        style="transform: translateX(-50%);">
        备选区
      </div>
    }
    @if (groupSwitchEnabled()) {
      <div
        class="region-label absolute text-indigo-300/70 font-mono"
        [style.left.px]="0"
        [style.top.px]="-18"
        style="transform: translateX(-50%);"
        data-testid="dock-v3-radar-group-indicator">
        当前组：{{ activeGroupLabel() }}
      </div>
    }

    @if (comboOverflowCount() > 0) {
      <button
        type="button"
        class="absolute z-30 px-2 py-1 text-[10px] rounded-full bg-slate-800/90 border border-slate-600/70 text-slate-200 hover:bg-slate-700"
        [style.left.px]="comboRadius * 0.72"
        [style.top.px]="-(comboRadius + 24)"
        style="pointer-events: auto;"
        (click)="onComboOverflowTriggerClick($event)"
        [attr.aria-label]="'查看组合选择区隐藏任务，共 ' + comboOverflowCount() + ' 项'"
        data-testid="dock-v3-radar-combo-overflow-trigger">
        +{{ comboOverflowCount() }}
      </button>
    }

    @if (backupOverflowCount() > 0) {
      <button
        type="button"
        class="absolute z-30 px-2 py-1 text-[10px] rounded-full bg-slate-800/90 border border-slate-600/70 text-slate-200 hover:bg-slate-700"
        [style.left.px]="backupRadius * 0.78"
        [style.top.px]="-(backupRadius + 22)"
        style="pointer-events: auto;"
        (click)="onBackupOverflowTriggerClick($event)"
        [attr.aria-label]="'查看备选区隐藏任务，共 ' + backupOverflowCount() + ' 项'"
        data-testid="dock-v3-radar-backup-overflow-trigger">
        +{{ backupOverflowCount() }}
      </button>
    }


    @for (item of comboItems(); track item.entry.taskId) {
      <div
        class="radar-item absolute glass-pill px-4 py-2.5 rounded-full"
        [class.radar-float]="shouldAnimate(item.entry.taskId)"
        [class.glass-pill-high-load]="item.entry.load === 'high'"
        [class.radar-highlight]="isHighlighted(item.entry.taskId)"
        [class.magnet-slide]="isMagnetSliding(item.entry.taskId)"
        [style.left.px]="item.x"
        [style.top.px]="item.y"
        [style.opacity]="resolveOpacity(item.entry.taskId, comboOpacity)"
        [style.--float-duration]="floatDuration"
        [style.--float-delay]="getFloatDelay(item.entry.taskId, 'combo-select')"
        [style.--magnet-dx.px]="-item.x"
        [style.--magnet-dy.px]="-item.y"
        (click)="onRadarItemClick($event, item.entry.taskId)"
        (dblclick)="onRadarItemDoubleClick($event, 'combo-select')"
        (wheel)="onWheel($event, item.entry.taskId)"
        (touchstart)="onTouchStart($event, item.entry.taskId)"
        (touchmove)="onTouchMove($event, item.entry.taskId)"
        (touchend)="onTouchEnd()"
        role="button"
        tabindex="0"
        [attr.aria-label]="'设为主任务：' + item.entry.title + '，来源项目：' + resolveProjectName(item.entry)"
        [attr.title]="'来源项目：' + resolveProjectName(item.entry)"
        (keydown)="onRadarItemKeydown($event, item.entry.taskId)"
        (mouseenter)="onRadarItemEnter(item.entry.taskId)"
        (mouseleave)="onRadarItemLeave(item.entry.taskId)"
        (focus)="onRadarItemFocus(item.entry.taskId)"
        (blur)="onRadarItemBlur(item.entry.taskId)"
        data-testid="dock-v3-radar-combo-item">
        <div class="radar-item-inner flex items-center gap-2.5"
          [class.radar-entering]="isEntering(item.entry.taskId)"
          [class.radar-returning]="isRadarReturning(item.entry.taskId)"
          [style.--appear-dx]="(-item.x * 0.65) + 'px'"
          [style.--appear-dy]="(-item.y * 0.65) + 'px'"
          [style.--appear-delay]="getAppearDelay(item.entry.taskId, 'combo-select')">
          <div
            class="w-2.5 h-2.5 rounded-full shrink-0 border border-slate-300/30"
            [style.background-color]="resolveProjectColor(item.entry)"
            [attr.aria-label]="'来源项目：' + resolveProjectName(item.entry)"
            [attr.title]="'来源项目：' + resolveProjectName(item.entry)">
          </div>
          <div
            class="w-2.5 h-2.5 rounded-full shrink-0"
            [class.load-dot-high]="item.entry.load === 'high'"
            [class.load-dot-low]="item.entry.load === 'low'">
          </div>
          <span class="text-xs text-slate-100 font-medium whitespace-nowrap">{{ item.entry.title }}</span>
          @if (item.entry.expectedMinutes) {
            <span class="text-[10px] text-slate-500 font-mono">{{ formatTime(item.entry.expectedMinutes) }}</span>
          }
        </div>
      </div>
    }

    @for (item of backupItems(); track item.entry.taskId) {
      <div
        class="radar-item absolute glass-pill-backup px-3 py-1.5 rounded-full"
        [class.radar-float]="shouldAnimate(item.entry.taskId)"
        [class.radar-highlight]="isHighlighted(item.entry.taskId)"
        [class.magnet-slide]="isMagnetSliding(item.entry.taskId)"
        [style.left.px]="item.x"
        [style.top.px]="item.y"
        [style.opacity]="resolveOpacity(item.entry.taskId, backupOpacity)"
        [style.--float-duration]="backupFloatDuration"
        [style.--float-delay]="getFloatDelay(item.entry.taskId, 'backup')"
        [style.--magnet-dx.px]="-item.x"
        [style.--magnet-dy.px]="-item.y"
        (click)="onRadarItemClick($event, item.entry.taskId)"
        (dblclick)="onRadarItemDoubleClick($event, 'backup')"
        (wheel)="onWheel($event, item.entry.taskId)"
        (touchstart)="onTouchStart($event, item.entry.taskId)"
        (touchmove)="onTouchMove($event, item.entry.taskId)"
        (touchend)="onTouchEnd()"
        role="button"
        tabindex="0"
        [attr.aria-label]="'设为主任务：' + item.entry.title + '，来源项目：' + resolveProjectName(item.entry)"
        [attr.title]="'来源项目：' + resolveProjectName(item.entry)"
        (keydown)="onRadarItemKeydown($event, item.entry.taskId)"
        (mouseenter)="onRadarItemEnter(item.entry.taskId)"
        (mouseleave)="onRadarItemLeave(item.entry.taskId)"
        (focus)="onRadarItemFocus(item.entry.taskId)"
        (blur)="onRadarItemBlur(item.entry.taskId)"
        data-testid="dock-v3-radar-backup-item">
        <div class="radar-item-inner flex items-center gap-2"
          [class.radar-entering]="isEntering(item.entry.taskId)"
          [class.radar-returning]="isRadarReturning(item.entry.taskId)"
          [style.--appear-dx]="(-item.x * 0.5) + 'px'"
          [style.--appear-dy]="(-item.y * 0.5) + 'px'"
          [style.--appear-delay]="getAppearDelay(item.entry.taskId, 'backup')">
          <div
            class="w-1.5 h-1.5 rounded-full shrink-0 border border-slate-300/30"
            [style.background-color]="resolveProjectColor(item.entry)"
            [attr.aria-label]="'来源项目：' + resolveProjectName(item.entry)"
            [attr.title]="'来源项目：' + resolveProjectName(item.entry)">
          </div>
          <div
            class="w-1.5 h-1.5 rounded-full shrink-0"
            [class.load-dot-high]="item.entry.load === 'high'"
            [class.load-dot-low]="item.entry.load === 'low'">
          </div>
          <span class="text-[10px] text-slate-400 whitespace-nowrap">{{ item.entry.title }}</span>
          @if (item.entry.expectedMinutes) {
            <span class="text-[9px] text-slate-600 font-mono">{{ formatTime(item.entry.expectedMinutes) }}</span>
          }
        </div>
      </div>
    }

    @if (showComboOverflowPanel() && comboOverflowCount() > 0) {
      <div
        class="absolute z-40 rounded-xl border border-slate-600/70 bg-slate-900/95 p-2.5 w-[220px] max-h-[220px] overflow-y-auto"
        [style.left.px]="comboRadius * 0.44"
        [style.top.px]="-(comboRadius - 4)"
        style="pointer-events: auto;"
        data-testid="dock-v3-radar-combo-overflow-panel">
        <div class="text-[10px] text-slate-300 font-mono mb-2">组合选择区隐藏任务</div>
        @for (entry of comboOverflowEntries(); track entry.taskId) {
          <button
            type="button"
            class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] text-slate-200 hover:bg-slate-700/60"
            (click)="onOverflowEntryClick($event, entry.taskId)">
            <span
              class="w-2 h-2 rounded-full border border-slate-300/30 shrink-0"
              [style.background-color]="resolveProjectColor(entry)"
              [attr.title]="'来源项目：' + resolveProjectName(entry)">
            </span>
            <span class="truncate flex-1">{{ entry.title }}</span>
          </button>
        }
      </div>
    }

    @if (showBackupOverflowPanel() && backupOverflowCount() > 0) {
      <div
        class="absolute z-40 rounded-xl border border-slate-600/70 bg-slate-900/95 p-2.5 w-[220px] max-h-[220px] overflow-y-auto"
        [style.left.px]="backupRadius * 0.48"
        [style.top.px]="-(backupRadius - 8)"
        style="pointer-events: auto;"
        data-testid="dock-v3-radar-backup-overflow-panel">
        <div class="text-[10px] text-slate-300 font-mono mb-2">备选区隐藏任务</div>
        @for (entry of backupOverflowEntries(); track entry.taskId) {
          <button
            type="button"
            class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] text-slate-200 hover:bg-slate-700/60"
            (click)="onOverflowEntryClick($event, entry.taskId)">
            <span
              class="w-2 h-2 rounded-full border border-slate-300/30 shrink-0"
              [style.background-color]="resolveProjectColor(entry)"
              [attr.title]="'来源项目：' + resolveProjectName(entry)">
            </span>
            <span class="truncate flex-1">{{ entry.title }}</span>
          </button>
        }
      </div>
    }

    @if (createFormLane()) {
      <div
        class="radar-create-form absolute rounded-xl p-3 flex flex-col gap-2"
        [style.left.px]="createFormX"
        [style.top.px]="createFormY"
        [style.width.px]="createFormWidth"
        style="transform: translate(-50%, -50%);"
        (click)="$event.stopPropagation()"
        data-testid="dock-v3-radar-create-form">
        <div class="text-[10px] text-slate-400 font-mono mb-1">
          Create {{ createFormLane() === 'combo-select' ? 'Combo-select' : 'Backup' }} Task
        </div>
        <input
          type="text"
          [(ngModel)]="createTitle"
          (keydown.enter)="submitCreate()"
          (keydown.escape)="closeCreateForm()"
          class="text-xs py-1.5 px-2 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-200 placeholder:text-slate-500 focus:border-indigo-500 outline-none"
          placeholder="Task title..." />
        <div class="flex items-center gap-2">
          <select
            [(ngModel)]="createLoad"
            class="text-[10px] py-1 px-1.5 rounded bg-slate-800/80 border border-slate-700 text-slate-300 outline-none flex-1">
            <option value="low">Low Load</option>
            <option value="high">High Load</option>
          </select>
          <input
            type="number"
            [(ngModel)]="createExpected"
            min="1"
            placeholder="min"
            class="w-14 text-[10px] py-1 px-1.5 rounded bg-slate-800/80 border border-slate-700 text-slate-200 outline-none text-center" />
        </div>
        <div class="flex items-center gap-2">
          <input
            type="number"
            [(ngModel)]="createWait"
            min="0"
            placeholder="Wait (min)"
            class="flex-1 text-[10px] py-1 px-1.5 rounded bg-slate-800/80 border border-slate-700 text-slate-200 outline-none" />
          <button
            type="button"
            (click)="submitCreate()"
            class="px-2.5 py-1 text-[10px] rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            style="min-height: 28px;">
            Add
          </button>
          <button
            type="button"
            (click)="closeCreateForm()"
            class="px-2 py-1 text-[10px] rounded-lg hover:bg-slate-700/60 text-slate-400 transition-colors"
            style="min-height: 28px;">
            Close
          </button>
        </div>
      </div>
    }
  `,
})
export class DockRadarZoneComponent implements OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly projectStore = inject(ProjectStore);
  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly comboRadius = PARKING_CONFIG.RADAR_STRONG_RADIUS;
  readonly backupRadius = PARKING_CONFIG.RADAR_WEAK_RADIUS;
  readonly comboOpacity = PARKING_CONFIG.RADAR_STRONG_OPACITY;
  readonly backupOpacity = PARKING_CONFIG.RADAR_WEAK_OPACITY;
  readonly floatDuration = `${PARKING_CONFIG.RADAR_FLOAT_DURATION_S}s`;
  readonly backupFloatDuration = `${PARKING_CONFIG.RADAR_FLOAT_DURATION_S + 0.8}s`;
  readonly createFormWidth = PARKING_CONFIG.RADAR_CREATE_FORM_WIDTH;
  readonly enableRadarFloat = PARKING_CONFIG.FOCUS_ENABLE_RADAR_FLOAT;
  readonly comboVisibleLimit = PARKING_CONFIG.RADAR_COMBO_VISIBLE_LIMIT;
  readonly backupVisibleLimit = PARKING_CONFIG.RADAR_BACKUP_VISIBLE_LIMIT;
  private readonly hoverExitLingerMs = PARKING_CONFIG.MOTION.radar.hoverMs;
  private readonly radarLayoutConfig = DEFAULT_RADAR_LAYOUT_CONFIG;

  private readonly highlightedIds = this.engine.highlightedIds;
  private readonly magnetSlidingIds = signal(new Set<string>());
  private readonly hoverFloatIds = signal(new Set<string>());
  private readonly focusFloatIds = signal(new Set<string>());
  private readonly overlayAvoidRects = signal<RadarAvoidRect[]>([]);
  private readonly knownTaskIds = signal(new Set<string>());
  private readonly enteringTaskIds = signal(new Set<string>());
  readonly promotionLockTaskId = signal<string | null>(null);
  /** 从主控台被淘汰回备选区的 taskId 集合（用于触发返回入场动画） */
  private readonly radarReturningIds = signal(new Set<string>());
  private readonly enteringTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly radarReturnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private promotionTimer: ReturnType<typeof setTimeout> | null = null;
  private overlayAvoidRefreshRaf: number | null = null;

  // 监听淘汰信号：engine 淘汰卡片回备选区时短暂标记 returning 状态
  private readonly radarEvictEffect = effect(() => {
    const evictedId = this.engine.lastRadarEvictedTaskId();
    if (!evictedId) return;
    this.radarReturningIds.update(prev => {
      const next = new Set(prev);
      next.add(evictedId);
      return next;
    });
    this.engine.lastRadarEvictedTaskId.set(null);
    // 入场动画结束后清除标记
    this.clearRadarReturnTimer(evictedId);
    const timer = setTimeout(() => {
      this.radarReturnTimers.delete(evictedId);
      this.radarReturningIds.update(prev => {
        const next = new Set(prev);
        next.delete(evictedId);
        return next;
      });
    }, PARKING_CONFIG.MOTION.radar.returnMs + 80);
    this.radarReturnTimers.set(evictedId, timer);
  });

  // 首次出现在当前雷达区的任务只播放一次 appear，索引变化不再重播。
  private readonly radarEnterEffect = effect(() => {
    const visibleTaskIds = [
      ...this.comboItems().map(item => item.entry.taskId),
      ...this.backupItems().map(item => item.entry.taskId),
    ];
    const knownTaskIds = this.knownTaskIds();
    const newTaskIds = visibleTaskIds.filter(taskId => !knownTaskIds.has(taskId));
    if (newTaskIds.length === 0) return;

    this.knownTaskIds.update(prev => {
      const next = new Set(prev);
      newTaskIds.forEach(taskId => next.add(taskId));
      return next;
    });

    newTaskIds.forEach(taskId => {
      this.enteringTaskIds.update(prev => {
        const next = new Set(prev);
        next.add(taskId);
        return next;
      });
      this.scheduleEnteringCleanup(taskId);
    });
  });
  private readonly overlayAvoidEffect = effect(() => {
    this.engine.focusMode();
    this.engine.focusTransition();
    this.comboEntries();
    this.backupEntries();
    this.scheduleOverlayAvoidRectRefresh();
  });

  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly hoverExitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private touchActiveTaskId: string | null = null;
  private touchStartY = 0;
  private touchLongPressed = false;

  readonly createFormLane = signal<DockLane | null>(null);
  readonly showComboOverflowPanel = signal(false);
  readonly showBackupOverflowPanel = signal(false);
  createFormX = 0;
  createFormY = 0;
  createTitle = '';
  createLoad: CognitiveLoad = 'low';
  createExpected: number | string = '';
  createWait: number | string = '';
  readonly groupOrder: RecommendationGroupType[] = [
    'homologous-advancement',
    'cognitive-downgrade',
    'asynchronous-boot',
  ];
  readonly activeGroupIndex = signal(0);

  readonly pendingEntryGroupByTaskId = computed(() =>
    new Map(this.engine.pendingDecisionEntries().map(entry => [entry.taskId, entry.group])),
  );
  readonly groupSwitchEnabled = computed(() => this.pendingEntryGroupByTaskId().size > 0);
  readonly activeGroup = computed<RecommendationGroupType>(() =>
    this.groupOrder[this.activeGroupIndex()] ?? 'homologous-advancement',
  );
  readonly activeGroupLabel = computed(() => {
    const group = this.activeGroup();
    if (group === 'homologous-advancement') return '同源推进';
    if (group === 'cognitive-downgrade') return '认知降低';
    return '异步并发';
  });

  readonly projectMetaById = computed(() => {
    const map = new Map<string, RadarProjectMeta>();
    for (const project of this.projectStore.projects()) {
      map.set(project.id, {
        name: project.name || '未命名项目',
        color: this.readProjectColor(project),
      });
    }
    return map;
  });

  readonly comboEntries = computed(() => this.engine.comboSelectEntries());
  readonly backupEntries = computed(() => this.engine.backupEntries());
  readonly comboOverflowEntries = computed(() =>
    this.comboEntries().slice(this.comboVisibleLimit),
  );
  readonly backupOverflowEntries = computed(() =>
    this.backupEntries().slice(this.backupVisibleLimit),
  );
  readonly comboOverflowCount = computed(() => this.comboOverflowEntries().length);
  readonly backupOverflowCount = computed(() => this.backupOverflowEntries().length);

  readonly comboItems = computed(() =>
    this.layoutRadarEntries(
      this.comboEntries().slice(0, this.comboVisibleLimit),
      'combo-select',
      this.comboRadius,
      this.comboRadius * 0.84,
    ),
  );

  readonly backupItems = computed(() =>
    this.layoutRadarEntries(
      this.backupEntries().slice(0, this.backupVisibleLimit),
      'backup',
      this.backupRadius,
      this.backupRadius * 0.92,
    ),
  );

  ngOnDestroy(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    for (const timer of this.hoverExitTimers.values()) {
      clearTimeout(timer);
    }
    this.hoverExitTimers.clear();
    for (const timer of this.enteringTimers.values()) {
      clearTimeout(timer);
    }
    this.enteringTimers.clear();
    for (const timer of this.radarReturnTimers.values()) {
      clearTimeout(timer);
    }
    this.radarReturnTimers.clear();
    if (this.overlayAvoidRefreshRaf !== null) {
      cancelAnimationFrame(this.overlayAvoidRefreshRaf);
      this.overlayAvoidRefreshRaf = null;
    }
  }

  @HostListener('window:resize')
  onViewportResize(): void {
    this.scheduleOverlayAvoidRectRefresh();
  }

  @HostListener('window:pointerup')
  onGlobalPointerUp(): void {
    this.scheduleOverlayAvoidRectRefresh();
  }

  getFloatDelay(taskId: string, lane: DockLane): string {
    const duration = lane === 'combo-select'
      ? PARKING_CONFIG.RADAR_FLOAT_DURATION_S
      : PARKING_CONFIG.RADAR_FLOAT_DURATION_S + 0.8;
    const phase = 0.2 + rand(hashCode(`${taskId}:${lane}:phase`)) * 0.72;
    return `${-(duration * phase).toFixed(2)}s`;
  }

  isHighlighted(taskId: string): boolean {
    return this.highlightedIds().has(taskId);
  }

  isRadarReturning(taskId: string): boolean {
    return this.radarReturningIds().has(taskId);
  }

  isMagnetSliding(taskId: string): boolean {
    return this.magnetSlidingIds().has(taskId);
  }

  isEntering(taskId: string): boolean {
    return !this.isRadarReturning(taskId) && this.enteringTaskIds().has(taskId);
  }

  shouldAnimate(taskId: string): boolean {
    if (this.isMagnetSliding(taskId)) return false;
    return this.enableRadarFloat
      || this.isHighlighted(taskId)
      || this.hoverFloatIds().has(taskId)
      || this.focusFloatIds().has(taskId);
  }

  /** Backward-compatible alias for existing tests/callers. */
  onRadarItemInteract(taskId: string): void {
    this.onRadarItemEnter(taskId);
  }

  onRadarItemEnter(taskId: string): void {
    this.clearHoverExitTimer(taskId);
    this.hoverFloatIds.update(prev => {
      if (prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
  }

  onRadarItemLeave(taskId: string): void {
    this.scheduleHoverFloatRemoval(taskId);
  }

  onRadarItemFocus(taskId: string): void {
    this.clearHoverExitTimer(taskId);
    this.focusFloatIds.update(prev => {
      if (prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
  }

  onRadarItemBlur(taskId: string): void {
    this.scheduleFocusFloatRemoval(taskId);
  }

  onWheel(event: WheelEvent, taskId: string): void {
    if (!this.canInteract()) return;
    if (event.altKey) {
      event.preventDefault();
      this.engine.toggleLoad(taskId, event.deltaY > 0 ? 'down' : 'up');
      return;
    }
    if (this.groupSwitchEnabled()) {
      event.preventDefault();
      this.cycleGroup(event.deltaY > 0 ? 1 : -1);
    }
  }

  onTouchStart(event: TouchEvent, taskId: string): void {
    if (!this.canInteract()) return;
    this.touchStartY = event.touches?.[0]?.clientY ?? 0;
    this.touchActiveTaskId = taskId;
    this.touchLongPressed = false;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = setTimeout(() => {
      this.touchLongPressed = true;
    }, 420);
  }

  onTouchMove(event: TouchEvent, taskId: string): void {
    if (!this.canInteract()) return;
    const deltaY = (event.touches?.[0]?.clientY ?? 0) - this.touchStartY;
    if (this.groupSwitchEnabled() && !this.touchLongPressed && Math.abs(deltaY) > 40) {
      this.cycleGroup(deltaY > 0 ? 1 : -1);
      this.touchStartY = event.touches?.[0]?.clientY ?? 0;
      return;
    }

    if (!this.touchLongPressed || this.touchActiveTaskId !== taskId) return;
    if (Math.abs(deltaY) < 28) return;
    this.engine.toggleLoad(taskId, deltaY > 0 ? 'down' : 'up');
    this.touchStartY = event.touches?.[0]?.clientY ?? 0;
  }

  onTouchEnd(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.touchLongPressed = false;
    this.touchActiveTaskId = null;
  }

  onRadarItemKeydown(event: KeyboardEvent, taskId: string): void {
    if (!this.canInteract()) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.promoteToConsole(taskId);
  }

  onRadarItemClick(event: MouseEvent, taskId: string): void {
    event.stopPropagation();
    this.promoteToConsole(taskId);
  }

  onOverflowEntryClick(event: MouseEvent, taskId: string): void {
    event.stopPropagation();
    this.promoteToConsole(taskId);
  }

  onRadarItemDoubleClick(event: MouseEvent, lane: DockLane): void {
    event.stopPropagation();
    this.openCreateForm(lane, event);
  }

  onComboOverflowTriggerClick(event: MouseEvent): void {
    event.stopPropagation();
    this.toggleComboOverflowPanel();
  }

  onBackupOverflowTriggerClick(event: MouseEvent): void {
    event.stopPropagation();
    this.toggleBackupOverflowPanel();
  }

  toggleComboOverflowPanel(): void {
    if (!this.canInteract()) return;
    if (this.comboOverflowCount() <= 0) {
      this.showComboOverflowPanel.set(false);
      return;
    }
    this.showComboOverflowPanel.update(prev => !prev);
    if (this.showComboOverflowPanel()) {
      this.showBackupOverflowPanel.set(false);
    }
  }

  toggleBackupOverflowPanel(): void {
    if (!this.canInteract()) return;
    if (this.backupOverflowCount() <= 0) {
      this.showBackupOverflowPanel.set(false);
      return;
    }
    this.showBackupOverflowPanel.update(prev => !prev);
    if (this.showBackupOverflowPanel()) {
      this.showComboOverflowPanel.set(false);
    }
  }

  promoteToConsole(taskId: string): void {
    if (!this.canInteract()) return;
    if (this.promotionLockTaskId() !== null) return;
    this.showComboOverflowPanel.set(false);
    this.showBackupOverflowPanel.set(false);
    this.promotionLockTaskId.set(taskId);
    this.magnetSlidingIds.update(prev => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    this.promotionTimer = setTimeout(() => {
      this.promotionTimer = null;
      this.magnetSlidingIds.update(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      // 专注模式下：插入到 C 位但不改变主任务，溢出卡片回到备选区
      if (this.engine.focusMode()) {
        this.engine.insertToConsoleFromRadar(taskId);
      } else {
        this.engine.setMainTask(taskId);
      }
      if (this.promotionLockTaskId() === taskId) {
        this.promotionLockTaskId.set(null);
      }
    }, PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS);
  }

  openCreateForm(lane: DockLane, _event: MouseEvent): void {
    if (!this.canInteract()) return;
    this.showComboOverflowPanel.set(false);
    this.showBackupOverflowPanel.set(false);
    this.createFormLane.set(lane);
    this.createFormX = 0;
    this.createFormY = lane === 'combo-select'
      ? -(this.comboRadius - 24)
      : -(this.backupRadius - 24);
    this.createTitle = '';
    this.createLoad = 'low';
    this.createExpected = '';
    this.createWait = '';
  }

  closeCreateForm(): void {
    this.createFormLane.set(null);
  }

  submitCreate(): void {
    if (!this.canInteract()) return;
    const lane = this.createFormLane();
    if (!lane) return;
    const title = this.createTitle.trim();
    if (!title) return;

    const expectedMinutes = this.parseOptionalNumber(this.createExpected);
    const waitMinutes = this.parseOptionalNumber(this.createWait);

    this.engine.createInDock(title, lane, this.createLoad, {
      expectedMinutes,
      waitMinutes,
    });
    this.closeCreateForm();
  }

  formatTime(minutes: number): string {
    if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }

  getAppearDelay(taskId: string, lane: DockLane): string {
    const seed = hashCode(`${taskId}:${lane}:appear`);
    const minDelay = lane === 'combo-select' ? 24 : 72;
    const spread = lane === 'combo-select' ? 132 : 168;
    return `${Math.round(minDelay + (rand(seed) * spread))}ms`;
  }

  resolveOpacity(taskId: string, baseOpacity: number): number {
    if (!this.groupSwitchEnabled()) return baseOpacity;
    const group = this.pendingEntryGroupByTaskId().get(taskId);
    if (!group) return baseOpacity * 0.35;
    return group === this.activeGroup() ? baseOpacity : baseOpacity * 0.3;
  }

  resolveProjectName(entry: DockEntry): string {
    if (!entry.sourceProjectId) return '共享仓';
    return this.projectMetaById().get(entry.sourceProjectId)?.name ?? '未知项目';
  }

  resolveProjectColor(entry: DockEntry): string {
    if (!entry.sourceProjectId) return PARKING_CONFIG.RADAR_PROJECT_SHARED_COLOR;
    const explicit = this.projectMetaById().get(entry.sourceProjectId)?.color;
    if (explicit) return explicit;
    return this.hashProjectColor(entry.sourceProjectId);
  }

  private cycleGroup(step: 1 | -1): void {
    if (!this.groupSwitchEnabled()) return;
    this.activeGroupIndex.update(prev => {
      const total = this.groupOrder.length;
      return (prev + step + total) % total;
    });
  }

  private canInteract(): boolean {
    // 雷达区属于专注控制台 UI，scrim（背景虚化）遮挡的是 app 主体内容，
    // 不应阻止专注控制台内部的交互。仅在 focus 进入/退出过渡动画期间禁用。
    return !this.engine.isFocusTransitionBlocking();
  }

  private parseOptionalNumber(raw: string | number | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    const value = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }

  private layoutRadarEntries(
    entries: DockEntry[],
    lane: DockLane,
    radiusX: number,
    radiusY: number,
  ): RadarLayoutItem[] {
    this.overlayAvoidRects();
    return layoutEntries(
      entries,
      lane,
      radiusX,
      radiusY,
      this.radarLayoutConfig,
      this.pendingEntryGroupByTaskId(),
      this.overlayAvoidRects(),
    );
  }

  private scheduleHoverFloatRemoval(taskId: string): void {
    this.clearHoverExitTimer(taskId);
    const timer = setTimeout(() => {
      this.hoverExitTimers.delete(taskId);
      this.hoverFloatIds.update(prev => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }, this.hoverExitLingerMs);
    this.hoverExitTimers.set(taskId, timer);
  }

  private scheduleFocusFloatRemoval(taskId: string): void {
    this.clearHoverExitTimer(taskId);
    const timer = setTimeout(() => {
      this.hoverExitTimers.delete(taskId);
      this.focusFloatIds.update(prev => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }, this.hoverExitLingerMs);
    this.hoverExitTimers.set(taskId, timer);
  }

  private clearHoverExitTimer(taskId: string): void {
    const timer = this.hoverExitTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.hoverExitTimers.delete(taskId);
  }

  private scheduleEnteringCleanup(taskId: string): void {
    this.clearEnteringTimer(taskId);
    const timer = setTimeout(() => {
      this.enteringTimers.delete(taskId);
      this.enteringTaskIds.update(prev => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }, PARKING_CONFIG.MOTION.radar.appearMs + 40);
    this.enteringTimers.set(taskId, timer);
  }

  private clearEnteringTimer(taskId: string): void {
    const timer = this.enteringTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.enteringTimers.delete(taskId);
  }

  private clearRadarReturnTimer(taskId: string): void {
    const timer = this.radarReturnTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.radarReturnTimers.delete(taskId);
  }

  private scheduleOverlayAvoidRectRefresh(): void {
    if (typeof window === 'undefined') return;
    if (this.overlayAvoidRefreshRaf !== null) {
      cancelAnimationFrame(this.overlayAvoidRefreshRaf);
    }
    this.overlayAvoidRefreshRaf = requestAnimationFrame(() => {
      this.overlayAvoidRefreshRaf = null;
      this.refreshOverlayAvoidRects();
    });
  }

  private refreshOverlayAvoidRects(): void {
    if (typeof document === 'undefined') {
      this.overlayAvoidRects.set([]);
      return;
    }

    const hostRect = this.hostElement.nativeElement.getBoundingClientRect();
    const originX = hostRect.left;
    const originY = hostRect.top;
    const selectors = [
      '[data-testid="dock-v3-status-machine-container"]',
      '[data-testid="dock-v3-focus-exit-btn"]',
      '[data-testid="dock-v3-hud-settings"]',
      '[data-testid="dock-v3-backup-fab"]',
      '[data-testid="dock-v3-pending-decision"]',
      '[data-testid="dock-v3-blank-period-card"]',
    ];

    const next: RadarAvoidRect[] = [];
    selectors.forEach(selector => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      next.push({
        centerX: rect.left + (rect.width / 2) - originX,
        centerY: rect.top + (rect.height / 2) - originY,
        halfWidth: (rect.width / 2) + 12,
        halfHeight: (rect.height / 2) + 10,
      });
    });

    this.overlayAvoidRects.set(next);
  }

  private readProjectColor(project: unknown): string | null {
    if (!project || typeof project !== 'object') return null;
    const source = project as Record<string, unknown>;
    const color =
      source.color ??
      source.accentColor ??
      source.themeColor;
    if (typeof color !== 'string') return null;
    const normalized = color.trim();
    return normalized ? normalized : null;
  }

  private hashProjectColor(projectId: string): string {
    const palette = PARKING_CONFIG.RADAR_PROJECT_COLOR_PALETTE;
    const index = hashCode(projectId) % palette.length;
    return palette[index] ?? PARKING_CONFIG.RADAR_PROJECT_SHARED_COLOR;
  }
}
