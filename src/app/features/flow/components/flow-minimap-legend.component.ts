import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';

import type { MinimapLegendCategory } from './flow-minimap-geometry';

export const FLOW_MINIMAP_TEMPLATE = `
  <div
    class="minimap-stage"
    [class.minimap-stage-mobile]="mobile"
    (pointerenter)="onAttentionPointerEnter()"
    (pointerleave)="onAttentionPointerLeave()"
    (focusin)="onAttentionFocus()"
    (focusout)="onAttentionFocusOut($event)"
  >
    <svg
      class="minimap-svg"
      [class.minimap-attention-active]="attentionActive()"
      [attr.viewBox]="viewBoxStr()"
      preserveAspectRatio="xMidYMid meet"
      role="application"
      tabindex="0"
      aria-label="流程图小地图（拖动平移，滚轮缩放，方向键平移，+/- 缩放）"
      (pointerdown)="onPointerDown($event)"
      (pointermove)="onPointerMove($event)"
      (pointerup)="onPointerUp($event)"
      (pointercancel)="onPointerCancel($event)"
      (wheel)="onWheel($event)"
      (keydown)="onKeyDown($event)"
    >
      <title>流程图小地图</title>
      <defs>
        <radialGradient
          [attr.id]="attentionGradientId"
          gradientUnits="userSpaceOnUse"
          [attr.cx]="attentionGradient().cx"
          [attr.cy]="attentionGradient().cy"
          [attr.r]="attentionGradient().r"
        >
          <stop offset="0" stop-color="white" stop-opacity="1" />
          <stop offset="0.42" stop-color="white" stop-opacity="0.76" />
          <stop offset="1" stop-color="white" stop-opacity="0.24" />
        </radialGradient>
        <radialGradient
          [attr.id]="attentionLensGradientId"
          data-minimap-attention-lens-gradient
          gradientUnits="userSpaceOnUse"
          [attr.cx]="attentionGradient().cx"
          [attr.cy]="attentionGradient().cy"
          [attr.r]="attentionGradient().r"
        >
          <stop class="attention-lens-stop-core" offset="0" />
          <stop class="attention-lens-stop-mid" offset="0.48" />
          <stop class="attention-lens-stop-edge" offset="1" />
        </radialGradient>
        <mask
          [attr.id]="attentionMaskId"
          data-minimap-attention-mask
          maskUnits="userSpaceOnUse"
          class="attention-mask"
        >
          <rect
            [attr.x]="viewBox().x"
            [attr.y]="viewBox().y"
            [attr.width]="viewBox().w"
            [attr.height]="viewBox().h"
            [attr.fill]="attentionGradientFill"
          />
        </mask>
      </defs>

      <circle
        data-minimap-attention-lens
        class="minimap-attention-lens"
        [attr.cx]="attentionGradient().cx"
        [attr.cy]="attentionGradient().cy"
        [attr.r]="attentionGradient().r"
        [attr.fill]="attentionLensGradientFill"
        pointer-events="none"
      />
      <g class="minimap-map-layer" [attr.mask]="attentionActive() ? attentionMaskFill : null">
        @if (showLinks) {
          @for (link of linkShapes(); track link.key) {
            <line
              class="minimap-link"
              [attr.x1]="link.x1"
              [attr.y1]="link.y1"
              [attr.x2]="link.x2"
              [attr.y2]="link.y2"
              [attr.stroke]="link.color"
              [attr.stroke-dasharray]="link.dashed ? '4 3' : null"
              stroke-width="1.25"
              vector-effect="non-scaling-stroke"
            />
          }
        }

        @for (node of nodeShapes(); track node.key) {
          <g class="minimap-node-glyph">
            <rect
              class="minimap-node-body"
              [attr.x]="node.x - node.w * 0.125"
              [attr.y]="node.y"
              [attr.width]="node.w * 1.25"
              [attr.height]="node.h"
              [attr.rx]="node.h / 2"
              [attr.ry]="node.h / 2"
              fill="var(--minimap-node-fill)"
              stroke="var(--overview-surface, #efeee9)"
              stroke-width="1.2"
              vector-effect="non-scaling-stroke"
            />
          </g>
        }

        @for (marker of visibleSemanticMarkers(); track marker.key) {
          @switch (marker.kind) {
            @case ('sidecar') {
              <path
                data-minimap-marker="sidecar"
                class="semantic-marker marker-sidecar"
                [attr.d]="starPath(marker)"
                vector-effect="non-scaling-stroke"
              />
            }
            @case ('siyuan') {
              <path
                data-minimap-marker="siyuan"
                class="semantic-marker marker-siyuan"
                [attr.d]="diamondPath(marker)"
                vector-effect="non-scaling-stroke"
              />
            }
            @case ('docked') {
              <path
                data-minimap-marker="docked"
                class="semantic-marker marker-docked"
                [attr.d]="openSquarePath(marker)"
                vector-effect="non-scaling-stroke"
              />
            }
            @case ('parked') {
              <rect
                data-minimap-marker="parked"
                class="semantic-marker marker-parked"
                [attr.x]="outlineRect(marker).x"
                [attr.y]="outlineRect(marker).y"
                [attr.width]="outlineRect(marker).w"
                [attr.height]="outlineRect(marker).h"
                rx="3"
                stroke-dasharray="5 3"
                vector-effect="non-scaling-stroke"
              />
            }
            @case ('focused') {
              <rect
                data-minimap-marker="focused"
                class="semantic-marker marker-focused"
                [attr.x]="outlineRect(marker, focusedOutlineScale).x"
                [attr.y]="outlineRect(marker, focusedOutlineScale).y"
                [attr.width]="outlineRect(marker, focusedOutlineScale).w"
                [attr.height]="outlineRect(marker, focusedOutlineScale).h"
                rx="4"
                vector-effect="non-scaling-stroke"
              />
            }
            @case ('search') {
              <g data-minimap-marker="search" class="semantic-marker marker-search">
                <circle
                  [attr.cx]="marker.cx"
                  [attr.cy]="marker.cy"
                  [attr.r]="marker.size"
                  vector-effect="non-scaling-stroke"
                />
                <path [attr.d]="crosshairPath(marker)" vector-effect="non-scaling-stroke" />
              </g>
            }
          }
        }
      </g>

      <rect
        class="minimap-viewport"
        [attr.x]="viewportRect().x"
        [attr.y]="viewportRect().y"
        [attr.width]="viewportRect().w"
        [attr.height]="viewportRect().h"
        [attr.fill]="viewportFill"
        [attr.stroke]="viewportStroke"
        stroke-width="1.1"
        vector-effect="non-scaling-stroke"
        pointer-events="none"
      />
    </svg>

    @if (mobile) {
      <button
        data-testid="minimap-legend-trigger"
        type="button"
        class="mobile-legend-trigger"
        [attr.aria-expanded]="mobileLegendOpen()"
        aria-label="小地图图例"
        title="小地图图例"
        (click)="toggleMobileLegend()"
      >
        <svg viewBox="0 0 15 15" aria-hidden="true" focusable="false">
          <path d="M2.5 3h3M7.5 3h5M2.5 7.5h3M7.5 7.5h5M2.5 12h3M7.5 12h5" />
        </svg>
      </button>
      @if (mobileLegendOpen()) {
        <div class="minimap-legend-anchor minimap-legend-anchor-mobile">
          <app-flow-minimap-legend
            [visible]="true"
            [mobile]="true"
            [hiddenCategories]="hiddenCategories()"
            (categoryToggle)="toggleLegendCategory($event)"
          />
        </div>
      }
    } @else if (attentionLegendVisible()) {
      <div class="minimap-legend-anchor minimap-legend-anchor-desktop">
        <app-flow-minimap-legend
          [visible]="true"
          [hiddenCategories]="hiddenCategories()"
          (categoryToggle)="toggleLegendCategory($event)"
        />
      </div>
    }
  </div>
`;

