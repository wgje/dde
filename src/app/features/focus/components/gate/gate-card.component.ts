/**
 * 大门门体组件（深色简洁卡片）
 *
 * 将当前待处理条目渲染在深色卡片中，
 * 支持上推已读 / 下拉完成手势。
 */

import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateService } from '../../../../../services/gate.service';

const DRAG_TRIGGER_THRESHOLD = 88;
const DRAG_MAX_DISTANCE = 130;

@Component({
  selector: 'app-gate-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="gate-card-scene" data-testid="gate-card">
      <div
        class="dark-card"
        [class.entering]="cardAnimation() === 'entering'"
        [class.heave-read]="cardAnimation() === 'heave_read'"
        [class.heavy-drop]="cardAnimation() === 'heavy_drop'"
        [class.settling]="cardAnimation() === 'settling'"
        [class.dragging]="isDragging()"
        [style.--drag-offset.px]="dragOffset()"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointercancel)="onPointerCancel()"
        (animationend)="onAnimationEnd($event)">

        <header class="card-header">
          <span class="card-caption">Sediment Gate</span>
          <span class="card-progress" data-testid="gate-progress">
            {{ progress().current }}/{{ progress().total }}
          </span>
        </header>

        <div class="card-body">
          @if (currentEntry(); as entry) {
            <p class="card-text">{{ entry.content }}</p>
            <div class="entry-meta">
              <span>{{ entry.createdAt | date:'HH:mm' }}</span>
              <span class="meta-sep">·</span>
              <span>{{ gestureHint() }}</span>
            </div>
          }
        </div>
      </div>
    </section>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
    }

    .gate-card-scene {
      position: relative;
      width: 100%;
      min-height: 45vh;
    }

    .dark-card {
      --drag-offset: 0;
      position: relative;
      min-height: 45vh;
      width: 100%;
      border-radius: 32px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: linear-gradient(180deg, rgba(45, 45, 50, 0.65) 0%, rgba(24, 24, 27, 0.85) 100%);
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.15), 
        inset 0 -1px 1px rgba(0, 0, 0, 0.3),
        0 20px 50px -12px rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(32px);
      -webkit-backdrop-filter: blur(32px);
      overflow: hidden;
      will-change: transform, opacity, filter;
      transform: translate3d(0, var(--drag-offset), 0);
      transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
      touch-action: none;
    }

    .dark-card::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.06) 0%, transparent 80%);
      pointer-events: none;
    }

    .dark-card.dragging {
      transition: none;
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.2), 
        inset 0 -1px 1px rgba(0, 0, 0, 0.3),
        0 30px 60px -12px rgba(0, 0, 0, 0.9);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.5rem 2rem 0;
      color: rgba(255, 255, 255, 0.5);
      letter-spacing: 0.12em;
      font-size: 0.75rem;
      text-transform: uppercase;
      position: relative;
      z-index: 1;
    }

    .card-caption {
      font-weight: 500;
    }

    .card-progress {
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, 0.7);
    }

    .card-body {
      min-height: 33vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1.8rem;
      padding: 2rem 2.5rem 3.5rem;
      position: relative;
      z-index: 1;
    }

    .card-text {
      margin: 0;
      max-width: 46rem;
      text-align: center;
      font-size: clamp(1.35rem, 1.55rem + 0.4vw, 2.2rem);
      line-height: 1.65;
      color: rgba(255, 255, 255, 0.98);
      font-weight: 300;
      letter-spacing: 0.03em;
      word-break: break-word;
      text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
    }

    .entry-meta {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.85rem;
      border-radius: 9999px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      color: rgba(255, 255, 255, 0.5);
      font-size: 0.75rem;
      letter-spacing: 0.04em;
    }

    .meta-sep {
      opacity: 0.4;
    }

    .dark-card.entering {
      animation: gateDoorEnter 620ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    .dark-card.heave-read {
      animation: gateDoorHeaveRead 560ms cubic-bezier(0.25, 0.92, 0.35, 1) forwards;
    }

    .dark-card.heavy-drop {
      animation: gateDoorHeavyDrop 660ms cubic-bezier(0.2, 0.66, 0.16, 1) forwards;
    }

    .dark-card.settling {
      animation: gateDoorSettling 520ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    @keyframes gateDoorEnter {
      from {
        opacity: 0;
        transform: translate3d(0, 48px, 0) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
      }
    }

    @keyframes gateDoorHeaveRead {
      0% {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1) rotate(0deg);
        filter: blur(0);
      }
      25% {
        transform: translate3d(0, 10px, 0) scale(1.01) rotate(0deg);
      }
      100% {
        opacity: 0;
        transform: translate3d(0, -92vh, 0) scale(0.85) rotate(-5deg);
        filter: blur(2px);
      }
    }

    @keyframes gateDoorHeavyDrop {
      0% {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
      }
      14% {
        transform: translate3d(0, -20px, 0) scale(1.005);
      }
      100% {
        opacity: 0;
        transform: translate3d(0, 120vh, 0) scale(0.92) rotate(1.8deg);
      }
    }

    @keyframes gateDoorSettling {
      from {
        opacity: 0;
        transform: translate3d(0, -72px, 0) scale(0.985);
      }
      to {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .dark-card,
      .dark-card.dragging,
      .dark-card.entering,
      .dark-card.heave-read,
      .dark-card.heavy-drop,
      .dark-card.settling {
        animation: none !important;
        transition: none !important;
        transform: none !important;
        filter: none !important;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateCardComponent {
  private activePointerId: number | null = null;
  private pointerStartY = 0;

  readonly gateService = inject(GateService);

  readonly progress = this.gateService.progress;
  readonly currentEntry = this.gateService.currentEntry;
  readonly cardAnimation = this.gateService.cardAnimation;
  readonly dragOffset = signal(0);
  readonly isDragging = signal(false);

  readonly gestureHint = computed(() => {
    const offset = this.dragOffset();
    if (offset > DRAG_TRIGGER_THRESHOLD * 0.6) return '松开完成';
    if (offset < -DRAG_TRIGGER_THRESHOLD * 0.6) return '松开标记已读';
    return '上推已读 · 下拉完成';
  });

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (this.cardAnimation() !== 'idle') return;

    this.activePointerId = event.pointerId;
    this.pointerStartY = event.clientY;
    this.dragOffset.set(0);
    this.isDragging.set(true);
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.isDragging() || this.activePointerId !== event.pointerId) return;

    const delta = event.clientY - this.pointerStartY;
    this.dragOffset.set(Math.max(-DRAG_MAX_DISTANCE, Math.min(DRAG_MAX_DISTANCE, delta)));
  }

  onPointerUp(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;

    const delta = this.dragOffset();
    this.resetDragState();

    if (delta >= DRAG_TRIGGER_THRESHOLD) {
      this.gateService.markAsCompleted();
      return;
    }

    if (delta <= -DRAG_TRIGGER_THRESHOLD) {
      this.gateService.markAsRead();
    }
  }

  onPointerCancel(): void {
    this.resetDragState();
  }

  /** 转发动画结束事件给 Service */
  onAnimationEnd(event: AnimationEvent): void {
    if (event.target !== event.currentTarget) return;

    const anim = this.cardAnimation();

    if (anim === 'entering') {
      this.gateService.onEnteringComplete();
      return;
    }

    if (anim === 'heave_read') {
      this.gateService.onHeaveReadComplete();
      return;
    }

    if (anim === 'heavy_drop') {
      this.gateService.onHeavyDropComplete();
      return;
    }

    if (anim === 'settling') {
      this.gateService.onSettlingComplete();
    }
  }

  private resetDragState(): void {
    this.activePointerId = null;
    this.pointerStartY = 0;
    this.dragOffset.set(0);
    this.isDragging.set(false);
  }
}
