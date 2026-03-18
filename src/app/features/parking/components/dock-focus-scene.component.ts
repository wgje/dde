import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  Input,
  inject,
  OnDestroy,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeStyle } from '@angular/platform-browser';
import { NgStyle } from '@angular/common';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import type { DockFocusTransitionPhase } from '../../../../models/parking-dock';
import { PerformanceTierService, type FocusPerformanceTier } from '../../../../services/performance-tier.service';

export type DockFocusSceneMode = 'steady' | 'decision' | 'fragment' | 'burnout' | 'zen';

interface DockFocusScenePreset {
  primaryRgb: string;
  secondaryRgb: string;
  tertiaryRgb: string;
  backdropAlpha: number;
  baseOpacity: number;
  auroraOpacity: number;
  grainOpacity: number;
  vignetteOpacity: number;
  baseScale: number;
  baseSaturation: number;
  baseBrightness: number;
  bloomScale: number;
  driftDurationS: number;
  pulseDurationS: number;
  stageHaloOpacity: number;
  stageRingOpacity: number;
  stageSecondaryOpacity: number;
}

@Component({
  selector: 'app-dock-focus-scene',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgStyle],
  styles: [`
    :host {
      display: block;
    }

    .focus-scene {
      pointer-events: none;
      opacity: 0;
      overflow: hidden;
      transition: opacity var(--pk-shell-enter) var(--pk-ease-standard);
    }

    .focus-scene.active {
      opacity: 1;
    }

    .focus-scene-layer {
      position: absolute;
      inset: -8%;
      pointer-events: none;
    }

    .focus-base-mesh {
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      opacity: var(--scene-base-opacity, 0.78);
      transform: translate3d(0, 0, 0) scale(var(--scene-base-scale, 1.03));
      animation: focusSceneDrift var(--scene-drift-duration, 24s) ease-in-out infinite alternate;
      animation-delay: var(--scene-ambient-delay, 340ms);
    }

    .focus-scene-aurora {
      background:
        radial-gradient(circle at 18% 24%, rgba(var(--scene-primary-rgb, 99 102 241), calc(var(--scene-aurora-opacity, 0.18) * 0.92)) 0%, transparent 32%),
        radial-gradient(circle at 76% 30%, rgba(var(--scene-secondary-rgb, 52 211 153), calc(var(--scene-aurora-opacity, 0.18) * 0.8)) 0%, transparent 36%),
        radial-gradient(circle at 54% 78%, rgba(var(--scene-tertiary-rgb, 245 158 11), calc(var(--scene-aurora-opacity, 0.18) * 0.62)) 0%, transparent 40%);
      opacity: 0.88;
      transform: scale(var(--scene-bloom-scale, 1.05));
      animation: focusSceneBloom var(--scene-pulse-duration, 10s) ease-in-out infinite;
      animation-delay: var(--scene-ambient-delay, 340ms);
    }

    .focus-scene-vignette {
      background:
        radial-gradient(ellipse 88% 68% at 50% 42%, rgba(4, 6, 12, 0) 0%, rgba(4, 6, 12, var(--scene-vignette-opacity, 0.52)) 100%),
        linear-gradient(180deg, rgba(6, 8, 14, 0.06) 0%, rgba(6, 8, 14, 0.24) 100%);
    }

    .focus-scene-grain {
      opacity: var(--scene-grain-opacity, 0.04);
      background-image:
        repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.04) 0 1px, transparent 1px 3px),
        repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.035) 0 1px, transparent 1px 4px);
      background-size: 180px 180px, 220px 220px;
      mix-blend-mode: soft-light;
      animation: focusSceneGrainShift 16s linear infinite;
      animation-delay: var(--scene-ambient-delay, 340ms);
    }

    .focus-backdrop {
      pointer-events: none;
      opacity: 0;
      transition:
        opacity var(--pk-shell-enter) var(--pk-ease-standard),
        background-color var(--pk-shell-enter) var(--pk-ease-standard);
    }

    .focus-backdrop.active {
      opacity: 1;
      will-change: opacity;
    }

    .console-stage {
      pointer-events: none;
      opacity: 0;
      backface-visibility: hidden;
      transition: opacity var(--pk-shell-exit) var(--pk-ease-standard);
      will-change: opacity, transform;
    }

    .console-stage.active {
      opacity: var(--stage-shell-opacity, 1);
    }

    .console-stage-shell {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      transform: translateY(0);
      transform-origin: center center;
      backface-visibility: hidden;
      transition: transform var(--pk-shell-enter) var(--pk-ease-enter);
      will-change: transform;
    }

    .console-stage-shell::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: var(--stage-halo-width);
      height: var(--stage-halo-height);
      transform: translate(-50%, -50%);
      background:
        radial-gradient(
          ellipse 84% 66% at center,
          rgba(var(--stage-primary-rgb), var(--stage-halo-opacity)) 0%,
          transparent 72%
        ),
        radial-gradient(
          ellipse 80% 60% at center,
          rgba(var(--stage-secondary-rgb), var(--stage-secondary-opacity)) 0%,
          transparent 65%
        );
      border-radius: 50%;
      pointer-events: none;
      z-index: -1;
      animation: stageHaloPulse var(--stage-pulse-duration) ease-in-out infinite;
      animation-delay: var(--scene-ambient-delay, 340ms);
    }

    .console-stage-shell::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: calc(var(--stage-halo-width) * 0.75);
      height: calc(var(--stage-halo-height) * 0.76);
      transform: translate(-50%, calc(-50% - 20px));
      border: 1px solid rgba(var(--stage-primary-rgb), var(--stage-ring-opacity));
      border-radius: 50%;
      pointer-events: none;
      z-index: -1;
    }

    .console-stage[data-transition='entering'] {
      animation: focusStageEnter var(--pk-focus-enter) var(--pk-ease-enter) forwards;
      animation-delay: var(--scene-entry-stage-delay, 180ms);
    }

    .console-stage[data-transition='exiting'] {
      animation: focusStageExit var(--pk-focus-exit) var(--pk-ease-exit) forwards;
    }

    @keyframes focusSceneDrift {
      0% {
        transform: translate3d(-1.2%, -0.8%, 0) scale(var(--scene-base-scale, 1.03));
      }
      33% {
        transform: translate3d(0.4%, 0.5%, 0) scale(calc(var(--scene-base-scale, 1.03) + 0.008));
      }
      66% {
        transform: translate3d(-0.3%, -0.3%, 0) scale(calc(var(--scene-base-scale, 1.03) + 0.004));
      }
      100% {
        transform: translate3d(1.1%, -0.4%, 0) scale(var(--scene-base-scale, 1.03));
      }
    }

    @keyframes focusSceneBloom {
      0%, 100% {
        opacity: 0.84;
        transform: scale(var(--scene-bloom-scale, 1.05));
      }
      25% {
        opacity: 0.92;
        transform: scale(calc(var(--scene-bloom-scale, 1.05) + 0.008));
      }
      50% {
        opacity: 1;
        transform: scale(calc(var(--scene-bloom-scale, 1.05) + 0.014));
      }
      75% {
        opacity: 0.94;
        transform: scale(calc(var(--scene-bloom-scale, 1.05) + 0.006));
      }
    }

    @keyframes focusSceneGrainShift {
      from { transform: translate3d(0, 0, 0); }
      to { transform: translate3d(-2%, -1.5%, 0); }
    }

    @keyframes stageHaloPulse {
      0%, 100% {
        opacity: 0.86;
        transform: translate(-50%, -50%) scale(0.997);
      }
      50% {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1.005);
      }
    }

    @keyframes focusStageEnter {
      0% {
        opacity: 0;
        transform: translateY(var(--stage-enter-from-y, 10px)) scale(0.98);
      }
      50% {
        opacity: calc(var(--stage-shell-opacity, 1) * 0.6);
        transform: translateY(var(--stage-enter-mid-y, 2px)) scale(0.998);
      }
      100% {
        opacity: var(--stage-shell-opacity, 1);
        transform: translateY(0) scale(1);
      }
    }

    @keyframes focusStageExit {
      0% {
        opacity: var(--stage-shell-opacity, 1);
        transform: translateY(0) scale(1);
      }
      50% {
        opacity: calc(var(--stage-shell-opacity, 1) * 0.4);
        transform: translateY(var(--stage-exit-mid-y, 4px)) scale(0.995);
      }
      100% {
        opacity: 0;
        transform: translateY(var(--stage-exit-end-y, 8px)) scale(0.99);
      }
    }

    .focus-scene[data-performance-tier='T1'] .focus-base-mesh {
      animation: none;
    }

    .focus-scene[data-performance-tier='T1'] .focus-scene-grain {
      opacity: calc(var(--scene-grain-opacity, 0.04) * 0.35);
      animation: none;
    }

    .focus-scene[data-performance-tier='T1'] .focus-scene-aurora,
    .console-stage-shell[data-performance-tier='T1']::before {
      animation: none;
    }

    .focus-scene[data-performance-tier='T2'] .focus-base-mesh,
    .focus-scene[data-performance-tier='T2'] .focus-scene-aurora,
    .focus-scene[data-performance-tier='T2'] .focus-scene-grain,
    .focus-scene[data-reduced-motion='true'] .focus-base-mesh,
    .focus-scene[data-reduced-motion='true'] .focus-scene-aurora,
    .focus-scene[data-reduced-motion='true'] .focus-scene-grain,
    .console-stage-shell[data-performance-tier='T2']::before,
    .console-stage-shell[data-reduced-motion='true']::before {
      animation: none !important;
      transform: none;
    }

    .console-stage[data-performance-tier='T2'],
    .console-stage[data-reduced-motion='true'] {
      transition: none !important;
    }

    .console-stage[data-performance-tier='T2'][data-transition='entering'],
    .console-stage[data-performance-tier='T2'][data-transition='exiting'],
    .console-stage[data-reduced-motion='true'][data-transition='entering'],
    .console-stage[data-reduced-motion='true'][data-transition='exiting'] {
      animation: none !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .focus-scene,
      .focus-base-mesh,
      .focus-backdrop,
      .console-stage,
      .console-stage-shell,
      .console-stage-shell::before {
        transition: none;
        animation: none;
      }
    }
  `],
  template: `
    @if (sceneMounted()) {
      <div
        class="focus-scene fixed inset-0 z-[5]"
        [class.active]="sceneVisible()"
        [attr.data-scene]="sceneMode$()"
        [attr.data-performance-tier]="performanceTier$()"
        [attr.data-reduced-motion]="reducedMotion$() ? 'true' : 'false'"
        [attr.data-scrim]="scrimOn$() ? 'on' : 'off'"
        [attr.data-transition]="transitionPhase$() ?? 'steady'"
        [ngStyle]="focusSceneStyle()"
        data-testid="dock-v3-focus-scene">
        <div
          class="focus-scene-layer focus-base-mesh"
          [style.background-image]="safeBackgroundImage()">
        </div>
        <div class="focus-scene-layer focus-scene-aurora"></div>
        <div class="focus-scene-layer focus-scene-vignette"></div>
        <div class="focus-scene-layer focus-scene-grain"></div>
      </div>

      <div
        class="focus-backdrop fixed inset-0 z-10"
        [class.active]="backdropVisible()"
        [style.background-color]="backdropVisible() ? focusBackdropColor() : 'rgba(0,0,0,0)'"
        [style.pointer-events]="backdropVisible() ? 'auto' : 'none'"
        data-testid="dock-v3-focus-backdrop"
        (click)="backdropClick.emit()">
      </div>

      <div
        class="fixed inset-0 z-30 flex items-center justify-center console-stage"
        [class.active]="stageVisible()"
        style="pointer-events: none;"
        [attr.aria-hidden]="stageVisible() ? null : 'true'"
        [attr.inert]="stageVisible() ? null : ''"
        [attr.data-performance-tier]="performanceTier$()"
        [attr.data-scene]="sceneMode$()"
        [attr.data-reduced-motion]="reducedMotion$() ? 'true' : 'false'"
        [attr.data-scrim]="scrimOn$() ? 'on' : 'off'"
        [attr.data-transition]="transitionPhase$() ?? 'steady'"
        [ngStyle]="focusStageStyle()"
        data-testid="dock-v3-focus-stage"
        (animationend)="onStageAnimationEnd($event)"
        (transitionend)="onStageTransitionEnd($event)">
        <div
          class="console-stage-shell"
          [style.transform]="stageTransform$()"
          [attr.data-performance-tier]="performanceTier$()"
          [attr.data-scene]="sceneMode$()"
          [attr.data-reduced-motion]="reducedMotion$() ? 'true' : 'false'"
          [attr.data-scrim]="scrimOn$() ? 'on' : 'off'"
          [attr.data-transition]="transitionPhase$() ?? 'steady'">
          @if (stageVisible()) {
            <!-- scrim 关闭且无过渡时，彻底卸载投影内容，避免透明固定层继续吞点击。 -->
            <ng-content></ng-content>
          }
        </div>
      </div>
    }
  `,
})
export class DockFocusSceneComponent implements OnInit, OnDestroy {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly performanceTierService = inject(PerformanceTierService);