export const FLOW_MINIMAP_STYLES = `
  :host {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
    --minimap-ink: #475569;
    --minimap-muted: #94a3b8;
    --minimap-sidecar: #b45309;
    --minimap-siyuan: #4f46e5;
    --minimap-docked: #0369a1;
    --minimap-parked: #b45309;
    --minimap-focused: #4338ca;
    --minimap-search: #0f766e;
    --minimap-lens-core: #818cf8;
    --minimap-lens-mid: #c7d2fe;
    --minimap-lens-core-opacity: 0.18;
    --minimap-lens-mid-opacity: 0.05;
    --minimap-node-fill: #6d7582;
    --minimap-link: #6f7885;
    --minimap-viewport-stroke: #6967d8;
    --minimap-viewport-active-stroke: #6967d8;
    --minimap-viewport-fill: none;
    --minimap-control-surface: rgba(239, 238, 233, 0.76);
    --minimap-control-border: rgba(94, 102, 114, 0.2);
  }
  .minimap-stage {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .minimap-svg {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    user-select: none;
    cursor: grab;
    border-radius: 8px;
  }
  .minimap-svg:active {
    cursor: grabbing;
  }
  .minimap-svg:focus-visible {
    outline: 2px solid #6366f1;
    outline-offset: 2px;
  }
  .attention-lens-stop-core {
    stop-color: var(--minimap-lens-core);
    stop-opacity: var(--minimap-lens-core-opacity);
  }
  .attention-lens-stop-mid {
    stop-color: var(--minimap-lens-mid);
    stop-opacity: var(--minimap-lens-mid-opacity);
  }
  .attention-lens-stop-edge {
    stop-color: var(--minimap-lens-mid);
    stop-opacity: 0;
  }
  .minimap-attention-lens {
    opacity: 0;
    transition: opacity 180ms ease;
  }
  .minimap-attention-active .minimap-attention-lens {
    opacity: 1;
  }
  .minimap-map-layer {
    opacity: 0.48;
    transition: opacity 180ms ease;
  }
  .minimap-attention-active .minimap-map-layer {
    opacity: 1;
  }
  .minimap-link {
    opacity: 0.35;
    stroke: var(--minimap-link);
  }
  .minimap-node-body {
    opacity: 1;
    fill: var(--minimap-node-fill);
    stroke-opacity: 1;
  }
  .minimap-attention-active .minimap-link { opacity: 0.44; }
  .semantic-marker {
    fill: none;
    stroke-width: 1.45;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .marker-sidecar { fill: var(--minimap-sidecar); stroke: var(--minimap-sidecar); }
  .marker-siyuan { stroke: var(--minimap-siyuan); }
  .marker-docked { stroke: var(--minimap-docked); }
  .marker-parked { stroke: var(--minimap-parked); stroke-width: 1.7; }
  .marker-focused { stroke: var(--minimap-focused); stroke-width: 1.7; }
  .marker-search { stroke: var(--minimap-search); stroke-width: 1.5; }
  .minimap-viewport {
    opacity: 0.72;
    fill: var(--minimap-viewport-fill);
    stroke: var(--minimap-viewport-stroke);
    filter: drop-shadow(0 0 1px rgba(99, 102, 241, 0.18));
    transition: opacity 180ms ease;
  }
  .minimap-attention-active .minimap-viewport {
    opacity: 0.55;
    stroke: var(--minimap-viewport-active-stroke);
  }
  .mobile-legend-trigger {
    position: absolute;
    right: 3px;
    bottom: 3px;
    z-index: 8;
    box-sizing: border-box;
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--minimap-ink);
    background: var(--minimap-control-surface);
    border: 1px solid var(--minimap-control-border);
    border-radius: 6px;
    cursor: pointer;
  }
  .mobile-legend-trigger svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
  }
  .mobile-legend-trigger:focus-visible {
    outline: 2px solid var(--minimap-search);
    outline-offset: 2px;
  }
  .minimap-legend-anchor {
    position: absolute;
    z-index: 16;
  }
  .minimap-legend-anchor-desktop {
    left: 8px;
    right: 8px;
    bottom: 8px;
    animation: minimap-legend-in 140ms ease-out both;
  }
  .minimap-legend-anchor-mobile {
    right: 0;
    bottom: calc(100% + 6px);
  }
  @keyframes minimap-legend-in {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }
  :host-context([data-color-mode='dark']) {
    --minimap-ink: #cbd5e1;
    --minimap-muted: #64748b;
    --minimap-sidecar: #fbbf24;
    --minimap-siyuan: #a5b4fc;
    --minimap-docked: #7dd3fc;
    --minimap-parked: #fbbf24;
    --minimap-focused: #c4b5fd;
    --minimap-search: #67e8f9;
    --minimap-lens-core: #67e8f9;
    --minimap-lens-mid: #6366f1;
    --minimap-lens-core-opacity: 0.24;
    --minimap-lens-mid-opacity: 0.06;
    --minimap-node-fill: #9ca4b3;
    --minimap-link: #9aa3b2;
    --minimap-viewport-stroke: #8e82ff;
    --minimap-viewport-active-stroke: #8e82ff;
    --minimap-viewport-fill: none;
    --minimap-control-surface: rgba(22, 25, 31, 0.76);
    --minimap-control-border: rgba(148, 163, 184, 0.3);
  }
  @media (prefers-reduced-motion: reduce) {
    .minimap-map-layer { transition: none; }
    .minimap-attention-lens { transition: none; }
    .minimap-viewport { transition: none; }
    .minimap-legend-anchor-desktop { animation: none; }
  }
`;

