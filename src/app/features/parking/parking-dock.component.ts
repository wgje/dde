import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DockEngineService } from '../../../services/dock-engine.service';
import { TaskStore } from '../../core/state/stores';
import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../services/logger.service';
import { PARKING_CONFIG } from '../../../config/parking.config';
import { AffinityZone, CognitiveLoad, DockPendingDecisionEntry } from '../../../models/parking-dock';
import { getErrorMessage } from '../../../utils/result';
import { readTaskDragPayload } from '../../../utils/task-drag-payload';
import { DockConsoleStackComponent } from './components/dock-console-stack.component';
import { DockRadarZoneComponent } from './components/dock-radar-zone.component';
import { DockStatusMachineComponent } from './components/dock-status-machine.component';
import { DockDailySlotComponent } from './components/dock-daily-slot.component';

@Component({
  selector: 'app-parking-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    DockConsoleStackComponent,
    DockRadarZoneComponent,
    DockStatusMachineComponent,
    DockDailySlotComponent,
  ],
  styles: [`
    :host {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 50;
      pointer-events: none;
    }

    /* ── 专注模式背景图 ── */
    .focus-bg-image {
      pointer-events: none;
      opacity: 0;
      transition: opacity 1s ease;
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
    }
    .focus-bg-image.active {
      opacity: 1;
    }

    /* ── 专注模式遮罩 ── */
    .focus-backdrop {
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.8s ease, backdrop-filter 0.8s ease, background-color 0.8s ease;
    }
    .focus-backdrop.active {
      opacity: 1;
      pointer-events: auto;
    }

    /* ── 玻璃拟态基础 ── */
    .glass-card {
      background: rgba(28, 25, 23, 0.45);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.45);
    }

    /* ── 底部坞栏 ── */
    .dock-bar {
      pointer-events: auto;
      transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease;
    }
    /* 专注模式 - 收起：滑出底部 */
    .dock-bar.focus-collapsed {
      transform: translateX(-50%) translateY(calc(100% + 40px));
      opacity: 0;
      pointer-events: none;
    }
    /* 专注模式 - 展开：从底部滑入 */
    .dock-bar.focus-expanded {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }

    /* ── 半圆形停泊坞入口 ── */
    .dock-semicircle {
      position: absolute;
      bottom: 0;
      left: 50%;
      z-index: 41;
      pointer-events: auto;
      cursor: pointer;
      transform: translateX(-50%);
      width: 72px;
      height: 36px;
      border-radius: 72px 72px 0 0;
      background: rgba(28, 25, 23, 0.88);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-bottom: none;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: width 0.25s ease, height 0.25s ease, background 0.2s ease,
        box-shadow 0.2s ease;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.4);
    }
    .dock-semicircle:hover {
      width: 90px;
      height: 44px;
      background: rgba(50, 44, 38, 0.95);
      box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.5);
    }
    .dock-semicircle.expanded {
      width: 90px;
      background: rgba(45, 40, 35, 0.92);
    }
    @keyframes semicircleIn {
      from { opacity: 0; transform: translateX(-50%) translateY(36px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    .dock-semicircle-enter {
      animation: semicircleIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    /* ── 坞栏卡片 ── */
    .dock-card {
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      cursor: pointer;
    }
    .dock-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }
    .load-badge-high {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
    }
    .load-badge-low {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }

    /* ── 拖放区域 ── */
    .drop-zone {
      transition: all 0.2s ease;
    }
    .drop-zone.active {
      border-color: rgba(99, 102, 241, 0.6);
      background: rgba(99, 102, 241, 0.1);
    }

    /* ── 主控台舞台 —— 3D 透视容器 ── */
    .console-stage {
      pointer-events: auto;
      perspective: 1200px;
      transform: translateY(48px);
    }

    /* ── 碎片阶段日常任务浮层 ── */
    .fragment-overlay {
      pointer-events: auto;
    }
    @keyframes overlayFadeIn {
      from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
      to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    .fragment-overlay-enter {
      animation: overlayFadeIn 400ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .hide-scrollbar::-webkit-scrollbar {
      display: none;
    }
    .hide-scrollbar {
      -ms-overflow-style: none;
      scrollbar-width: none;
    }

    .new-task-form {
      animation: slideDown 220ms ease-out;
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      .focus-bg-image,
      .focus-backdrop,
      .dock-bar,
      .dock-card,
      .new-task-form,
      .fragment-overlay-enter,
      .dock-semicircle,
      .dock-semicircle-enter {
        transition: none;
        animation: none;
      }
    }
  `],
  template: `
    <div
      class="focus-bg-image fixed inset-0 z-[5]"
      [class.active]="engine.focusMode()"
      [style.background-image]="'url(' + focusBackgroundUrl + ')'">
    </div>

    <div
      class="focus-backdrop fixed inset-0 z-10"
      [class.active]="engine.focusMode()"
      [style.backdrop-filter]="engine.focusMode() ? focusBackdropFilter : 'blur(0px)'"
      [style.webkitBackdropFilter]="engine.focusMode() ? focusBackdropFilter : 'blur(0px)'"
      [style.background-color]="engine.focusMode() ? focusBackdropColor : 'rgba(0,0,0,0)'"
      [style.pointer-events]="engine.focusMode() ? 'auto' : 'none'"
      (click)="onBackdropClick()">
    </div>

    @if (engine.focusMode()) {
      <div class="fixed top-6 right-8 z-50" style="pointer-events: auto;">
        <app-dock-status-machine></app-dock-status-machine>
      </div>
    }

    @if (engine.focusMode()) {
      <div
        class="fixed inset-0 z-30 flex items-center justify-center console-stage"
        data-testid="dock-v3-focus-stage">
        <app-dock-console-stack class="relative z-20"></app-dock-console-stack>

        @if (!strictSampleMode && pendingDecisionEntries().length >= 2) {
          <div
            class="absolute left-1/2 -translate-x-1/2 -top-24 z-30 glass-card rounded-2xl px-3 py-2.5 border border-indigo-400/30 shadow-xl min-w-[360px] max-w-[520px]"
            data-testid="dock-v3-pending-decision">
            <div class="text-[10px] text-indigo-300/80 font-mono tracking-wide">
              {{ engine.pendingDecision()?.reason || '候选任务时长匹配异常，请手动二选一' }}
            </div>
            <div class="text-[10px] text-stone-500 mt-1">
              主任务剩余窗口 {{ formatTime(Math.ceil(engine.pendingDecision()?.rootRemainingMinutes || 0)) }}
            </div>
            <div class="mt-2 grid grid-cols-2 gap-2">
              @for (entry of pendingDecisionEntries(); track entry.taskId; let i = $index) {
                <button
                  type="button"
                  class="rounded-xl border px-3 py-2 text-left transition-all hover:-translate-y-0.5"
                  [ngClass]="i === 0 ? 'border-amber-400/50 bg-amber-500/10' : 'border-indigo-400/50 bg-indigo-500/10'"
                  (click)="choosePendingCandidate(entry.taskId)"
                  [attr.data-testid]="'dock-v3-pending-choice-' + i">
                  <div class="text-[10px] font-mono mb-1" [class.text-amber-300]="i === 0" [class.text-indigo-300]="i === 1">
                    {{ i === 0 ? '候选 C（原序）' : '推荐 D（替换）' }}
                  </div>
                  <div class="text-xs text-stone-100 font-medium truncate">{{ entry.title }}</div>
                  <div class="mt-1 text-[10px] text-stone-400">
                    {{ entry.zone === 'strong' ? '强关联' : '弱关联' }} · {{ entry.load === 'low' ? '低负荷' : '高负荷' }}
                  </div>
                  <div class="mt-0.5 text-[10px] text-stone-500 font-mono">
                    {{ entry.expectedMinutes ? formatTime(entry.expectedMinutes) : '未设置时间' }}
                  </div>
                </button>
              }
            </div>
          </div>
        }

        <app-dock-radar-zone
          class="absolute left-1/2 top-1/2 z-10"
          style="width: 0; height: 0;">
        </app-dock-radar-zone>
      </div>

      @if (engine.isFragmentPhase()) {
        <div class="fragment-overlay fragment-overlay-enter fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40"
             style="pointer-events: auto;">
          <app-dock-daily-slot></app-dock-daily-slot>
        </div>
      }
    }

    <div
      class="dock-semicircle dock-semicircle-enter"
      [class.expanded]="dockExpanded()"
      (click)="toggleDockExpanded()"
      data-testid="dock-v3-semicircle"
      [attr.aria-label]="dockExpanded() ? '收起停泊坞' : '展开停泊坞'"
      role="button"
      tabindex="0"
      (keydown.enter)="toggleDockExpanded()"
      (keydown.space)="$event.preventDefault(); toggleDockExpanded()">
      @if (dockExpanded()) {
        <!-- 向下箭头：收起 -->
        <svg class="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      } @else {
        <!-- 向上箭头：展开 -->
        <svg class="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
        </svg>
      }
    </div>

    <div
      class="dock-bar absolute bottom-6 left-1/2 -translate-x-1/2 z-40 w-full max-w-4xl px-4"
      [class.focus-collapsed]="!dockExpanded()"
      [class.focus-expanded]="dockExpanded()"
      data-testid="dock-v3-panel">
      <div class="glass-card rounded-2xl p-4 flex flex-col gap-4 border border-stone-700/50 shadow-2xl" data-testid="dock-v3-shell">
        <div class="flex items-center justify-between px-2">
          <div class="flex items-center gap-3">
            <h3 class="text-sm font-semibold text-stone-200 tracking-wide">
              停泊坞
              <span class="text-stone-500 font-mono text-xs">{{ engine.dockedCount() }} 块</span>
            </h3>
          </div>

          <div class="flex items-center gap-2">
            @if (showAdvancedUi) {
              <button
                type="button"
                (click)="toggleNewTaskForm()"
                class="px-3 py-1.5 rounded-full text-xs text-stone-400 hover:text-stone-200 hover:bg-stone-700/50 transition-colors"
                style="min-height: 44px;"
                data-testid="dock-v3-create-toggle">
                + 新建
              </button>
            }

            <button
              type="button"
              (click)="engine.toggleFocusMode()"
              class="px-4 py-1.5 rounded-full text-xs font-bold transition-all"
              [class.bg-stone-100]="engine.focusMode()"
              [class.text-stone-900]="engine.focusMode()"
              [class.bg-stone-800]="!engine.focusMode()"
              [class.text-stone-300]="!engine.focusMode()"
              [class.hover:bg-stone-700]="!engine.focusMode()"
              [style.box-shadow]="engine.focusMode() ? '0 0 15px rgba(255,255,255,0.4)' : 'none'"
              style="min-height: 44px;"
              data-testid="dock-v3-focus-toggle">
              {{ engine.focusMode() ? '✖ 退出专注' : '⚡ 专注模式' }}
            </button>
          </div>
        </div>

        @if (showAdvancedUi && showNewTaskForm()) {
          <div class="new-task-form flex flex-col gap-2 px-2">
            <div class="flex items-center gap-2">
              <input
                type="text"
                [(ngModel)]="newTaskTitle"
                (keydown.enter)="createTask()"
                class="flex-1 text-xs py-2 px-3 rounded-lg bg-stone-800/80 border border-stone-700 text-stone-200 placeholder:text-stone-500 focus:border-indigo-500 outline-none"
                placeholder="输入任务名称…" />
              <select
                [(ngModel)]="newTaskZone"
                class="text-xs py-2 px-2 rounded-lg bg-stone-800/80 border border-stone-700 text-stone-300 outline-none">
                <option value="strong">强关联</option>
                <option value="weak">弱关联</option>
              </select>
              <select
                [(ngModel)]="newTaskLoad"
                class="text-xs py-2 px-2 rounded-lg bg-stone-800/80 border border-stone-700 text-stone-300 outline-none">
                <option value="low">低负荷</option>
                <option value="high">高负荷</option>
              </select>
            </div>
            <div class="grid grid-cols-4 gap-2">
              <input
                type="number"
                [(ngModel)]="newTaskExpectedMinutes"
                min="1"
                placeholder="预计(min)"
                class="text-xs py-2 px-2 rounded-lg bg-stone-800/80 border border-stone-700 text-stone-200 placeholder:text-stone-500 focus:border-indigo-500 outline-none" />
              <input
                type="number"
                [(ngModel)]="newTaskWaitMinutes"
                min="1"
                placeholder="等待(min)"
                class="text-xs py-2 px-2 rounded-lg bg-stone-800/80 border border-stone-700 text-stone-200 placeholder:text-stone-500 focus:border-indigo-500 outline-none" />
              <input
                type="text"
                [(ngModel)]="newTaskDetail"
                placeholder="任务详情（可选）"
                class="col-span-2 text-xs py-2 px-2 rounded-lg bg-stone-800/80 border border-stone-700 text-stone-200 placeholder:text-stone-500 focus:border-indigo-500 outline-none" />
            </div>
            <div class="flex justify-end">
              <button
                type="button"
                (click)="createTask()"
                class="px-3 py-2 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                style="min-height: 44px;"
                data-testid="dock-v3-create-submit">
                添加
              </button>
            </div>
          </div>
        }

        <div class="flex gap-3 overflow-x-auto pb-2 hide-scrollbar snap-x" (dragover)="onDragOver($event)" (drop)="onDrop($event)">
          @for (entry of engine.dockedEntries(); track entry.taskId) {
            <div
              class="dock-card flex-shrink-0 w-48 p-3 rounded-xl border snap-start"
              [ngClass]="{
                'bg-indigo-500/20 border-indigo-500/50': entry.isMain,
                'bg-stone-800/50 border-stone-700/50 hover:bg-stone-800': !entry.isMain
              }"
              (wheel)="onCardWheel($event, entry.taskId)"
              (click)="onDockCardClick(entry.taskId)"
              (touchstart)="onTouchStart($event, entry.taskId)"
              (touchmove)="onTouchMove($event, entry.taskId)"
              (touchend)="onTouchEnd()"
              draggable="false"
              data-testid="dock-v3-item">
              <div class="flex items-center justify-between mb-2">
                <span class="text-[9px] px-1.5 py-0.5 rounded font-medium" [class.load-badge-high]="entry.load === 'high'" [class.load-badge-low]="entry.load === 'low'">
                  {{ entry.load === 'high' ? '高负荷' : '低负荷' }}
                </span>
                <span class="text-[10px] text-stone-500 font-mono">
                  @if (entry.expectedMinutes) {
                    {{ formatTime(entry.expectedMinutes) }}
                  }
                </span>
              </div>
              <div class="text-xs font-medium text-stone-200 line-clamp-2">{{ entry.title }}</div>
            </div>
          }

          <div
            class="drop-zone flex-shrink-0 w-48 rounded-xl border border-dashed border-stone-600 bg-stone-800/20 flex flex-col items-center justify-center text-stone-500 text-xs gap-2"
            [class.active]="isDragOver()"
            (dragover)="onDragOver($event)"
            (dragleave)="onDragLeave()"
            (drop)="onDrop($event)"
            style="min-height: 80px;"
            data-testid="dock-v3-drop-zone">
            <svg class="w-5 h-5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            拖入任务块
          </div>
        </div>
      </div>
    </div>

    @if (showHelpHints) {
      <div class="absolute top-4 left-4 z-50 text-white/40 text-[10px] space-y-1 pointer-events-none"
           data-testid="dock-v3-help-hints">
        <p>使用鼠标拖拽模拟任务交互（内部状态接管）</p>
        <p>滚动: 鼠标放在任务上按住 Alt + 滚轮 切换任务认知负荷</p>
        <p>提示: 进入专注模式查看 3D 叠层与雷达轨道界面</p>
      </div>
    }
  `,
})
export class ParkingDockComponent implements OnDestroy {
  readonly engine = inject(DockEngineService);
  private readonly taskStore = inject(TaskStore);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly logger = inject(LoggerService).category('ParkingDock');