  private readonly activeState = signal(false);
  private readonly scrimOnState = signal(false);
  private readonly sceneModeState = signal<DockFocusSceneMode>('steady');
  private readonly performanceTierState = signal<FocusPerformanceTier>('T0');
  private readonly reducedMotionState = signal(false);
  private readonly transitionPhaseState = signal<DockFocusTransitionPhase | null>(null);
  private readonly stageTransformState = signal('translateY(0)');
  private readonly backgroundImageUrlState = signal('');

  readonly active$ = this.activeState;
  readonly scrimOn$ = this.scrimOnState;
  readonly sceneMode$ = this.sceneModeState;
  readonly performanceTier$ = this.performanceTierState;
  readonly reducedMotion$ = this.reducedMotionState;
  readonly transitionPhase$ = this.transitionPhaseState;
  readonly stageTransform$ = this.stageTransformState;
  readonly backgroundImageUrl$ = this.backgroundImageUrlState;

  @Input({ alias: 'active' })
  set active(value: boolean) {
    this.activeState.set(Boolean(value));
  }

  @Input({ alias: 'scrimOn' })
  set scrimOn(value: boolean) {
    this.scrimOnState.set(Boolean(value));
  }

  @Input({ alias: 'sceneMode' })
  set sceneMode(value: DockFocusSceneMode) {
    this.sceneModeState.set(value ?? 'steady');
  }

