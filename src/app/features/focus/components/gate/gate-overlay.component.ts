/**
 * 大门遮罩层组件
 *
 * 全屏遮罩层，阻止用户访问应用其他部分
 * 直到所有遗留条目处理完毕
 * 底部显示地质层（已完成任务堆叠预览）
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  HostListener,
  OnDestroy,
  computed,
  effect,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';
import { StrataService } from '../../../../../services/strata.service';
import { GateCardComponent } from './gate-card.component';
import { GateActionsComponent } from './gate-actions.component';

type GateVisualTheme = 'stone' | 'paper';

const GATE_VISUAL_THEME_KEY = 'focus_gate_visual_theme';

@Component({
  selector: 'app-gate-overlay',
  standalone: true,
  imports: [CommonModule, GateCardComponent, GateActionsComponent],
  template: `
    <!-- 审查中状态 -->
    @if (gateService.isActive()) {
      <div
        class="gate-overlay fixed inset-0 z-[9999] flex flex-col items-center justify-center overflow-hidden px-4 pb-5 pt-8 sm:px-8 sm:pb-8 sm:pt-10"
        [class.gate-theme--stone]="visualTheme() === 'stone'"
        [class.gate-theme--paper]="visualTheme() === 'paper'"
        data-testid="gate-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        aria-describedby="gate-description"
        tabindex="-1">

        <!-- 背景 -->
        <div class="gate-backdrop absolute inset-0" aria-hidden="true">
          <div class="gate-backdrop__base absolute inset-0"></div>
          <div class="gate-backdrop__top-halo absolute inset-0"></div>
          <div class="gate-backdrop__bottom-halo absolute inset-0"></div>
          <div class="gate-backdrop__grain absolute inset-0"></div>
        </div>

        <!-- 结构网格与光柱 -->
        <div class="gate-grid absolute inset-0 pointer-events-none" aria-hidden="true"></div>
        <div class="gate-beam gate-beam--left absolute inset-y-0 left-[8%] pointer-events-none" aria-hidden="true"></div>
        <div class="gate-beam gate-beam--right absolute inset-y-0 right-[8%] pointer-events-none" aria-hidden="true"></div>

        <!-- 地质层预览 -->
        <div class="gate-strata absolute bottom-0 left-0 right-0 pointer-events-none flex flex-col items-center justify-end overflow-hidden">
          @for (layer of strataLayers(); track layer.date; let i = $index) {
            @if (i < 6) {
              <div
                class="gate-strata__layer absolute left-1/2 w-full max-w-3xl transition-all duration-500 ease-out"
                [style.bottom.px]="i * 10 - 24"
                [style.transform]="'translate3d(-50%, 0, 0) scale(' + (1 - i * 0.028) + ') translateY(' + (i * 2) + 'px)'"
                [style.opacity]="0.95 - i * 0.12"
                [style.z-index]="12 - i">

                <div class="px-5 sm:px-10">
                  <div class="gate-strata__slab relative overflow-hidden rounded-2xl border border-white/10 px-4 py-3 backdrop-blur-xl">
                    <div class="gate-strata__shine absolute inset-x-0 top-0 h-px"></div>
                    <div class="relative flex items-center justify-between gap-3 sm:gap-4">
                      <div class="min-w-0 flex items-center gap-2.5">
                        <span class="gate-strata__dot"></span>
                        <span class="gate-strata__date font-mono">{{ layer.date }}</span>
                      </div>

                      <div class="flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-hidden sm:gap-2">
                        @for (item of layer.items.slice(0, 3); track item.id) {
                          <span class="gate-strata__item truncate">
                            {{ item.title }}
                          </span>
                        }
                        @if (layer.items.length > 3) {
                          <span class="gate-strata__more font-mono">+{{ layer.items.length - 3 }}</span>
                        }
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            }
          }
        </div>

        <!-- 主内容 -->
        <section class="gate-shell relative z-10 w-full max-w-2xl animate-gate-enter will-change-transform">
          <header class="gate-shell__header rounded-2xl px-5 py-4 backdrop-blur-xl sm:px-6">
            <div class="gate-shell__top-row">
              <div class="gate-shell__eyebrow font-mono uppercase tracking-[0.18em]">Focus Gate</div>
              <div class="gate-theme-switch" role="group" aria-label="大门主题">
                <button
                  type="button"
                  class="gate-theme-switch__btn"
                  [class.gate-theme-switch__btn--active]="visualTheme() === 'stone'"
                  (click)="setTheme('stone')">
                  岩层
                </button>
                <button
                  type="button"
                  class="gate-theme-switch__btn"
                  [class.gate-theme-switch__btn--active]="visualTheme() === 'paper'"
                  (click)="setTheme('paper')">
                  纸感
                </button>
              </div>
            </div>
            <h2 id="gate-title" class="gate-shell__title">先清遗留，再开新局</h2>
            <p class="gate-shell__subtitle">按顺序处理昨日条目，完成后自动进入今日专注。</p>
          </header>

          <div class="mt-4 sm:mt-5">
            <app-gate-card class="block w-full" />
          </div>
          <div class="mt-4">
            <app-gate-actions class="block w-full" />
          </div>
        </section>

        <!-- 快捷键提示 -->
        <div class="gate-shortcuts absolute bottom-4 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-black/40 px-4 py-2 backdrop-blur-xl md:flex">
          <span class="gate-shortcuts__item"><kbd class="keyboard-hint">1</kbd> 已读</span>
          <span class="gate-shortcuts__divider"></span>
          <span class="gate-shortcuts__item"><kbd class="keyboard-hint">2</kbd> 完成</span>
        </div>
      </div>
    }

    <!-- 完成状态 - 显示成功提示后消失 -->
    @if (showCompletionMessage()) {
      <div
        class="gate-completion fixed inset-0 z-[9999] flex items-center justify-center p-4"
        role="status"
        aria-live="polite">

        <div class="absolute inset-0 bg-black/70 backdrop-blur-md animate-fade-out"></div>

        <div class="gate-completion__card relative z-10 text-center animate-success-bounce will-change-transform">
          <div class="gate-completion__icon mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full">
            <span class="text-4xl">✓</span>
          </div>
          <p class="gate-completion__title text-xl font-bold tracking-tight">全部处理完毕</p>
          <p class="gate-completion__subtitle mt-1 text-sm">开始新的一天</p>
        </div>
      </div>
    }
  `,
  styles: [`
    .gate-overlay {
      --gate-ink: #e9ece8;
      --gate-muted: rgba(233, 236, 232, 0.66);
      --gate-shell-bg: linear-gradient(155deg, rgba(23, 26, 24, 0.84) 0%, rgba(34, 29, 24, 0.84) 100%);
      --gate-shell-border: rgba(255, 255, 255, 0.14);
      --gate-shell-shadow:
        0 20px 60px rgba(0, 0, 0, 0.42),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      --gate-eyebrow: rgba(255, 255, 255, 0.48);
      --gate-grid-line: rgba(255, 255, 255, 0.035);
      --gate-beam: rgba(255, 255, 255, 0.22);
      --gate-strata-slab: linear-gradient(155deg, rgba(17, 18, 20, 0.92) 0%, rgba(25, 22, 20, 0.88) 100%);
      --gate-strata-item-bg: rgba(6, 7, 8, 0.5);
      --gate-strata-item-border: rgba(255, 255, 255, 0.09);
      --gate-strata-item-text: rgba(196, 201, 194, 0.76);
      --gate-shortcuts-bg: rgba(0, 0, 0, 0.4);
      --gate-shortcuts-text: rgba(241, 243, 238, 0.62);
      --gate-kbd-bg: rgba(255, 255, 255, 0.09);
      --gate-kbd-border: rgba(255, 255, 255, 0.15);
      --gate-kbd-text: rgba(250, 250, 249, 0.88);
      --gate-completion-bg: linear-gradient(160deg, rgba(21, 24, 22, 0.9) 0%, rgba(16, 18, 17, 0.88) 100%);
      --gate-completion-border: rgba(69, 39, 39, 0.14);
      --gate-completion-icon: #57d190;
      --gate-completion-icon-bg: radial-gradient(circle at 35% 30%, rgba(116, 228, 161, 0.26), rgba(87, 209, 144, 0.11));
      --gate-completion-icon-border: rgba(87, 209, 144, 0.42);
      --gate-completion-title: #f8faf8;
      --gate-completion-subtitle: rgba(230, 234, 229, 0.66);
      animation: opacity-in 0.28s ease-out;
      font-family: "Space Grotesk", "Noto Sans SC", "PingFang SC", sans-serif;
    }

    .gate-overlay.gate-theme--stone {
      --gate-backdrop-base:
        radial-gradient(120% 90% at 50% 120%, rgba(214, 141, 72, 0.18) 0%, rgba(13, 14, 16, 0) 58%),
        linear-gradient(165deg, #0c0d10 0%, #11151a 42%, #17120f 100%);
      --gate-backdrop-top: radial-gradient(70% 50% at 50% 0%, rgba(255, 232, 203, 0.14) 0%, rgba(255, 232, 203, 0) 70%);
      --gate-backdrop-bottom: radial-gradient(90% 52% at 50% 100%, rgba(240, 171, 85, 0.16) 0%, rgba(240, 171, 85, 0) 72%);
      --gate-grain-opacity: 0.065;
    }

    .gate-overlay.gate-theme--paper {
      --gate-ink: #2d2b25;
      --gate-muted: rgba(69, 62, 49, 0.7);
      --gate-shell-bg: linear-gradient(165deg, rgba(245, 239, 223, 0.95) 0%, rgba(238, 228, 208, 0.92) 100%);
      --gate-shell-border: rgba(158, 125, 78, 0.28);
      --gate-shell-shadow:
        0 24px 56px rgba(88, 72, 43, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.82);
      --gate-eyebrow: rgba(98, 86, 62, 0.66);
      --gate-grid-line: rgba(94, 74, 43, 0.08);
      --gate-beam: rgba(133, 98, 48, 0.24);
      --gate-strata-slab: linear-gradient(160deg, rgba(233, 222, 198, 0.84) 0%, rgba(226, 210, 182, 0.82) 100%);
      --gate-strata-item-bg: rgba(255, 252, 246, 0.8);
      --gate-strata-item-border: rgba(126, 97, 59, 0.22);
      --gate-strata-item-text: rgba(84, 66, 40, 0.84);
      --gate-shortcuts-bg: rgba(248, 243, 229, 0.9);
      --gate-shortcuts-text: rgba(84, 67, 41, 0.84);
      --gate-kbd-bg: rgba(255, 255, 255, 0.82);
      --gate-kbd-border: rgba(146, 113, 70, 0.28);
      --gate-kbd-text: rgba(76, 57, 35, 0.86);
      --gate-completion-bg: linear-gradient(165deg, rgba(248, 243, 230, 0.96) 0%, rgba(240, 230, 207, 0.94) 100%);
      --gate-completion-border: rgba(158, 125, 78, 0.22);
      --gate-completion-icon: #2f8b5d;
      --gate-completion-icon-bg: radial-gradient(circle at 35% 30%, rgba(100, 187, 138, 0.32), rgba(58, 143, 95, 0.12));
      --gate-completion-icon-border: rgba(47, 139, 93, 0.36);
      --gate-completion-title: rgba(48, 39, 28, 0.92);
      --gate-completion-subtitle: rgba(85, 70, 47, 0.72);
      --gate-backdrop-base:
        radial-gradient(120% 90% at 50% 120%, rgba(231, 185, 114, 0.28) 0%, rgba(253, 248, 236, 0) 58%),
        linear-gradient(168deg, #efe8d6 0%, #e9dec7 38%, #e6d5b3 100%);
      --gate-backdrop-top: radial-gradient(70% 50% at 50% 0%, rgba(255, 255, 255, 0.55) 0%, rgba(255, 255, 255, 0) 75%);
      --gate-backdrop-bottom: radial-gradient(90% 52% at 50% 100%, rgba(173, 132, 77, 0.26) 0%, rgba(173, 132, 77, 0) 72%);
      --gate-grain-opacity: 0.12;
    }

    .gate-backdrop__base {
      background: var(--gate-backdrop-base);
    }

    .gate-backdrop__top-halo {
      background: var(--gate-backdrop-top);
      filter: blur(2px);
    }

    .gate-backdrop__bottom-halo {
      background: var(--gate-backdrop-bottom);
      animation: gate-halo-breathe 6s ease-in-out infinite alternate;
    }

    .gate-backdrop__grain {
      opacity: var(--gate-grain-opacity);
      background-image:
        radial-gradient(circle at 20% 25%, #fff 0.7px, transparent 1px),
        radial-gradient(circle at 75% 70%, #fff 0.7px, transparent 1px),
        radial-gradient(circle at 55% 48%, #fff 0.6px, transparent 1px);
      background-size: 140px 140px, 180px 180px, 120px 120px;
      mix-blend-mode: soft-light;
    }

    .gate-grid {
      background-image:
        linear-gradient(to right, var(--gate-grid-line) 1px, transparent 1px),
        linear-gradient(to bottom, var(--gate-grid-line) 1px, transparent 1px);
      background-size: 28px 28px;
      mask-image: radial-gradient(ellipse 62% 55% at 50% 10%, #000 68%, transparent 100%);
      opacity: 0.55;
    }

    .gate-beam {
      width: 1px;
      background: linear-gradient(to bottom, transparent, var(--gate-beam), transparent);
      opacity: 0.45;
      filter: blur(0.2px);
    }

    .gate-beam--left {
      animation: gate-beam-shift 5.6s ease-in-out infinite alternate;
    }

    .gate-beam--right {
      animation: gate-beam-shift 5.6s ease-in-out infinite alternate-reverse;
    }

    .gate-shell {
      position: relative;
    }

    .gate-shell__header {
      border: 1px solid var(--gate-shell-border);
      background: var(--gate-shell-bg);
      box-shadow: var(--gate-shell-shadow);
    }

    .gate-shell__top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .gate-shell__eyebrow {
      color: var(--gate-eyebrow);
      font-size: 11px;
      line-height: 1;
    }

    .gate-theme-switch {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: 9999px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(0, 0, 0, 0.18);
      padding: 3px;
      backdrop-filter: blur(10px);
    }

    .gate-overlay.gate-theme--paper .gate-theme-switch {
      border-color: rgba(139, 108, 67, 0.3);
      background: rgba(255, 255, 255, 0.56);
    }

    .gate-theme-switch__btn {
      border: 0;
      border-radius: 9999px;
      background: transparent;
      color: rgba(239, 242, 237, 0.7);
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      padding: 6px 10px;
      transition: all 0.2s ease;
    }

    .gate-overlay.gate-theme--paper .gate-theme-switch__btn {
      color: rgba(90, 71, 43, 0.76);
    }

    .gate-theme-switch__btn:hover {
      color: rgba(255, 255, 255, 0.96);
    }

    .gate-overlay.gate-theme--paper .gate-theme-switch__btn:hover {
      color: rgba(67, 49, 29, 0.95);
    }

    .gate-theme-switch__btn--active {
      background: rgba(255, 255, 255, 0.16);
      color: rgba(255, 255, 255, 0.98);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.24);
    }

    .gate-overlay.gate-theme--paper .gate-theme-switch__btn--active {
      background: rgba(255, 255, 255, 0.78);
      color: rgba(58, 41, 21, 0.95);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
    }

    .gate-shell__title {
      margin-top: 10px;
      color: var(--gate-ink);
      font-size: clamp(1.32rem, 1rem + 1.15vw, 2rem);
      line-height: 1.15;
      letter-spacing: -0.015em;
      font-weight: 650;
    }

    .gate-shell__subtitle {
      margin-top: 8px;
      color: var(--gate-muted);
      font-size: 0.88rem;
      line-height: 1.5;
    }

    .gate-strata {
      height: 58%;
      padding-bottom: clamp(24px, 6vh, 68px);
    }

    .gate-strata__slab {
      background: var(--gate-strata-slab);
      box-shadow:
        0 -2px 16px rgba(0, 0, 0, 0.28),
        inset 0 1px 0 rgba(255, 255, 255, 0.11);
    }

    .gate-strata__shine {
      background: linear-gradient(to right, transparent, rgba(255, 255, 255, 0.26), transparent);
    }

    .gate-strata__dot {
      width: 6px;
      height: 6px;
      border-radius: 9999px;
      background: rgba(230, 233, 227, 0.52);
      box-shadow: 0 0 10px rgba(230, 233, 227, 0.28);
      flex: 0 0 auto;
    }

    .gate-strata__date {
      color: rgba(220, 224, 218, 0.64);
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .gate-strata__item {
      border: 1px solid var(--gate-strata-item-border);
      background: var(--gate-strata-item-bg);
      border-radius: 9999px;
      color: var(--gate-strata-item-text);
      font-size: 10px;
      padding: 2px 9px;
      max-width: min(26vw, 170px);
      line-height: 1.2;
      flex: 0 1 auto;
    }

    .gate-strata__more {
      color: rgba(196, 201, 194, 0.52);
      font-size: 10px;
      letter-spacing: 0.08em;
      flex: 0 0 auto;
    }

    .gate-shortcuts {
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
      background: var(--gate-shortcuts-bg);
      pointer-events: none;
    }

    .gate-shortcuts__item {
      color: var(--gate-shortcuts-text);
      font-size: 11px;
      line-height: 1;
      font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .gate-shortcuts__divider {
      width: 1px;
      height: 14px;
      background: rgba(255, 255, 255, 0.16);
    }

    .keyboard-hint {
      display: inline-flex;
      min-width: 18px;
      justify-content: center;
      border-radius: 6px;
      border: 1px solid var(--gate-kbd-border);
      padding: 2px 6px;
      background: var(--gate-kbd-bg);
      color: var(--gate-kbd-text);
      font-size: 10px;
      line-height: 1;
      box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.35);
    }

    @keyframes opacity-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes gate-halo-breathe {
      from { transform: translateY(4px) scale(1); opacity: 0.78; }
      to { transform: translateY(0) scale(1.04); opacity: 1; }
    }

    @keyframes gate-beam-shift {
      from { opacity: 0.22; transform: scaleY(0.82); }
      to { opacity: 0.5; transform: scaleY(1); }
    }

    @keyframes gate-shell-reveal {
      from {
        transform: translateY(14px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    /* 完成状态 */
    .gate-completion {
      animation: completion-enter 0.3s ease-out;
      font-family: "Space Grotesk", "Noto Sans SC", "PingFang SC", sans-serif;
    }

    .gate-completion__card {
      min-width: min(92vw, 420px);
      border-radius: 28px;
      border: 1px solid var(--gate-completion-border);
      background: var(--gate-completion-bg);
      padding: 28px 24px;
      box-shadow:
        0 20px 44px rgba(0, 0, 0, 0.35),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }

    .gate-completion__icon {
      color: var(--gate-completion-icon);
      background: var(--gate-completion-icon-bg);
      border: 1px solid var(--gate-completion-icon-border);
      box-shadow: 0 10px 25px rgba(58, 141, 95, 0.32);
    }

    .gate-completion__title {
      color: var(--gate-completion-title);
    }

    .gate-completion__subtitle {
      color: var(--gate-completion-subtitle);
    }

    .animate-fade-out {
      animation: fade-out 1.5s ease-out 0.5s forwards;
    }

    @keyframes fade-out {
      0% { opacity: 1; }
      100% { opacity: 0; }
    }

    .animate-success-bounce {
      animation: success-bounce 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes success-bounce {
      0% {
        opacity: 0;
        transform: scale(0.8);
      }
      100% {
        opacity: 1;
        transform: scale(1);
      }
    }

    @keyframes completion-enter {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .animate-gate-enter {
      animation: gate-shell-reveal 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    @media (max-width: 640px) {
      .gate-strata {
        height: 50%;
        padding-bottom: 18px;
      }

      .gate-strata__item {
        max-width: 26vw;
      }

      .gate-shell__subtitle {
        font-size: 0.82rem;
      }

      .gate-theme-switch__btn {
        padding: 5px 9px;
        font-size: 10px;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateOverlayComponent implements OnDestroy {
  gateService = inject(GateService);
  private strataService = inject(StrataService);

  // 获取地质层数据
  readonly strataLayers = computed(() => this.strataService.layers());
  readonly visualTheme = signal<GateVisualTheme>(this.readTheme());

  constructor() {
    // 响应式追踪 gate 激活状态，动态管理 body 滚动锁定
    effect(() => {
      if (this.gateService.isActive()) {
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = '';
      }
    });
  }

  setTheme(theme: GateVisualTheme): void {
    this.visualTheme.set(theme);

    try {
      localStorage.setItem(GATE_VISUAL_THEME_KEY, theme);
    } catch {
      // ignore localStorage failures
    }
  }

  private readTheme(): GateVisualTheme {
    try {
      const stored = localStorage.getItem(GATE_VISUAL_THEME_KEY);
      return stored === 'paper' ? 'paper' : 'stone';
    } catch {
      return 'stone';
    }
  }

  /**
   * 键盘快捷键
   * 1: 已读, 2: 完成, 3: 稍后
   */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (!this.gateService.isActive()) return;

    // 忽略带修饰键的情况
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // 忽略用户在输入框中的按键
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    switch (event.key) {
      case '1':
        event.preventDefault();
        this.gateService.markAsRead();
        break;
      case '2':
        event.preventDefault();
        this.gateService.markAsCompleted();
        break;
      case '3':
        event.preventDefault();
        if (this.gateService.canSnooze()) {
          this.gateService.snooze();
        }
        break;
    }
  }

  // 是否显示完成提示
  readonly showCompletionMessage = this.gateService.showCompletionMessage;

  ngOnDestroy(): void {
    document.body.style.overflow = '';
  }
}