  readonly showNewTaskForm = signal(false);
  readonly isDragOver = signal(false);
  readonly dockExpanded = computed(() => this.engine.dockExpanded());
  readonly strictSampleMode = PARKING_CONFIG.DOCK_V3_STRICT_SAMPLE_UI;
  readonly showAdvancedUi = !this.strictSampleMode && PARKING_CONFIG.DOCK_V3_SHOW_ADVANCED_UI;
  readonly showHelpHints = PARKING_CONFIG.DOCK_V3_SHOW_HELP_HINTS;

  newTaskTitle = '';
  newTaskZone: AffinityZone = 'strong';
  newTaskLoad: CognitiveLoad = 'low';
  newTaskExpectedMinutes: string | number = '';
  newTaskWaitMinutes: string | number = '';
  newTaskDetail = '';

  readonly dockMaxWidth = PARKING_CONFIG.DOCK_EXPANDED_MAX_WIDTH;
  readonly focusBackgroundUrl = PARKING_CONFIG.DOCK_FOCUS_BG_IMAGE_URL;
  readonly focusBackdropFilter = `blur(${PARKING_CONFIG.DOCK_FOCUS_BACKDROP_BLUR_PX}px)`;
  readonly focusBackdropColor = `rgba(0,0,0,${PARKING_CONFIG.DOCK_FOCUS_BACKDROP_ALPHA})`;