  @Input({ alias: 'performanceTier' })
  set performanceTier(value: FocusPerformanceTier) {
    this.performanceTierState.set(value ?? 'T0');
  }

  @Input({ alias: 'reducedMotion' })
  set reducedMotion(value: boolean) {
    this.reducedMotionState.set(Boolean(value));
  }

  @Input({ alias: 'transitionPhase' })
  set transitionPhase(value: DockFocusTransitionPhase | null) {
    this.transitionPhaseState.set(value ?? null);
  }

  @Input({ alias: 'stageTransform' })
  set stageTransform(value: string) {
    this.stageTransformState.set(value || 'translateY(0)');
  }

  @Input({ alias: 'backgroundImageUrl' })
  set backgroundImageUrl(value: string) {
    this.backgroundImageUrlState.set(value || '');
  }

  readonly backdropClick = output<void>();
  readonly transitionSettled = output<DockFocusTransitionPhase>();

  private settledPhase: DockFocusTransitionPhase | null = null;

  /** 安全的背景图 CSS url() 值，防止 CSS 注入 */
  readonly safeBackgroundImage = computed<SafeStyle>(() => {
    const url = this.backgroundImageUrl$();
    if (!url) return 'none';
    const normalized = url.trim();
    if (!normalized.startsWith('https://') && !normalized.startsWith('data:image/')) {
      return 'none';
    }
    return this.sanitizer.bypassSecurityTrustStyle(`url(${CSS.escape(normalized)})`);
  });

