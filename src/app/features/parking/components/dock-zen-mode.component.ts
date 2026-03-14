import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Input,
  OnDestroy,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { PerformanceTierService } from '../../../../services/performance-tier.service';

@Component({
  selector: 'app-dock-zen-mode',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  styles: [`
    :host {
      display: block;
    }

    .zen-overlay {
      position: fixed;
      inset: 0;
      z-index: 68;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      overflow: hidden;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      animation: zenFadeIn var(--pk-overlay-enter) var(--pk-ease-enter);
    }

    .zen-overlay::before,
    .zen-overlay::after {
      content: '';
      position: absolute;
      inset: -14%;
      pointer-events: none;
    }

    .zen-overlay::before {
      background:
        radial-gradient(circle at 50% 42%, rgba(var(--zen-primary-rgb, 99 102 241), 0.18) 0%, transparent 26%),
        radial-gradient(circle at 28% 70%, rgba(var(--zen-secondary-rgb, 52 211 153), 0.12) 0%, transparent 32%);
      opacity: var(--zen-aurora-opacity, 0.78);
    }

    .zen-overlay::after {
      background:
        radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.045) 0%, transparent 55%),
        linear-gradient(180deg, rgba(4, 8, 16, 0.04) 0%, rgba(4, 8, 16, 0.18) 100%);
      opacity: var(--zen-mist-opacity, 0.42);
    }

    .zen-pulse-ring {
      width: var(--pulse-size);
      height: var(--pulse-size);
      border-radius: 50%;
      border: 2px solid rgba(var(--zen-primary-rgb, 99 102 241), 0.38);
      background: radial-gradient(circle, rgba(var(--zen-primary-rgb, 99 102 241), 0.08) 0%, transparent 70%);
      animation: zenBreathe var(--breathe-duration) var(--pk-ease-standard) infinite;
      position: relative;
      box-shadow: 0 0 32px rgba(var(--zen-primary-rgb, 99 102 241), 0.12);
    }

    .zen-pulse-ring::before {
      content: '';
      position: absolute;
      inset: -8px;
      border-radius: 50%;
      border: 1px solid rgba(var(--zen-primary-rgb, 99 102 241), 0.16);
      animation: zenBreathe var(--breathe-duration) var(--pk-ease-standard) infinite 0.5s;
    }

    .zen-pulse-ring::after {
      content: '';
      position: absolute;
      inset: -16px;
      border-radius: 50%;
      border: 1px solid rgba(var(--zen-secondary-rgb, 52 211 153), 0.12);
      animation: zenBreathe var(--breathe-duration) var(--pk-ease-standard) infinite 1s;
    }

    .zen-hint {
      margin-top: 32px;
      font-size: 14px;
      color: rgba(var(--zen-text-rgb, 148 163 184), 0.72);
      letter-spacing: 0.15em;
      animation: zenHintFade calc(var(--pk-status-ring-pulse) * 2) var(--pk-ease-standard) 3;
    }

    .zen-exit-hint {
      position: absolute;
      bottom: 48px;
      font-size: 11px;
      color: rgba(var(--zen-text-rgb, 100 116 139), 0.42);
      letter-spacing: 0.1em;
    }

    @keyframes zenFadeIn {
      0%   { opacity: 0; }
      50%  { opacity: 0.6; }
      100% { opacity: 1; }
    }

    @keyframes zenBreathe {
      0%, 100% { transform: scale(1); opacity: 0.5; }
      25%  { transform: scale(1.02); opacity: 0.64; }
      50%  { transform: scale(1.05); opacity: 0.9; }
      75%  { transform: scale(1.03); opacity: 0.72; }
    }

    @keyframes zenHintFade {
      0%, 100% { opacity: 0.35; }
      50% { opacity: 0.6; }
    }

    .zen-overlay[data-performance-tier='T2'] .zen-pulse-ring,
    .zen-overlay[data-performance-tier='T2'] .zen-pulse-ring::before,
    .zen-overlay[data-performance-tier='T2'] .zen-pulse-ring::after {
      animation: none !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .zen-overlay,
      .zen-pulse-ring,
      .zen-pulse-ring::before,
      .zen-pulse-ring::after,
      .zen-hint {
        animation: none;
      }

      .zen-pulse-ring,
      .zen-pulse-ring::before,
      .zen-pulse-ring::after {
        opacity: 0.6;
      }

      .zen-hint {
        opacity: 0.5;
      }
    }
  `],
  template: `
    @if (isActive$()) {
      <!-- TODO: Add cdkTrapFocus from @angular/cdk/a11y when CDK is installed to provide proper focus trapping -->
      <div
        class="zen-overlay"
        [ngStyle]="overlayStyle()"
        [attr.data-performance-tier]="performanceTier()"
        (click)="exit.emit()"
        (touchstart)="exit.emit()"
        (keydown.escape)="exit.emit()"
        tabindex="0"
        role="dialog"
        aria-modal="true"
        aria-label="Zen 模式，点击任意位置退出。"
        data-testid="dock-v3-zen-mode">

        <div
          class="zen-pulse-ring"
          [style.--pulse-size.px]="pulseSize"
          [style.--breathe-duration]="breatheDuration">
        </div>

        <div class="zen-hint">{{ hintText }}</div>

        <div class="zen-exit-hint">点击任意位置退出</div>
      </div>
    }
  `,
})
export class DockZenModeComponent implements OnInit, OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly performanceTierService = inject(PerformanceTierService);

  private readonly _isActive = signal(false);
  @Input() set isActive(v: boolean) { this._isActive.set(v); }
  readonly isActive$ = this._isActive.asReadonly();
  readonly exit = output<void>();

  readonly pulseSize = PARKING_CONFIG.ZEN_MODE_PULSE_SIZE_PX;
  readonly blurPx = PARKING_CONFIG.ZEN_MODE_BLUR_PX;
  readonly hintText = PARKING_CONFIG.ZEN_MODE_HINT_TEXT;
  readonly breatheDuration = `${PARKING_CONFIG.ZEN_MODE_BREATHE_DURATION_S}s`;
  readonly performanceTier = computed(() => this.performanceTierService.tier());
  readonly isBurnout = computed(() => this.engine.isBurnoutActive());

  ngOnInit(): void {
    this.performanceTierService.startMeasuring();
  }

  ngOnDestroy(): void {
    this.performanceTierService.stopMeasuring();
  }

  readonly overlayStyle = computed<Record<string, string>>(() => {
    const tier = this.performanceTier();
    const burnout = this.isBurnout();
    const primaryRgb = burnout
      ? PARKING_CONFIG.ZEN_MODE_BURNOUT_PRIMARY_RGB
      : PARKING_CONFIG.ZEN_MODE_PRIMARY_RGB;
    const secondaryRgb = burnout
      ? PARKING_CONFIG.ZEN_MODE_BURNOUT_SECONDARY_RGB
      : PARKING_CONFIG.ZEN_MODE_SECONDARY_RGB;
    const textRgb = burnout ? '253 230 138' : '148 163 184';
    const alpha = tier === 'T2' ? 0.9 : tier === 'T1' ? 0.84 : 0.78;

    return {
      '--zen-primary-rgb': primaryRgb,
      '--zen-secondary-rgb': secondaryRgb,
      '--zen-text-rgb': textRgb,
      '--zen-aurora-opacity': tier === 'T2' ? '0.34' : tier === 'T1' ? '0.58' : '0.82',
      '--zen-mist-opacity': tier === 'T2' ? '0.48' : '0.42',
      background: `linear-gradient(180deg, rgba(6, 10, 18, ${Math.max(0.48, alpha - 0.18).toFixed(2)}) 0%, rgba(8, 12, 22, ${alpha.toFixed(2)}) 100%)`,
    };
  });
}
