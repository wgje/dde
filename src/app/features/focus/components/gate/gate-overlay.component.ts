/**
 * 大门遮罩层组件（深色简洁卡片）
 *
 * 用深色全屏遮罩承载 Gate：
 * - 顶部标题 + 碎石带计数
 * - 中央卡片内容（由 GateCardComponent 渲染）
 * - 底部地层预览
 */

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';
import { StrataService } from '../../../../../services/strata.service';
import { GateCardComponent } from './gate-card.component';
import { GateActionsComponent } from './gate-actions.component';

@Component({
  selector: 'app-gate-overlay',
  standalone: true,
  imports: [CommonModule, GateCardComponent, GateActionsComponent],
  template: `
    @if (gateService.isActive()) {
      <div
        class="gate-overlay"
        [class.shake-y]="shakePulse()"
        data-testid="gate-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        aria-describedby="gate-description"
        tabindex="-1">

        <header class="gate-header">
          <h2 id="gate-title">沉积之门</h2>
          <p id="gate-description">上推已读，下拉落地。把昨日重量变成今日地基。</p>

          @if (progress().total > 0) {
            <div class="rubble-track" aria-label="剩余待处理计数">
              @for (chip of rubbleChips(); track chip.index) {
                <span class="rubble-chip" [class.cleared]="chip.cleared"></span>
              }
            </div>
          }
        </header>

        <main class="gate-main">
          <app-gate-card />
        </main>

        <footer class="gate-footer">
          <app-gate-actions />
        </footer>

        @if (strataLayers().length > 0) {
          <aside class="strata-preview" aria-hidden="true">
            @for (layer of strataLayers(); track layer.date; let i = $index) {
              @if (i < 5) {
                <div
                  class="strata-row"
                  [style.--layer-index]="i"
                  [style.--layer-opacity]="0.7 - i * 0.12">
                  <span>{{ layer.date }}</span>
                </div>
              }
            }
          </aside>
        }
      </div>
    }

    @if (showCompletionMessage()) {
      <div class="gate-completion" role="status" aria-live="polite">
        <div class="completion-card">
          <div class="completion-mark">✓</div>
          <h3>沉积完成</h3>
          <p>门已开启，开始今天。</p>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
    }

    .gate-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.2rem;
      padding: clamp(1rem, 2vw, 1.8rem) clamp(0.85rem, 2vw, 2rem);
      background: rgba(9, 9, 11, 0.96);
      overflow: hidden;
      transform: translateY(0);
    }

    .gate-header,
    .gate-main,
    .gate-footer {
      position: relative;
      z-index: 1;
      width: min(980px, 100%);
    }

    .gate-header {
      text-align: center;
      color: rgba(255, 255, 255, 0.9);
      margin-bottom: 0.2rem;
    }

    .gate-header h2 {
      margin: 0;
      font-size: clamp(1.35rem, 1.2rem + 0.75vw, 1.9rem);
      font-weight: 700;
      letter-spacing: 0.08em;
    }

    .gate-header p {
      margin: 0.35rem auto 0;
      max-width: 40rem;
      font-size: 0.86rem;
      color: rgba(255, 255, 255, 0.5);
      line-height: 1.45;
    }

    .rubble-track {
      margin: 0.9rem auto 0;
      max-width: 480px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10px, 1fr));
      gap: 0.35rem;
      align-items: center;
    }

    .rubble-chip {
      height: 6px;
      border-radius: 9999px;
      background: rgba(255, 255, 255, 0.35);
      transition: opacity 220ms ease, transform 220ms ease;
    }

    .rubble-chip.cleared {
      opacity: 0.08;
      transform: translateY(4px) scale(0.88);
    }

    .gate-main {
      min-height: 45vh;
    }

    .gate-footer {
      margin-top: 0.35rem;
      display: flex;
      justify-content: center;
    }

    .strata-preview {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: min(24vh, 180px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      pointer-events: none;
      gap: 0.2rem;
      padding-bottom: 0.65rem;
      z-index: 0;
    }

    .strata-row {
      width: min(640px, calc(100vw - 2rem));
      height: 22px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px 8px 0 0;
      background: rgba(255, 255, 255, 0.04);
      transform: translateY(calc(var(--layer-index) * 5px)) scaleX(calc(1 - (var(--layer-index) * 0.04)));
      opacity: var(--layer-opacity);
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.4);
      font-size: 0.68rem;
      letter-spacing: 0.03em;
    }

    .gate-completion {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(8px);
    }

    .completion-card {
      width: min(340px, calc(100vw - 2rem));
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(24, 24, 27, 0.95);
      padding: 1.5rem 1.25rem;
      text-align: center;
      color: rgba(255, 255, 255, 0.92);
      box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.7);
      animation: completion-pop 280ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    .completion-mark {
      margin: 0 auto 0.7rem;
      width: 46px;
      height: 46px;
      border-radius: 9999px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.35rem;
      background: rgba(34, 197, 94, 0.85);
      color: #fff;
    }

    .completion-card h3 {
      margin: 0;
      font-size: 1.15rem;
      letter-spacing: 0.04em;
    }

    .completion-card p {
      margin: 0.45rem 0 0;
      color: rgba(255, 255, 255, 0.55);
      font-size: 0.84rem;
    }

    @keyframes completion-pop {
      from {
        opacity: 0;
        transform: translateY(16px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .shake-y {
      animation: gate-shake-y 210ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes gate-shake-y {
      0% { transform: translateY(0); }
      20% { transform: translateY(-7px); }
      42% { transform: translateY(4px); }
      68% { transform: translateY(-2px); }
      100% { transform: translateY(0); }
    }

    @media (max-width: 640px) {
      .gate-overlay {
        justify-content: flex-start;
        padding-top: 1.4rem;
      }

      .gate-main {
        min-height: 52vh;
      }

      .strata-row {
        height: 18px;
        font-size: 0.62rem;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .gate-overlay,
      .shake-y,
      .completion-card,
      .rubble-chip {
        animation: none !important;
        transition: none !important;
        transform: none !important;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GateOverlayComponent implements OnDestroy {
  readonly gateService = inject(GateService);
  private readonly strataService = inject(StrataService);

  /** 大门关闭事件 */
  readonly closed = output<void>();

  /** 地层预览 */
  readonly strataLayers = computed(() => this.strataService.layers());
  readonly progress = this.gateService.progress;
  readonly shakePulse = signal(false);

  readonly rubbleChips = computed(() => {
    const progress = this.progress();
    const total = progress.total;
    const handled = Math.max(0, progress.current - 1);

    return Array.from({ length: total }, (_, index) => ({
      index,
      cleared: index < handled,
    }));
  });

  constructor() {
    try {
      effect(() => {
        if (this.gateService.isActive()) {
          document.body.style.overflow = 'hidden';
          return;
        }

        document.body.style.overflow = '';
        this.closed.emit();
      });

      effect(() => {
        const tick = this.gateService.impactTick();
        if (!this.gateService.isActive() || tick <= 0) return;
        this.triggerShake();
      });
    } catch {
      // 防御：SSR 或异常注入上下文
    }
  }

  /**
   * 键盘快捷键
   * 1: 已读, 2: 完成
   */
  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (!this.gateService.isActive()) return;

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    if (event.key === '1') {
      event.preventDefault();
      this.gateService.markAsRead();
      return;
    }

    if (event.key === '2') {
      event.preventDefault();
      this.gateService.markAsCompleted();
    }
  }

  /**
   * 是否显示完成提示（原型方法）
   */
  showCompletionMessage(): boolean {
    try {
      return this.gateService?.showCompletionMessage?.() ?? false;
    } catch {
      return false;
    }
  }

  ngOnDestroy(): void {
    document.body.style.overflow = '';
  }

  private triggerShake(): void {
    this.shakePulse.set(false);

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => this.shakePulse.set(true));
    } else {
      this.shakePulse.set(true);
    }

    setTimeout(() => {
      this.shakePulse.set(false);
    }, 220);
  }
}