  constructor() {
    // 当 transitionPhase / performanceTier / reducedMotion 变化时检查是否需要立即 settle
    effect(() => {
      const phase = this.transitionPhase$();
      this.performanceTier$();
      this.reducedMotion$();
      if (phase === null) {
        this.settledPhase = null;
        return;
      }
      this.settledPhase = null;
      this.scheduleImmediateSettleIfNeeded();
    });
  }

  ngOnInit(): void {
    this.performanceTierService.startMeasuring();
  }

  ngOnDestroy(): void {
    this.performanceTierService.stopMeasuring();
  }

  private readonly presets: Record<DockFocusSceneMode, DockFocusScenePreset> = {
    steady: {
      primaryRgb: '99 102 241',
      secondaryRgb: '52 211 153',
      tertiaryRgb: '245 158 11',
      backdropAlpha: 0.72,
      baseOpacity: 0.82,
      auroraOpacity: 0.2,
      grainOpacity: 0.04,
      vignetteOpacity: 0.52,
      baseScale: 1.05,
      baseSaturation: 1.12,
      baseBrightness: 0.96,
      bloomScale: 1.06,
      driftDurationS: 26,
      pulseDurationS: 11,
      stageHaloOpacity: 0.09,
      stageRingOpacity: 0.08,
      stageSecondaryOpacity: 0.04,
    },
    decision: {
      primaryRgb: '99 102 241',
      secondaryRgb: '245 158 11',
      tertiaryRgb: '248 113 113',
      backdropAlpha: 0.76,
      baseOpacity: 0.84,
      auroraOpacity: 0.24,
      grainOpacity: 0.045,
      vignetteOpacity: 0.58,
      baseScale: 1.06,
      baseSaturation: 1.15,
      baseBrightness: 0.94,
      bloomScale: 1.08,
      driftDurationS: 20,
      pulseDurationS: 8,
      stageHaloOpacity: 0.12,
      stageRingOpacity: 0.1,
      stageSecondaryOpacity: 0.06,
    },
    fragment: {
      primaryRgb: '56 189 248',
      secondaryRgb: '251 191 36',
      tertiaryRgb: '52 211 153',
      backdropAlpha: 0.74,
      baseOpacity: 0.8,
      auroraOpacity: 0.18,
      grainOpacity: 0.03,
      vignetteOpacity: 0.48,
      baseScale: 1.04,
      baseSaturation: 1.08,
      baseBrightness: 0.98,
      bloomScale: 1.05,
      driftDurationS: 24,
      pulseDurationS: 10,
      stageHaloOpacity: 0.1,
      stageRingOpacity: 0.08,
      stageSecondaryOpacity: 0.05,
    },
    burnout: {
      primaryRgb: '245 158 11',
      secondaryRgb: '248 113 113',
      tertiaryRgb: '99 102 241',
      backdropAlpha: 0.80,
      baseOpacity: 0.86,
      auroraOpacity: 0.22,
      grainOpacity: 0.035,
      vignetteOpacity: 0.62,
      baseScale: 1.03,
      baseSaturation: 1.06,
      baseBrightness: 0.9,
      bloomScale: 1.04,
      driftDurationS: 18,
      pulseDurationS: 7,
      stageHaloOpacity: 0.14,
      stageRingOpacity: 0.11,
      stageSecondaryOpacity: 0.08,
    },
    zen: {
      primaryRgb: PARKING_CONFIG.ZEN_MODE_PRIMARY_RGB,
      secondaryRgb: PARKING_CONFIG.ZEN_MODE_SECONDARY_RGB,
      tertiaryRgb: '14 165 233',
      backdropAlpha: 0.82,
      baseOpacity: 0.78,
      auroraOpacity: 0.16,
      grainOpacity: 0.02,
      vignetteOpacity: 0.64,
      baseScale: 1.02,
      baseSaturation: 1.02,
      baseBrightness: 0.88,
      bloomScale: 1.03,
      driftDurationS: 32,
      pulseDurationS: 12,
      stageHaloOpacity: 0.07,
      stageRingOpacity: 0.06,
      stageSecondaryOpacity: 0.04,
    },
  };

