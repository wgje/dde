/**
 * ParkingDockComponent — 停泊坞面板
 *
 * 策划案 A6.9 规范
 * 底部向上弹出的停泊任务管理面板，定位于 Text / Flow 分隔线中心
 * 统一桌面 / 移动端 / Text / Flow 所有场景
 *
 * 收起态：胶囊触发条「停泊 (N) ▲」
 * 展开态：列表 + 预览双栏面板（移动端单栏）
 */

import {
  Component,
  inject,
  signal,
  computed,
  OnDestroy,
  ChangeDetectionStrategy,
  HostListener,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UiStateService } from '../../../services/ui-state.service';
import { ParkingService } from '../../../services/parking.service';
import { SimpleReminderService } from '../../../services/simple-reminder.service';
import { SpotlightService } from '../../../services/spotlight.service';
import { TaskStore, ProjectStore } from '../../core/state/stores';
import { PARKING_CONFIG } from '../../../config/parking.config';
import { Task } from '../../../models';

@Component({
  selector: 'app-parking-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  styles: [`
    :host {
      display: block;
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      z-index: 50;
      pointer-events: none;
      /* 禁止在宿主上使用 transform，否则会打破子元素的 position:fixed 参照系 */
    }
    .dock-trigger {
      position: absolute;
      bottom: 0;
      transform: translateX(-50%);
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
      transition: transform 120ms ease-out;
      height: 32px;
    }
    .dock-trigger:hover {
      transform: translateX(-50%) translateY(-2px);
    }
    /* 触发条提醒闪烁动画——边框琥珀色闪烁一次（1s） */
    .dock-trigger-flash {
      animation: triggerAmberFlash 1s ease-in-out 1;
    }
    @keyframes triggerAmberFlash {
      0%   { border-color: rgb(252, 211, 77); box-shadow: 0 0 0 0 rgba(252, 211, 77, 0.4); }
      50%  { border-color: rgb(245, 158, 11); box-shadow: 0 0 8px 2px rgba(245, 158, 11, 0.3); }
      100% { border-color: rgb(252, 211, 77); box-shadow: 0 0 0 0 rgba(252, 211, 77, 0); }
    }
    .dock-panel {
      pointer-events: auto;
      animation: dockSlideUp 200ms ease-out;
    }
    .dock-panel-exit {
      animation: dockSlideDown 200ms ease-out forwards;
    }
    @keyframes dockSlideUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes dockSlideDown {
      from { opacity: 1; transform: translateY(0); }
      to   { opacity: 0; transform: translateY(16px); }
    }
    .dock-backdrop {
      pointer-events: auto;
    }
    /* 移动端 Bottom Sheet */
    .dock-sheet {
      pointer-events: auto;
      animation: sheetSlideUp 200ms ease-out;
    }
    @keyframes sheetSlideUp {
      from { transform: translateY(100%); }
      to   { transform: translateY(0); }
    }
    /* 停泊卡片左侧标记条 */
    .park-card-bar {
      width: 3px;
      border-radius: 2px;
      background-color: rgba(99, 102, 241, 0.4);
    }
    .park-card:hover .park-card-bar {
      background-color: rgba(99, 102, 241, 0.7);
    }
    /* 即将清理标签 */
    .stale-tag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      background-color: rgb(251, 191, 36);
      color: rgb(120, 53, 15);
    }
    /* 移动端触发条底部安全距离（A6.9.5） */
    @media (max-width: 767px) {
      .dock-trigger {
        margin-bottom: max(8px, env(safe-area-inset-bottom, 8px));
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .dock-panel, .dock-sheet { animation: none; }
      .dock-panel-exit { animation-duration: 0ms; }
      .dock-trigger:hover { transform: translateX(-50%); }
      .dock-trigger-flash { animation: none; }
    }
  `],
  template: `
    @if (parkedCount() > 0 || isOpen()) {
      <!-- ═══ 触发条：N=0 且关闭时隐藏，零视觉负担（A6.8） ═══ -->
      <div class="dock-trigger flex items-center justify-center gap-1.5 px-4 rounded-t-xl
                  bg-white/80 dark:bg-stone-800/80 backdrop-blur-md
                  border border-b-0 border-stone-200 dark:border-stone-700
                  shadow-sm text-xs font-medium text-stone-600 dark:text-stone-300"
           data-testid="parking-dock-trigger"
           [style.left.%]="triggerLeftPercent()"
           style="min-width: 200px;"
           [class.border-amber-300]="hasUpcomingReminder()"
           [class.dock-trigger-flash]="hasUpcomingReminder() && !isOpen()"
           [style.z-index]="isOpen() ? 60 : 50"
           (click)="toggleDock()"
           (keydown.enter)="toggleDock()"
           (keydown.space)="toggleDock(); $event.preventDefault()"
           tabindex="0"
           role="button"
           [attr.aria-expanded]="isOpen()"
           aria-label="展开停泊坞">
        <span>停泊 ({{ parkedCount() }}) {{ isOpen() ? '▼' : '▲' }}</span>
        @if (reminderLabel() && !isOpen()) {
          <span class="text-amber-600 dark:text-amber-400">· {{ reminderLabel() }}</span>
        }
      </div>
    }

    <!-- ═══ 展开态 ═══ -->
    @if (isOpen()) {
        <!-- 背景遮罩（点击收起） -->
        <div class="dock-backdrop fixed inset-0 z-40" (click)="closeDock()"></div>

        <!-- ─── 桌面端：面板 ─── -->
        @if (!isMobile()) {
          <div class="dock-panel fixed z-50 rounded-t-xl overflow-hidden flex flex-col
                      border border-b-0 border-stone-200 dark:border-stone-700"
               data-testid="parking-dock-panel"
               [style.width.px]="panelWidth()"
               [style.height.px]="panelHeight()"
               [style.left.px]="panelLeft()"
               [style.bottom]="'0px'"
               [class.dock-panel-exit]="isPanelClosing()"
               style="background: color-mix(in srgb, var(--theme-bg) 80%, transparent); backdrop-filter: blur(16px);
                      box-shadow: 0 -4px 24px rgba(0,0,0,0.08);"
               (keydown.escape)="closeDock()">
            
            <!-- 顶部栏 -->
            <div class="flex items-center justify-between px-4 py-2 border-b border-stone-100 dark:border-stone-700 shrink-0">
              <span class="text-sm font-semibold text-stone-800 dark:text-stone-200">稍后处理</span>
              <div class="flex items-center gap-2">
                @if (isOverSoftLimit()) {
                  <span class="text-[10px] text-amber-600 dark:text-amber-400">停泊任务较多</span>
                }
                <button (click)="closeDock()" 
                        class="p-1 rounded hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-400 dark:text-stone-500"
                        style="min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center;"
                        aria-label="收起停泊坞">
                  <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                  </svg>
                </button>
              </div>
            </div>

            <!-- 双栏内容 -->
            <div class="flex flex-1 min-h-0">
              @if (parkedCount() === 0) {
                <!-- 空态引导 -->
                <div class="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <svg class="h-10 w-10 text-stone-300 dark:text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
                    <polyline points="17 21 17 13 7 13 7 21" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <p class="text-sm text-stone-500 dark:text-stone-400 font-medium">暂无停泊任务</p>
                  <p class="text-xs text-stone-400 dark:text-stone-500 leading-relaxed max-w-[280px]">
                    在任务编辑器中点击「停泊」按钮，可将当前任务暂存到此处，方便稍后继续处理。
                  </p>
                  <div class="flex items-center gap-1.5 mt-1 text-[10px] text-stone-400 dark:text-stone-500">
                    <kbd class="px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-700 border border-stone-200 dark:border-stone-600 font-mono">
                      {{ quickSwitchShortcutLabel() }}
                    </kbd>
                    <span>快速回切上一个停泊任务</span>
                  </div>
                </div>
              } @else {
              <div class="overflow-y-auto border-r border-stone-100 dark:border-stone-700 p-2 flex flex-col gap-1"
                   role="listbox"
                   [style.width.%]="40">
                @for (task of sortedParkedTasks(); track task.id) {
                  <div class="park-card flex items-stretch gap-2 px-2 py-2 rounded-lg cursor-pointer
                              hover:bg-stone-50 dark:hover:bg-stone-700/50 transition-colors group"
                       data-testid="parking-dock-item"
                       [ngClass]="{'bg-indigo-50 dark:bg-indigo-950/40': selectedTaskId() === task.id}"
                       (click)="selectTask(task.id)"
                       (keydown.enter)="startWorkOnSelected()"
                       tabindex="0"
                       role="option"
                       [attr.aria-selected]="selectedTaskId() === task.id">

                    <!-- 左侧蓝色条 -->
                    <div class="park-card-bar shrink-0"></div>

                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1">
                        <!-- 标题 -->
                        <span class="text-xs font-medium text-stone-700 dark:text-stone-200 truncate">
                          {{ task.title || '未命名任务' }}
                        </span>
                        <!-- 红点徽章 -->
                        @if (hasBadge(task.id)) {
                          <span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
                        }
                        <!-- 固定图标 -->
                        @if (task.parkingMeta?.pinned) {
                          <svg class="h-3 w-3 text-stone-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M10 2a1 1 0 011 1v1.323l3.954 1.582 1.599-.8a1 1 0 01.894 1.79l-1.233.617 1.738 5.42a1 1 0 01-.285 1.05 3.001 3.001 0 01-4.462-.308l-.125.168a1 1 0 01-1.06.343L10 14.32V18a1 1 0 11-2 0v-3.68l-1.02.342a1 1 0 01-1.06-.343l-.124-.168a3.001 3.001 0 01-4.463.308 1 1 0 01-.285-1.05l1.738-5.42-1.233-.616a1 1 0 01.894-1.79l1.6.8L9 4.324V3a1 1 0 011-1z"/>
                          </svg>
                        }
                      </div>
                      <!-- 项目名 + 停泊时长 -->
                      <div class="flex items-center gap-1 mt-0.5 min-h-[18px]">
                        <span class="text-[10px] text-stone-400 dark:text-stone-500 truncate">
                          {{ getProjectName(task) }}
                        </span>
                        <span class="text-[10px] text-stone-400 dark:text-stone-500">
                          · {{ formatDuration(task.parkingMeta?.parkedAt) }}
                        </span>
                      </div>
                      <!-- 状态标签 -->
                      <div class="flex items-center gap-1 mt-0.5">
                        @if (isStaleWarning(task)) {
                          <span class="stale-tag">即将清理</span>
                          <button (click)="keepParked(task.id); $event.stopPropagation()"
                                  class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-800/40 transition-colors"
                                  aria-label="保留此任务">
                            保留
                          </button>
                        }
                        @if (hasUpcomingReminderForTask(task)) {
                          <span class="text-[10px] px-1 rounded bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400">
                            {{ formatReminderCountdown(task) }}
                          </span>
                        }
                      </div>
                    </div>

                    <!-- 移除按钮 -->
                    <button (click)="removeTask(task.id, $event)"
                            class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-stone-200 dark:hover:bg-stone-600 text-stone-400 transition-opacity shrink-0 self-start"
                            style="min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center;"
                            title="移回任务列表"
                            aria-label="移回任务列表">
                      <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                      </svg>
                    </button>
                  </div>
                }
              </div>

              <!-- 右半区：预览详情 -->
              <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-3" [style.width.%]="60">
                @if (selectedTask(); as task) {
                  <!-- 状态提示 -->
                  <div class="text-xs text-stone-400 dark:text-stone-500 italic">
                    稍后处理中（未切换到此任务）
                  </div>

                  <!-- 标题编辑 -->
                  <input type="text"
                         [ngModel]="task.title"
                         (ngModelChange)="onTitleChange(task.id, $event)"
                         class="text-sm font-semibold text-stone-800 dark:text-stone-200 bg-transparent border-b border-transparent hover:border-stone-300 dark:hover:border-stone-600 focus:border-indigo-500 outline-none py-0.5 w-full transition-colors"
                         aria-label="编辑任务标题"/>

                  <!-- 内容摘要 -->
                  <div class="text-xs text-stone-600 dark:text-stone-300 leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap">
                    {{ getContentPreview(task) }}
                  </div>

                  <!-- 上下文锚点 -->
                  @if (getAnchorDisplay(task); as anchor) {
                    <div class="text-[10px] text-stone-400 dark:text-stone-500 flex items-center gap-1">
                      <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
                      </svg>
                      <span>{{ anchor }}</span>
                    </div>
                  }

                  <!-- 备注输入 -->
                  <div class="mt-auto">
                    <input type="text"
                           [(ngModel)]="noteInput"
                           (keydown.enter)="submitNote(task.id)"
                           class="w-full text-xs py-1.5 px-2 rounded-lg border border-stone-200 dark:border-stone-600 bg-transparent text-stone-600 dark:text-stone-300 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:border-indigo-400 outline-none transition-colors"
                           placeholder="添加一条备注…"
                           aria-label="添加备注"/>
                  </div>

                  <!-- 操作区 -->
                  <div class="flex items-center gap-2">
                    <button (click)="startWork(task.id)"
                            class="flex-1 py-2 rounded-lg text-xs font-medium transition-colors"
                            [class.bg-indigo-500]="!isSpotlightActive()"
                            [class.text-white]="!isSpotlightActive()"
                            [class.hover:bg-indigo-600]="!isSpotlightActive()"
                            [class.bg-stone-300]="isSpotlightActive()"
                            [class.dark:bg-stone-600]="isSpotlightActive()"
                            [class.text-stone-500]="isSpotlightActive()"
                            [class.dark:text-stone-400]="isSpotlightActive()"
                            [class.cursor-not-allowed]="isSpotlightActive()"
                            [disabled]="isSpotlightActive()"
                            [title]="isSpotlightActive() ? '请先退出 Spotlight 模式' : ''"
                            style="min-height: 44px;"
                            aria-label="切换到此任务">
                      切换到此任务
                    </button>

                    <!-- 更多菜单 -->
                    <div class="relative">
                      <button (click)="toggleMoreMenu($event)"
                              class="p-2 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-400 transition-colors"
                              style="min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center;"
                              aria-label="更多操作">
                        <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01"/>
                        </svg>
                      </button>
                      @if (showMoreMenu()) {
                        <div class="absolute bottom-full right-0 mb-1 w-40 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg py-1 z-10">
                          <button (click)="togglePinned(task.id)"
                                  class="w-full text-left px-3 py-2 text-xs text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-700">
                            {{ task.parkingMeta?.pinned ? '取消固定' : '固定（不自动清理）' }}
                          </button>
                          <button (click)="showReminderPresets(task.id)"
                                  class="w-full text-left px-3 py-2 text-xs text-stone-600 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-700">
                            设置提醒…
                          </button>
                          @if (showReminderPresetsMenu()) {
                            <div class="px-2 py-1 space-y-0.5">
                              <button (click)="setReminderPreset(task.id, 'QUICK')"
                                      class="w-full text-left px-2 py-1.5 text-[11px] text-stone-500 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700 rounded">
                                5 分钟后
                              </button>
                              <button (click)="setReminderPreset(task.id, 'NORMAL')"
                                      class="w-full text-left px-2 py-1.5 text-[11px] text-stone-500 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700 rounded">
                                30 分钟后
                              </button>
                              <button (click)="setReminderPreset(task.id, 'TWO_HOURS_LATER')"
                                      class="w-full text-left px-2 py-1.5 text-[11px] text-stone-500 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700 rounded">
                                2 小时后
                              </button>
                            </div>
                          }
                          <div class="h-px bg-stone-100 dark:bg-stone-700 my-1"></div>
                          <button (click)="removeTask(task.id)"
                                  class="w-full text-left px-3 py-2 text-xs text-red-500 dark:text-red-400 hover:bg-stone-50 dark:hover:bg-stone-700">
                            移回任务列表
                          </button>
                        </div>
                      }
                    </div>
                  </div>
                } @else {
                  <!-- 空态 -->
                  <div class="flex-1 flex items-center justify-center text-xs text-stone-400 dark:text-stone-500">
                    点击左侧任务查看详情
                  </div>
                }
              </div>
              } <!-- /parkedCount > 0 @else -->
            </div>
          </div>
        }

        <!-- ─── 移动端：Bottom Sheet ─── -->
        @if (isMobile()) {
          <div class="dock-sheet fixed left-0 right-0 bottom-0 z-50 rounded-t-2xl overflow-hidden flex flex-col
                      border-t border-stone-200 dark:border-stone-700"
               data-testid="parking-dock-sheet"
               style="height: 60vh; max-height: 70vh; background-color: var(--theme-bg);
                      padding-bottom: env(safe-area-inset-bottom, 0px);
                      box-shadow: 0 -8px 32px rgba(0,0,0,0.12);"
               (touchstart)="onSheetTouchStart($event)"
               (touchmove)="onSheetTouchMove($event)"
               (touchend)="onSheetTouchEnd()">

            <!-- 拖拽把手 -->
            <div class="flex justify-center py-2 shrink-0">
              <div class="w-10 h-1 rounded-full bg-stone-300 dark:bg-stone-600"></div>
            </div>

            <!-- 顶部栏 -->
            <div class="flex items-center justify-between px-4 py-1 shrink-0">
              <span class="text-sm font-semibold text-stone-800 dark:text-stone-200">稍后处理</span>
              <button (click)="closeDock()" class="p-1.5 rounded-lg active:bg-stone-100 dark:active:bg-stone-700 text-stone-400">
                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <!-- 单栏列表 -->
            <div class="flex-1 overflow-y-auto px-3 py-1 flex flex-col gap-2" role="listbox">
              @if (parkedCount() === 0) {
                <!-- 移动端空态引导 -->
                <div class="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <svg class="h-10 w-10 text-stone-300 dark:text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
                    <polyline points="17 21 17 13 7 13 7 21" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <p class="text-sm text-stone-500 dark:text-stone-400 font-medium">暂无停泊任务</p>
                  <p class="text-xs text-stone-400 dark:text-stone-500 leading-relaxed">
                    在任务编辑器中点击「停泊」按钮，可将任务暂存到此处稍后处理。
                  </p>
                </div>
              }
              @for (task of sortedParkedTasks(); track task.id) {
                <div class="park-card flex items-center gap-2 px-3 py-3 rounded-xl
                            bg-stone-50 dark:bg-stone-800 border border-stone-100 dark:border-stone-700"
                     (click)="selectTask(task.id)">
                  <div class="park-card-bar self-stretch shrink-0"></div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1">
                      <span class="text-sm font-medium text-stone-700 dark:text-stone-200 truncate flex-1">
                        {{ task.title || '未命名任务' }}
                      </span>
                      @if (hasBadge(task.id)) {
                        <span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
                      }
                      @if (task.parkingMeta?.pinned) {
                        <svg class="h-3 w-3 text-stone-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 2a1 1 0 011 1v1.323l3.954 1.582 1.599-.8a1 1 0 01.894 1.79l-1.233.617 1.738 5.42a1 1 0 01-.285 1.05 3.001 3.001 0 01-4.462-.308l-.125.168a1 1 0 01-1.06.343L10 14.32V18a1 1 0 11-2 0v-3.68l-1.02.342a1 1 0 01-1.06-.343l-.124-.168a3.001 3.001 0 01-4.463.308 1 1 0 01-.285-1.05l1.738-5.42-1.233-.616a1 1 0 01.894-1.79l1.6.8L9 4.324V3a1 1 0 011-1z"/>
                        </svg>
                      }
                    </div>
                    <div class="text-[11px] text-stone-400 dark:text-stone-500 mt-0.5">
                      {{ getProjectName(task) }} · {{ formatDuration(task.parkingMeta?.parkedAt) }}
                    </div>
                    @if (hasUpcomingReminderForTask(task)) {
                      <span class="text-[10px] px-1 rounded bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 mt-0.5 inline-block">
                        {{ formatReminderCountdown(task) }}
                      </span>
                    }
                    @if (isStaleWarning(task)) {
                      <span class="stale-tag mt-1 inline-block">即将清理</span>
                      <button (click)="keepParked(task.id); $event.stopPropagation()"
                              class="text-[10px] mt-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 active:bg-amber-200 inline-block"
                              aria-label="保留此任务">
                        保留
                      </button>
                    }
                  </div>
                  <button (click)="startWork(task.id); $event.stopPropagation()"
                          class="px-3 py-2 text-xs font-medium rounded-lg"
                          [class.bg-indigo-500]="!isSpotlightActive()"
                          [class.text-white]="!isSpotlightActive()"
                          [class.active:bg-indigo-600]="!isSpotlightActive()"
                          [class.bg-stone-300]="isSpotlightActive()"
                          [class.dark:bg-stone-600]="isSpotlightActive()"
                          [class.text-stone-500]="isSpotlightActive()"
                          [class.dark:text-stone-400]="isSpotlightActive()"
                          [class.cursor-not-allowed]="isSpotlightActive()"
                          [disabled]="isSpotlightActive()"
                          [title]="isSpotlightActive() ? '请先退出 Spotlight 模式' : ''"
                          style="min-height: 44px;"
                          aria-label="切换到此任务">
                    切换
                  </button>
                </div>

                <!-- 移动端内联展开详情 -->
                @if (selectedTaskId() === task.id) {
                  <div class="px-3 py-2 bg-stone-50/50 dark:bg-stone-800/50 rounded-lg border border-stone-100 dark:border-stone-700">
                    <div class="text-xs text-stone-400 italic mb-1">稍后处理中</div>
                    <div class="text-xs text-stone-600 dark:text-stone-300 leading-relaxed max-h-24 overflow-y-auto whitespace-pre-wrap">
                      {{ getContentPreview(task) }}
                    </div>
                    <div class="flex items-center gap-2 mt-2">
                      <button (click)="togglePinned(task.id)"
                              class="text-[11px] px-2 py-1 rounded bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400 active:bg-stone-200"
                              style="min-height: 44px;">
                        {{ task.parkingMeta?.pinned ? '取消固定' : '固定' }}
                      </button>
                      <!-- 更多菜单（A6.2.4: 移动端通过"更多菜单 > 移回任务列表"操作） -->
                      <div class="relative">
                        <button (click)="toggleMobileMoreMenu($event)"
                                class="text-[11px] px-2 py-1 rounded bg-stone-100 dark:bg-stone-700 text-stone-500 dark:text-stone-400 active:bg-stone-200"
                                style="min-height: 44px;"
                                aria-label="更多操作">
                          更多 ▾
                        </button>
                        @if (showMobileMoreMenu()) {
                          <div class="absolute bottom-full right-0 mb-1 w-36 bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg py-1 z-10">
                            <button (click)="showReminderPresets(task.id)"
                                    class="w-full text-left px-3 py-2 text-xs text-stone-600 dark:text-stone-300 active:bg-stone-50 dark:active:bg-stone-700">
                              设置提醒…
                            </button>
                            @if (showReminderPresetsMenu()) {
                              <div class="px-2 py-1 space-y-0.5">
                                <button (click)="setReminderPreset(task.id, 'QUICK')"
                                        class="w-full text-left px-2 py-1.5 text-[11px] text-stone-500 dark:text-stone-400 active:bg-stone-50 dark:active:bg-stone-700 rounded">
                                  5 分钟后
                                </button>
                                <button (click)="setReminderPreset(task.id, 'NORMAL')"
                                        class="w-full text-left px-2 py-1.5 text-[11px] text-stone-500 dark:text-stone-400 active:bg-stone-50 dark:active:bg-stone-700 rounded">
                                  30 分钟后
                                </button>
                                <button (click)="setReminderPreset(task.id, 'TWO_HOURS_LATER')"
                                        class="w-full text-left px-2 py-1.5 text-[11px] text-stone-500 dark:text-stone-400 active:bg-stone-50 dark:active:bg-stone-700 rounded">
                                  2 小时后
                                </button>
                              </div>
                            }
                            <div class="h-px bg-stone-100 dark:bg-stone-700 my-1"></div>
                            <button (click)="removeTask(task.id)"
                                    class="w-full text-left px-3 py-2 text-xs text-red-500 dark:text-red-400 active:bg-stone-50 dark:active:bg-stone-700">
                              移回任务列表
                            </button>
                          </div>
                        }
                      </div>
                    </div>
                  </div>
                }
              }
            </div>
          </div>
        }
      }
  `,
})
export class ParkingDockComponent implements OnDestroy {
  private readonly elRef = inject(ElementRef);
  readonly uiState = inject(UiStateService);
  readonly parkingService = inject(ParkingService);
  private readonly reminderService = inject(SimpleReminderService);
  private readonly spotlightService = inject(SpotlightService);
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);

  /** 停泊坞展开状态——与 UiStateService 双向同步并持久化到 localStorage */
  readonly isOpen = this.uiState.isParkingDockOpen;

  /** Spotlight 模式激活状态——激活时禁止从停泊列表切换任务（A3.8） */
  readonly isSpotlightActive = computed(() => this.spotlightService.isActive());

  /** 当前选中任务 ID */
  readonly selectedTaskId = signal<string | null>(null);

  /** 更多菜单 */
  readonly showMoreMenu = signal(false);

  /** 提醒预设子菜单 */
  readonly showReminderPresetsMenu = signal(false);

  /** 面板关闭动画标记 */
  readonly isPanelClosing = signal(false);

  /** 移动端更多菜单 */
  readonly showMobileMoreMenu = signal(false);

  /** 备注输入 */
  noteInput = '';

  // ─── computed ───

  readonly isMobile = computed(() => this.uiState.isMobile());

  /** 触发条 left 百分比——居中于 Resizer 分隔线（A6.9.3） */
  readonly triggerLeftPercent = computed(() => {
    return this.uiState.isTextColumnCollapsed() ? 50 : this.uiState.textColumnRatio();
  });

  readonly parkedCount = computed(() => this.parkingService.parkedCount());

  readonly hasUpcomingReminder = computed(() => this.parkingService.hasUpcomingReminder());

  readonly isOverSoftLimit = computed(() => this.parkingService.isOverSoftLimit());

  private readonly isMacPlatform = computed(() => {
    if (typeof navigator === 'undefined') return false;
    return /(Mac|iPhone|iPad|iPod)/i.test(navigator.platform);
  });

  readonly quickSwitchShortcutLabel = computed(() =>
    this.isMacPlatform() ? 'Ctrl+Shift+P' : 'Alt+Shift+P'
  );

  readonly sortedParkedTasks = computed(() => {
    const tasks = this.taskStore.parkedTasks();
    const now = Date.now();

    return tasks
      .map((task, index) => {
        const parkedAtTs = task.parkingMeta?.parkedAt
          ? Date.parse(task.parkingMeta.parkedAt)
          : 0;
        const reminderAt = task.parkingMeta?.reminder?.reminderAt;
        const reminderTs = reminderAt ? Date.parse(reminderAt) : 0;
        const hasUpcomingReminder = reminderTs > now && reminderTs - now < 60 * 60 * 1000;
        return {
          task,
          index,
          parkedAtTs: Number.isNaN(parkedAtTs) ? 0 : parkedAtTs,
          hasUpcomingReminder,
        };
      })
      .sort((a, b) => {
        if (a.hasUpcomingReminder !== b.hasUpcomingReminder) {
          return a.hasUpcomingReminder ? -1 : 1;
        }
        if (a.parkedAtTs !== b.parkedAtTs) {
          return b.parkedAtTs - a.parkedAtTs;
        }
        return a.index - b.index;
      })
      .map(item => item.task);
  });

  readonly selectedTask = computed(() => {
    const id = this.selectedTaskId();
    if (!id) return null;
    return this.taskStore.getTask(id) ?? null;
  });

  /** 提醒标签文案 */
  readonly reminderLabel = computed(() => {
    if (!this.hasUpcomingReminder()) return '';
    return '1 个提醒即将到期';
  });

  /** 面板宽度——clamp(480, 40vw, min(720, 80vw)) */
  readonly panelWidth = computed(() => {
    if (typeof window === 'undefined') return 560;
    const vw = window.innerWidth;
    const desired = Math.max(480, vw * 0.4);
    const max = Math.min(PARKING_CONFIG.DOCK_EXPANDED_MAX_WIDTH, vw * 0.8);
    return Math.min(desired, max);
  });

  /** 面板高度——clamp(280, 45vh, min(480, 70vh)) */
  readonly panelHeight = computed(() => {
    if (typeof window === 'undefined') return 360;
    const vh = window.innerHeight;
    const desired = Math.max(280, vh * 0.45);
    const max = Math.min(480, vh * 0.7);
    return Math.min(desired, max);
  });

  /** 面板 left 定位——居中于 Resizer（视口坐标）
   * 宿主元素不再使用 transform，position:fixed 子元素的 left 直接相对于视口。
   */
  readonly panelLeft = computed(() => {
    if (typeof window === 'undefined') return 0;
    const vw = window.innerWidth;
    const ratio = this.uiState.isTextColumnCollapsed()
      ? 0
      : this.uiState.textColumnRatio();
    // 获取父容器（ProjectShell 主内容区）的位置，以计算 Resizer 的视口坐标
    const parentEl = this.elRef.nativeElement?.parentElement;
    const parentLeft = parentEl ? parentEl.getBoundingClientRect().left : 0;
    const parentWidth = parentEl ? parentEl.getBoundingClientRect().width : vw;
    // Resizer 的视口 x 坐标 = 父容器左偏移 + 父容器宽度 × 比例
    const resizerCenterVp = parentLeft + (parentWidth * ratio) / 100;
    const halfPanel = this.panelWidth() / 2;
    // 钳制面板左边缘，确保不超出视口
    return Math.max(8, Math.min(resizerCenterVp - halfPanel, vw - this.panelWidth() - 8));
  });

  // ─── 移动端拖拽收起 ───
  private sheetTouchStartY = 0;
  private sheetTouchDeltaY = 0;

  // ──── Keyboard shortcut ────
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    const isQuickSwitch = key === 'p'
      && event.shiftKey
      && (
        (this.isMacPlatform() && event.ctrlKey && !event.altKey && !event.metaKey)
        || (!this.isMacPlatform() && event.altKey && !event.ctrlKey && !event.metaKey)
      );

    // 快速回切（Win/Linux: Alt+Shift+P; macOS: Ctrl+Shift+P）
    if (isQuickSwitch) {
      event.preventDefault();
      if (this.isSpotlightActive()) return;
      if (this.parkedCount() > 0) {
        this.parkingService.quickSwitch();
      }
      return;
    }
    // Escape 收起
    if (event.key === 'Escape' && this.isOpen()) {
      this.closeDock();
      return;
    }
    // ArrowUp / ArrowDown 键盘导航停泊列表（A6.7 ARIA listbox 语义）
    if (this.isOpen() && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const tasks = this.sortedParkedTasks();
      if (tasks.length === 0) return;
      const currentId = this.selectedTaskId();
      const currentIdx = currentId ? tasks.findIndex(t => t.id === currentId) : -1;
      let nextIdx: number;
      if (event.key === 'ArrowDown') {
        nextIdx = currentIdx < tasks.length - 1 ? currentIdx + 1 : 0;
      } else {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : tasks.length - 1;
      }
      this.selectTask(tasks[nextIdx].id);
    }
  }

  ngOnDestroy(): void {
    // 清理
  }

  // ─── 公开方法 ───

  toggleDock(): void {
    this.uiState.toggleParkingDock();
    if (!this.isOpen()) {
      this.selectedTaskId.set(null);
      this.showMoreMenu.set(false);
    }
  }

  closeDock(): void {
    if (this.isMobile()) {
      // 移动端直接关闭（sheet 自身有滑出动画）
      this.uiState.setParkingDockOpen(false);
      this.selectedTaskId.set(null);
      this.showMoreMenu.set(false);
      return;
    }
    // 桌面端：播放关闭动画后再移除面板
    this.isPanelClosing.set(true);
    setTimeout(() => {
      this.uiState.setParkingDockOpen(false);
      this.selectedTaskId.set(null);
      this.showMoreMenu.set(false);
      this.isPanelClosing.set(false);
    }, 200);
  }

  selectTask(taskId: string): void {
    this.selectedTaskId.set(taskId);
    this.showMoreMenu.set(false);
    this.showMobileMoreMenu.set(false);
    // 刷新 lastVisitedAt（A6.1b.5）
    this.parkingService.previewTask(taskId);
  }

  startWork(taskId: string): void {
    // A3.8: Spotlight 激活时禁止切换
    if (this.isSpotlightActive()) return;
    this.parkingService.startWork(taskId);
    this.closeDock();
  }

  startWorkOnSelected(): void {
    const id = this.selectedTaskId();
    if (id) this.startWork(id);
  }

  removeTask(taskId: string, event?: Event): void {
    event?.stopPropagation();
    this.parkingService.removeParkedTask(taskId);
    if (this.selectedTaskId() === taskId) {
      this.selectedTaskId.set(null);
    }
  }

  togglePinned(taskId: string): void {
    this.parkingService.togglePinned(taskId);
    this.showMoreMenu.set(false);
  }

  /** 保留任务（重置 stale 计时） */
  keepParked(taskId: string): void {
    this.parkingService.keepParked(taskId);
  }

  /** 展开提醒预设子菜单 */
  showReminderPresets(_taskId: string): void {
    this.showReminderPresetsMenu.update(v => !v);
  }

  /** 按预设设置提醒 */
  setReminderPreset(taskId: string, preset: 'QUICK' | 'NORMAL' | 'TWO_HOURS_LATER'): void {
    const delay = PARKING_CONFIG.SNOOZE_PRESETS[preset];
    const reminderAt = new Date(Date.now() + delay).toISOString();
    this.reminderService.setReminder(taskId, reminderAt);
    this.showReminderPresetsMenu.set(false);
    this.showMoreMenu.set(false);
  }

  /** 格式化提醒倒计时 */
  formatReminderCountdown(task: Task): string {
    if (!task.parkingMeta?.reminder) return '';
    const remaining = new Date(task.parkingMeta.reminder.reminderAt).getTime() - Date.now();
    if (remaining <= 0) return '即将提醒';
    const minutes = Math.ceil(remaining / 60_000);
    if (minutes < 60) return `${minutes}分钟后提醒`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}小时${mins}分后` : `${hours}小时后提醒`;
  }

  toggleMoreMenu(event: Event): void {
    event.stopPropagation();
    this.showMoreMenu.update(v => !v);
  }

  /** 移动端更多菜单切换（A6.2.4: "更多菜单 > 移回任务列表" 模式） */
  toggleMobileMoreMenu(event: Event): void {
    event.stopPropagation();
    this.showMobileMoreMenu.update(v => !v);
  }

  submitNote(taskId: string): void {
    if (!this.noteInput.trim()) return;
    this.parkingService.addNote(taskId, this.noteInput.trim());
    this.noteInput = '';
  }

  onTitleChange(taskId: string, newTitle: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;
    const projectId = this.findProjectId(taskId);
    if (!projectId) return;
    this.taskStore.setTask({ ...task, title: newTitle, updatedAt: new Date().toISOString() }, projectId);
  }

  // ─── 移动端 Bottom Sheet 手势 ───

  onSheetTouchStart(event: TouchEvent): void {
    this.sheetTouchStartY = event.touches[0].clientY;
    this.sheetTouchDeltaY = 0;
  }

  onSheetTouchMove(event: TouchEvent): void {
    this.sheetTouchDeltaY = event.touches[0].clientY - this.sheetTouchStartY;
  }

  onSheetTouchEnd(): void {
    // 下拉超过配置阈值收起
    if (this.sheetTouchDeltaY > PARKING_CONFIG.DOCK_MOBILE_DISMISS_THRESHOLD) {
      this.closeDock();
    }
  }

  // ─── 辅助方法 ───

  getProjectName(task: Task): string {
    const projectId = this.findProjectId(task.id);
    if (!projectId) return '';
    const project = this.projectStore.getProject(projectId);
    return project?.name ?? '';
  }

  formatDuration(parkedAt: string | null | undefined): string {
    if (!parkedAt) return '';
    const diff = Date.now() - new Date(parkedAt).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  }

  getContentPreview(task: Task): string {
    if (!task.content) return '无内容';
    return task.content.substring(0, 300);
  }

  getAnchorDisplay(task: Task): string | null {
    const anchor = task.parkingMeta?.contextSnapshot?.structuralAnchor;
    if (!anchor) return null;
    // A4: 当 type === 'fallback' 且 label 与标题重复时不显示
    if (anchor.type === 'fallback' && anchor.label === task.title) return null;
    return anchor.label;
  }

  isStaleWarning(task: Task): boolean {
    if (!task.parkingMeta?.lastVisitedAt) return false;
    if (task.parkingMeta.pinned) return false;
    const elapsed = Date.now() - new Date(task.parkingMeta.lastVisitedAt).getTime();
    return elapsed >= PARKING_CONFIG.PARKED_TASK_STALE_WARNING;
  }

  hasUpcomingReminderForTask(task: Task): boolean {
    if (!task.parkingMeta?.reminder) return false;
    const remaining = new Date(task.parkingMeta.reminder.reminderAt).getTime() - Date.now();
    return remaining > 0 && remaining < 60 * 60 * 1000; // <1h
  }

  hasBadge(taskId: string): boolean {
    return this.parkingService.badgedTaskIds().has(taskId);
  }

  private findProjectId(taskId: string): string | null {
    return this.taskStore.getTaskProjectId(taskId)
      ?? this.projectStore.activeProjectId()
      ?? null;
  }
}
