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
      gap: 2rem;
      padding: clamp(2rem, 4vw, 3.5rem) clamp(1.5rem, 4vw, 3.5rem);
      background: radial-gradient(circle at 50% -20%, rgba(39, 39, 42, 0.85) 0%, rgba(9, 9, 11, 0.98) 100%);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      overflow: hidden;
      transform: translateY(0);
      /* 合成层提示：避免 backdrop-filter 导致入场首帧出现白屏/闪烁；
         will-change 在动画后由浏览器自动回收（animation 完成后无 will-change 更新） */
      will-change: opacity, transform;
      /* 限制重绘范围，减少 backdrop-filter 对周围元素的影响 */
      contain: layout style;
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
      margin-bottom: 0.5rem;
    }

    .gate-header h2 {
      margin: 0;
      font-size: clamp(1.8rem, 1.6rem + 1.2vw, 2.6rem);
      font-weight: 200;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      background: linear-gradient(180deg, #fff 0%, rgba(255, 255, 255, 0.5) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-shadow: 0 4px 16px rgba(255, 255, 255, 0.1);
    }

    .gate-header p {
      margin: 0.8rem auto 0;
      max-width: 42rem;
      font-size: 0.95rem;
      color: rgba(255, 255, 255, 0.5);
      line-height: 1.6;
      letter-spacing: 0.06em;
      font-weight: 300;
    }

    .rubble-track {
      margin: 1.5rem auto 0;
      max-width: 520px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(12px, 1fr));
      gap: 0.5rem;
      align-items: center;
    }

    .rubble-chip {
      height: 4px;
      border-radius: 9999px;
      background: linear-gradient(90deg, rgba(255, 255, 255, 0.3) 0%, rgba(255, 255, 255, 0.15) 100%);
      box-shadow: 0 0 12px rgba(255, 255, 255, 0.15);
      transition: all var(--pk-panel-enter) var(--pk-ease-enter);
    }

    .rubble-chip.cleared {
      opacity: 0.15;
      background: rgba(255, 255, 255, 0.1);
      transform: translateY(6px) scale(0.8);
      box-shadow: none;
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
      gap: 0.25rem;
      padding-bottom: 0.8rem;
      z-index: 0;
      mask-image: linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%);
      -webkit-mask-image: linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%);
    }

    .strata-row {
      width: min(640px, calc(100vw - 2rem));
      height: 24px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px 12px 0 0;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.01) 100%);
      transform: translateY(calc(var(--layer-index) * 6px)) scaleX(calc(1 - (var(--layer-index) * 0.05)));
      opacity: var(--layer-opacity);
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.45);
      font-size: 0.7rem;
      letter-spacing: 0.06em;
      box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.2);
    }

    .gate-completion {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(9, 9, 11, 0.6);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }

    .completion-card {
      width: min(360px, calc(100vw - 2rem));
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: linear-gradient(180deg, rgba(39, 39, 42, 0.8) 0%, rgba(24, 24, 27, 0.95) 100%);
      padding: 2rem 1.5rem;
      text-align: center;
      color: rgba(255, 255, 255, 0.95);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 24px 48px -12px rgba(0, 0, 0, 0.8);
      animation: completion-pop var(--pk-panel-enter) var(--pk-ease-enter);
    }

    .completion-mark {
      margin: 0 auto 1rem;
      width: 56px;
      height: 56px;
      border-radius: 9999px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.9) 0%, rgba(21, 128, 61, 0.95) 100%);
      color: #fff;
      box-shadow: 0 8px 24px -6px rgba(34, 197, 94, 0.5);
    }

    .completion-card h3 {
      margin: 0;
      font-size: 1.25rem;
      letter-spacing: 0.06em;
      font-weight: 400;
    }

    .completion-card p {
      margin: 0.6rem 0 0;
      color: rgba(255, 255, 255, 0.6);
      font-size: 0.9rem;
      letter-spacing: 0.02em;
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
}