  readonly sceneMounted = computed(() =>
    this.active$() || this.transitionPhase$() !== null,
  );

  readonly sceneVisible = computed(() =>
    // 虚化关闭时隐藏场景背景，避免背景图残留在主内容上
    (this.active$() && this.scrimOn$())
    || this.transitionPhase$() === 'entering'
    || this.transitionPhase$() === 'exiting',
  );

  readonly backdropVisible = computed(() =>
    this.sceneMounted() && this.scrimOn$(),
  );

  readonly stageVisible = computed(() =>
    // 舞台在虚化开启或过渡动画期间可见；虚化关闭时隐藏舞台避免遮挡主内容
    this.sceneMounted() && (this.scrimOn$() || this.transitionPhase$() !== null),
  );

  readonly focusSceneStyle = computed<Record<string, string>>(() => {
    const preset = this.presets[this.sceneMode$()];
    const tier = this.performanceTier$();
    const reduced = this.reducedMotion$();
    const transparentFactor = this.scrimOn$() ? 1 : PARKING_CONFIG.FOCUS_SCENE_TRANSPARENT_ALPHA;
    const auroraFactor = (tier === 'T2' ? 0.28 : tier === 'T1' ? 0.6 : 1) * transparentFactor;
    const grainFactor = reduced || tier === 'T2'
      ? 0
      : (tier === 'T1' ? 0.35 : 1) * transparentFactor;
    const driftDuration = reduced || tier === 'T2'
      ? '0s'
      : `${(preset.driftDurationS * (tier === 'T1' ? 1.2 : 1)).toFixed(1)}s`;
    const pulseDuration = reduced || tier === 'T2'
      ? '0s'
      : `${(preset.pulseDurationS * (tier === 'T1' ? 1.15 : 1)).toFixed(1)}s`;

    return {
      '--scene-primary-rgb': preset.primaryRgb,
      '--scene-secondary-rgb': preset.secondaryRgb,
      '--scene-tertiary-rgb': preset.tertiaryRgb,
      '--scene-base-opacity': (preset.baseOpacity * transparentFactor).toFixed(3),
      '--scene-base-scale': (reduced || tier === 'T2' ? 1 : preset.baseScale).toFixed(3),
      '--scene-aurora-opacity': (preset.auroraOpacity * auroraFactor).toFixed(3),
      '--scene-grain-opacity': (preset.grainOpacity * grainFactor).toFixed(3),
      '--scene-vignette-opacity': (
        (this.scrimOn$() ? preset.vignetteOpacity : PARKING_CONFIG.FOCUS_SCENE_TRANSPARENT_VIGNETTE_ALPHA)
        + (tier === 'T2' ? 0.08 : tier === 'T1' ? 0.04 : 0)
      ).toFixed(3),
      '--scene-bloom-scale': (reduced || tier === 'T2' ? 1.01 : preset.bloomScale).toFixed(3),
      '--scene-drift-duration': driftDuration,
      '--scene-pulse-duration': pulseDuration,
      '--scene-ambient-delay': `${PARKING_CONFIG.MOTION.focus.ambientDelayMs}ms`,
      '--scene-entry-bg-delay': `${PARKING_CONFIG.FOCUS_SCENE_ENTRY_BG_MS}ms`,
      '--scene-entry-stage-delay': `${PARKING_CONFIG.FOCUS_SCENE_ENTRY_STAGE_MS}ms`,
      '--scene-entry-radar-delay': `${PARKING_CONFIG.FOCUS_SCENE_ENTRY_RADAR_MS}ms`,
      '--scene-entry-environment-delay': `${PARKING_CONFIG.FOCUS_SCENE_ENTRY_ENV_MS}ms`,
      '--scene-entry-hud-delay': `${PARKING_CONFIG.FOCUS_SCENE_ENTRY_HUD_MS}ms`,
    };
  });