  private touchStartY = 0;
  private touchTaskId: string | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.engine.focusMode()) {
      this.engine.toggleFocusMode();
    }
  }

  ngOnDestroy(): void {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
  }

  toggleNewTaskForm(): void {
    if (!this.showAdvancedUi) return;
    this.showNewTaskForm.update(value => !value);
  }

  toggleDockExpanded(): void {
    this.engine.setDockExpanded(!this.engine.dockExpanded());
  }

  onBackdropClick(): void {
    if (!this.engine.focusMode()) return;
    this.engine.toggleFocusMode();
  }

  createTask(): void {
    if (!this.showAdvancedUi) return;
    const title = this.newTaskTitle.trim();
    if (!title) return;

    const detail = this.newTaskDetail.trim();
    const expectedMinutes = this.parseOptionalMinutes(this.newTaskExpectedMinutes);
    const waitMinutes = this.parseOptionalMinutes(this.newTaskWaitMinutes);
    const result = this.taskOps.addTask(title, detail, null, null, false);

    if (!result.ok) {
      this.logger.error('停泊坞新建任务失败', getErrorMessage(result.error));
      return;
    }

    this.engine.dockTask(result.value, this.newTaskZone, {
      sourceKind: 'dock-created',
      sourceSection: 'dock-create',
      load: this.newTaskLoad,
      expectedMinutes,
      waitMinutes,
      detail,
      zoneSource: 'manual',
    });

    this.newTaskTitle = '';
    this.newTaskExpectedMinutes = '';
    this.newTaskWaitMinutes = '';
    this.newTaskDetail = '';
    this.showNewTaskForm.set(false);
  }

  onDockCardClick(taskId: string): void {
    this.engine.setMainTask(taskId);
  }

  onCardWheel(event: WheelEvent, taskId: string): void {
    if (!event.altKey) return;
    event.preventDefault();
    this.engine.toggleLoad(taskId, event.deltaY > 0 ? 'down' : 'up');
  }

  onTouchStart(event: TouchEvent, taskId: string): void {
    this.touchStartY = event.touches[0].clientY;
    this.touchTaskId = taskId;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = setTimeout(() => {
      this.touchTaskId = taskId;
    }, 500);
  }

  onTouchMove(event: TouchEvent): void {
    if (!this.touchTaskId) return;
    const deltaY = event.touches[0].clientY - this.touchStartY;
    if (Math.abs(deltaY) > 30) {
      this.engine.toggleLoad(this.touchTaskId, deltaY > 0 ? 'down' : 'up');
      this.touchStartY = event.touches[0].clientY;
    }
  }

  onTouchEnd(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.touchTaskId = null;
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(true);
  }

  onDragLeave(): void {
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);

    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;

    const payload = readTaskDragPayload(dataTransfer);
    if (payload?.taskId) {
      const sourceSection = payload.source === 'text' || payload.source === 'flow'
        ? payload.source
        : undefined;
      const zoneHint = payload.relationHint === 'strong' || payload.relationHint === 'weak'
        ? payload.relationHint
        : undefined;
      this.engine.dockTask(payload.taskId, zoneHint, {
        sourceSection,
        zoneSource: zoneHint ? 'manual' : 'auto',
      });
      return;
    }

    const text = dataTransfer.getData('text/plain');
    if (!text) return;
    const task = this.taskStore.getTask(text);
    if (task) {
      this.engine.dockTask(text);
    }
  }

  formatTime(minutes: number): string {
    if (minutes >= 1440) {
      const d = Math.floor(minutes / 1440);
      const remainH = Math.floor((minutes % 1440) / 60);
      return remainH > 0 ? `${d}d${remainH}h` : `${d}d`;
    }
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return m > 0 ? `${h}h${m}m` : `${h}h`;
    }
    return `${minutes}m`;
  }

  private parseOptionalMinutes(raw: string | number | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    const value = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }

  pendingDecisionEntries(): DockPendingDecisionEntry[] {
    return this.engine.pendingDecisionEntries().slice(0, 2);
  }

  choosePendingCandidate(taskId: string): void {
    this.engine.choosePendingDecisionCandidate(taskId);
  }
}