interface MinimapLegendItem {
  category: MinimapLegendCategory;
  label: string;
}

const LEGEND_ITEMS: readonly MinimapLegendItem[] = [
  { category: 'sidecar', label: '僚机' },
  { category: 'siyuan', label: '思源' },
  { category: 'docked', label: '入坞' },
  { category: 'parked', label: '停泊' },
  { category: 'focused', label: '专注' },
  { category: 'search', label: '搜索' },
];

@Component({
  selector: 'app-flow-minimap-legend',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible) {
      <section
        class="legend"
        [class.legend-mobile]="mobile"
        role="group"
        aria-label="小地图特别注意点筛选"
      >
        @for (item of items; track item.category) {
          <button
            type="button"
            class="legend-item"
            [class.legend-item-muted]="hiddenCategories.has(item.category)"
            [attr.data-minimap-legend-category]="item.category"
            [attr.aria-label]="item.label + '标记'"
            [attr.aria-pressed]="!hiddenCategories.has(item.category)"
            [attr.title]="item.label + '标记'"
            (click)="categoryToggle.emit(item.category)"
          >
            <svg viewBox="0 0 15 15" aria-hidden="true" focusable="false">
              @switch (item.category) {
                @case ('sidecar') {
                  <path d="M7.5 1.3 9 6l4.7 1.5L9 9l-1.5 4.7L6 9 1.3 7.5 6 6Z" />
                }
                @case ('siyuan') {
                  <path d="m7.5 2 5.5 5.5-5.5 5.5L2 7.5Z" />
                }
                @case ('docked') {
                  <path d="M5 2.5H2.5v10h10V10M8 2.5h4.5V7" />
                }
                @case ('parked') {
                  <rect x="2" y="2.5" width="11" height="10" rx="2" stroke-dasharray="3 2" />
                }
                @case ('focused') {
                  <circle cx="7.5" cy="7.5" r="5.2" />
                  <circle cx="7.5" cy="7.5" r="2.2" />
                }
                @case ('search') {
                  <circle cx="7.5" cy="7.5" r="3.4" />
                  <path d="M7.5 1v3M7.5 11v3M1 7.5h3M11 7.5h3" />
                }
              }
            </svg>
            <span>{{ item.label }}</span>
          </button>
        }
      </section>
    }
  `,
  styles: [`
    :host {
      display: contents;
      --legend-surface: rgba(21, 24, 32, 0.92);
      --legend-border: rgba(255, 255, 255, 0.12);
      --legend-ink: #d8dde6;
      --legend-muted: #7c8492;
      --legend-focus: #a99fff;
    }

    .legend {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      width: 100%;
      padding: 3px;
      color: var(--legend-ink);
      background: var(--legend-surface);
      border: 1px solid var(--legend-border);
      border-radius: 10px;
      box-shadow: none;
      backdrop-filter: blur(12px);
    }

    .legend-mobile {
      display: grid;
      width: 156px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2px;
      padding: 5px;
      border-radius: 8px;
    }

    .legend-item {
      box-sizing: border-box;
      width: 24px;
      min-width: 24px;
      min-height: 24px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 5px;
      color: inherit;
      background: transparent;
      font: 500 10px/1.2 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.01em;
      cursor: pointer;
    }

    .legend:not(.legend-mobile) .legend-item span {
      display: none;
    }

    .legend-mobile .legend-item {
      width: auto;
      min-width: 0;
      padding: 2px 4px;
      justify-content: flex-start;
      gap: 3px;
    }

    .legend-mobile .legend-item span {
      display: inline;
      white-space: nowrap;
    }

    .legend-item[data-minimap-legend-category='sidecar'] { color: #e2aa63; }
    .legend-item[data-minimap-legend-category='siyuan'] { color: #a393ff; }
    .legend-item[data-minimap-legend-category='docked'] { color: #58d6c7; }
    .legend-item[data-minimap-legend-category='parked'] { color: #e6a65c; }
    .legend-item[data-minimap-legend-category='focused'] { color: #b8a9ff; }
    .legend-item[data-minimap-legend-category='search'] { color: #58d6c7; }

    .legend-item:hover {
      color: var(--legend-focus);
      background: rgba(141, 130, 255, 0.14);
    }

    .legend-item:focus-visible {
      outline: 2px solid var(--legend-focus);
      outline-offset: 1px;
    }

    .legend-item-muted {
      color: var(--legend-muted);
      opacity: 0.42;
    }

    .legend-mobile .legend-item-muted {
      text-decoration: line-through;
      text-decoration-thickness: 1px;
    }

    svg {
      width: 15px;
      height: 15px;
      flex: 0 0 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.35;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    :host-context([data-color-mode='dark']) {
      --legend-surface: rgba(8, 10, 14, 0.92);
      --legend-border: rgba(148, 163, 184, 0.28);
      --legend-ink: #dce1ea;
      --legend-muted: #747d8c;
      --legend-focus: #a99fff;
    }

    :host-context([data-color-mode='dark']) .legend-item[data-minimap-legend-category='sidecar'] { color: #fbbf24; }
    :host-context([data-color-mode='dark']) .legend-item[data-minimap-legend-category='siyuan'] { color: #a5b4fc; }
    :host-context([data-color-mode='dark']) .legend-item[data-minimap-legend-category='docked'] { color: #7dd3fc; }
    :host-context([data-color-mode='dark']) .legend-item[data-minimap-legend-category='parked'] { color: #f59e0b; }
    :host-context([data-color-mode='dark']) .legend-item[data-minimap-legend-category='focused'] { color: #c4b5fd; }
    :host-context([data-color-mode='dark']) .legend-item[data-minimap-legend-category='search'] { color: #67e8f9; }

    @media (prefers-reduced-motion: reduce) {
      .legend-item { transition: none; }
    }
  `],
})
export class FlowMinimapLegendComponent {
  @Input() visible = false;
  @Input() mobile = false;
  @Input() hiddenCategories: ReadonlySet<MinimapLegendCategory> = new Set();
  @Output() readonly categoryToggle = new EventEmitter<MinimapLegendCategory>();
  readonly items = LEGEND_ITEMS;
}