  readonly focusStageStyle = computed<Record<string, string>>(() => {
    const preset = this.presets[this.sceneMode$()];
    const tier = this.performanceTier$();
    const reduced = this.reducedMotion$();
    const scrimFactor = this.scrimOn$() ? 1 : PARKING_CONFIG.FOCUS_SCENE_TRANSPARENT_STAGE_ALPHA;
    const haloFactor = (tier === 'T2' ? 0.4 : tier === 'T1' ? 0.72 : 1) * scrimFactor;
    const enterShiftPx = PARKING_CONFIG.MOTION.distance.focusShiftPx + 4;
    const enterMidShiftPx = Math.max(2, Math.round(PARKING_CONFIG.MOTION.distance.focusShiftPx / 3));
    const exitMidShiftPx = Math.max(4, Math.round(PARKING_CONFIG.MOTION.distance.focusExitShiftPx / 2));
    const exitShiftPx = PARKING_CONFIG.MOTION.distance.focusExitShiftPx;

    return {
      '--stage-primary-rgb': preset.primaryRgb,
      '--stage-secondary-rgb': preset.secondaryRgb,
      '--stage-halo-opacity': (preset.stageHaloOpacity * haloFactor).toFixed(3),
      '--stage-secondary-opacity': (preset.stageSecondaryOpacity * haloFactor).toFixed(3),
      '--stage-ring-opacity': (preset.stageRingOpacity * haloFactor).toFixed(3),
      '--stage-halo-width': tier === 'T2' ? '560px' : '640px',
      '--stage-halo-height': tier === 'T2' ? '380px' : '420px',
      '--stage-pulse-duration': reduced || tier === 'T2'
        ? '0s'
        : `${(preset.pulseDurationS * 0.9).toFixed(1)}s`,
      '--stage-shell-opacity': scrimFactor.toFixed(3),
      '--stage-enter-from-y': `${enterShiftPx}px`,
      '--stage-enter-mid-y': `${enterMidShiftPx}px`,
      '--stage-exit-mid-y': `${exitMidShiftPx}px`,
      '--stage-exit-end-y': `${exitShiftPx}px`,
      '--scene-ambient-delay': `${PARKING_CONFIG.MOTION.focus.ambientDelayMs}ms`,
      '--scene-entry-stage-delay': `${PARKING_CONFIG.FOCUS_SCENE_ENTRY_STAGE_MS}ms`,
      '--scene-entry-radar-delay': `${PARKING_CONFIG.FOCUS_SCENE_ENTRY_RADAR_MS}ms`,
      '--scene-entry-environment-delay': `${PARKING_CONFIG.FOCUS_SCENE_ENTRY_ENV_MS}ms`,
    };
  });

  readonly focusBackdropColor = computed(() => {
    const preset = this.presets[this.sceneMode$()];
    const tier = this.performanceTier$();
    const alphaBoost = tier === 'T2' ? 0.16 : tier === 'T1' ? 0.08 : 0;
    const alpha = Math.min(0.96, preset.backdropAlpha + alphaBoost);
    return `rgba(6,10,18,${alpha.toFixed(2)})`;
  });

  onStageAnimationEnd(event: AnimationEvent): void {
    const phase = this.transitionPhase$();
    if (!phase) return;
    const isEnter = this.matchAnimationName(event.animationName, 'focusStageEnter');
    const isExit = this.matchAnimationName(event.animationName, 'focusStageExit');
    if ((phase === 'entering' && isEnter) || (phase === 'exiting' && isExit)) {
      this.emitTransitionSettled(phase);
    }
  }

  onStageTransitionEnd(event: TransitionEvent): void {
    const phase = this.transitionPhase$();
    if (!phase || event.propertyName !== 'opacity') return;
    if (this.shouldShortCircuitTransition()) {
      this.emitTransitionSettled(phase);
    }
  }

  private scheduleImmediateSettleIfNeeded(): void {
    const phase = this.transitionPhase$();
    if (!phase || !this.shouldShortCircuitTransition()) return;
    queueMicrotask(() => {
      if (this.transitionPhase$() === phase) {
        this.emitTransitionSettled(phase);
      }
    });
  }

  private shouldShortCircuitTransition(): boolean {
    return this.reducedMotion$() || this.performanceTier$() === 'T2';
  }

  private emitTransitionSettled(phase: DockFocusTransitionPhase): void {
    if (this.settledPhase === phase) return;
    this.settledPhase = phase;
    this.transitionSettled.emit(phase);
  }

  private matchAnimationName(eventName: string, keyframeName: string): boolean {
    return eventName === keyframeName || eventName.endsWith(`_${keyframeName}`);
  }
}
