import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  inject,
} from '@angular/core';
import * as go from 'gojs';

import { FlowDiagramService } from '../services/flow-diagram.service';
import {
  FALLBACK_MAX_SCALE,
  FALLBACK_MIN_SCALE,
  MINIMAP_KEYBOARD_PAN_PX,
  MINIMAP_KEYBOARD_ZOOM_FACTOR,
  MINIMAP_ZOOM_STEP,
} from './flow-minimap-geometry';
import { FlowMinimapComponent } from './flow-minimap.component';

@Component({
  selector: 'app-flow-overview-panel',
  standalone: true,
  imports: [FlowMinimapComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      data-testid="flow-overview-panel"
      class="overview-panel"
      [class.overview-panel-collapsed]="collapsed"
      [class.overview-panel-mobile]="mobile"
      [style.right.px]="mobile ? 8 : 16"
      [style.bottom.px]="mobile ? 8 : 16"
      [style.width.px]="panelWidth"
      [style.height.px]="panelHeight"
    >
      @if (!collapsed) {
        <div class="overview-content">
          @if (useSvgMinimap) {
            <app-flow-minimap
              [width]="expandedWidth"
              [height]="expandedHeight"
              [mobile]="mobile"
            />
          } @else {
            <div
              #legacyOverviewHost
              data-testid="flow-legacy-overview-host"
              class="legacy-overview-host"
              role="application"
              tabindex="0"
              aria-label="流程图旧版小地图（拖动平移，滚轮缩放，方向键平移，+/- 缩放）"
              (wheel)="onLegacyWheel($event)"
              (keydown)="onLegacyKeyDown($event)"
            ></div>
          }
        </div>
      }

      <button
        data-testid="flow-overview-toggle"
        type="button"
        class="overview-toggle"
        [class.mobile-control]="mobile"
        [attr.aria-expanded]="!collapsed"
        [attr.aria-label]="collapsed ? '展开小地图' : '折叠小地图'"
        [title]="collapsed ? '展开小地图' : '折叠小地图'"
        (pointerdown)="onTogglePointerDown($event)"
        (click)="onToggleClick($event)"
      >
        <svg viewBox="0 0 15 15" aria-hidden="true" focusable="false">
          @if (collapsed) {
            <path d="M5.5 2.5h-3v3M2.5 2.5 6 6m3.5-3.5h3v3m0-3L9 6M5.5 12.5h-3v-3m0 3L6 9m3.5 3.5h3v-3m0 3L9 9" />
          } @else {
            <path d="M3 7.5h9" />
          }
        </svg>
      </button>
    </div>
  `,
  styles: [`
    :host {
      display: contents;
      --overview-surface: #efeee9;
      --overview-border: #dad8d0;
      --overview-control-surface: rgba(239, 238, 233, 0.76);
      --overview-control-hover: rgba(255, 255, 255, 0.72);
      --overview-control-ink: #5e6672;
      --overview-focus: #6366f1;
    }

    .overview-panel {
      position: absolute;
      z-index: 20;
      box-sizing: border-box;
      overflow: visible;
      pointer-events: auto;
      color: var(--overview-control-ink);
      background: var(--overview-surface);
      border: 1px solid var(--overview-border);
      border-radius: 15px;
      box-shadow: inset 0 1px rgba(255, 255, 255, 0.28), 0 10px 30px rgba(15, 23, 42, 0.08);
      user-select: none;
      transition: opacity 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
    }

    .overview-panel-collapsed {
      opacity: 0.46;
    }

    .overview-panel-collapsed:hover,
    .overview-panel-collapsed:focus-within {
      opacity: 1;
    }

    .overview-content,
    .legacy-overview-host {
      position: relative;
      width: 100%;
      height: 100%;
    }

    .legacy-overview-host {
      z-index: 0;
      overflow: hidden;
      border-radius: 14px;
    }

    .legacy-overview-host:focus-visible {
      outline: 2px solid var(--overview-focus);
      outline-offset: 2px;
    }

    .overview-toggle {
      position: absolute;
      top: 3px;
      right: 3px;
      z-index: 12;
      box-sizing: border-box;
      width: 24px;
      height: 24px;
      min-width: 24px;
      min-height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      color: var(--overview-control-ink);
      background: var(--overview-control-surface);
      border: 1px solid var(--overview-border);
      border-radius: 6px;
      opacity: 0.42;
      cursor: pointer;
      transition: opacity 160ms ease, color 160ms ease, background 160ms ease;
    }

    .overview-panel:hover .overview-toggle,
    .overview-panel:focus-within .overview-toggle,
    .overview-toggle:hover {
      opacity: 0.92;
      color: var(--overview-focus);
      background: var(--overview-control-hover);
    }

    .overview-toggle:focus-visible {
      outline: 2px solid var(--overview-focus);
      outline-offset: 2px;
    }

    .overview-toggle svg {
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.4;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .overview-panel-collapsed .overview-toggle {
      inset: 1px;
    }

    :host-context([data-color-mode='dark']) {
      --overview-surface: #16191f;
      --overview-border: #303640;
      --overview-control-surface: rgba(22, 25, 31, 0.76);
      --overview-control-hover: rgba(48, 54, 64, 0.72);
      --overview-control-ink: #c0c7d2;
      --overview-focus: #8e82ff;
    }

    @media (prefers-reduced-motion: reduce) {
      .overview-panel { transition: none; }
    }
  `],
})
export class FlowOverviewPanelComponent {
  @Input() collapsed = false;
  @Input() mobile = false;
  @Input() useSvgMinimap = true;
  @Output() readonly collapseToggle = new EventEmitter<void>();
  @Output() readonly legacyOverviewHostChange = new EventEmitter<ElementRef<HTMLDivElement> | undefined>();

  private readonly diagram = inject(FlowDiagramService);
  private legacyHost: ElementRef<HTMLDivElement> | undefined;

  @ViewChild('legacyOverviewHost')
  set legacyOverviewHost(host: ElementRef<HTMLDivElement> | undefined) {
    if (this.legacyHost?.nativeElement === host?.nativeElement) return;
    this.legacyHost = host;
    this.legacyOverviewHostChange.emit(host);
  }

  get expandedWidth(): number {
    return this.mobile ? 100 : 180;
  }

  get expandedHeight(): number {
    return this.mobile ? 80 : 140;
  }

  get panelWidth(): number {
    return this.collapsed ? (this.mobile ? 24 : 28) : this.expandedWidth;
  }

  get panelHeight(): number {
    return this.collapsed ? (this.mobile ? 24 : 28) : this.expandedHeight;
  }

  onTogglePointerDown(event: PointerEvent): void {
    event.stopPropagation();
  }

  onToggleClick(event: MouseEvent): void {
    event.stopPropagation();
    this.collapseToggle.emit();
  }

  onLegacyKeyDown(event: KeyboardEvent): void {
    if (this.useSvgMinimap || this.collapsed) return;
    const diagram = this.diagram.diagramInstance;
    if (!diagram) return;

    const viewport = diagram.viewportBounds;
    const panWorld = viewport.isReal()
      ? Math.max(1, viewport.width * 0.1)
      : MINIMAP_KEYBOARD_PAN_PX;
    const position = diagram.position;

    switch (event.key) {
      case 'ArrowLeft':
        diagram.position = new go.Point(position.x - panWorld, position.y);
        break;
      case 'ArrowRight':
        diagram.position = new go.Point(position.x + panWorld, position.y);
        break;
      case 'ArrowUp':
        diagram.position = new go.Point(position.x, position.y - panWorld);
        break;
      case 'ArrowDown':
        diagram.position = new go.Point(position.x, position.y + panWorld);
        break;
      case '+':
      case '=':
        this.zoomLegacyDiagram(diagram, MINIMAP_KEYBOARD_ZOOM_FACTOR);
        break;
      case '-':
      case '_':
        this.zoomLegacyDiagram(diagram, 1 / MINIMAP_KEYBOARD_ZOOM_FACTOR);
        break;
      default:
        return;
    }

    event.preventDefault();
  }

  onLegacyWheel(event: WheelEvent): void {
    if (this.useSvgMinimap || this.collapsed) return;
    const diagram = this.diagram.diagramInstance;
    if (!diagram) return;

    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 0.05
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? 1
        : 0.002;
    const factor = Math.pow(2, -event.deltaY * unit * MINIMAP_ZOOM_STEP);
    this.zoomLegacyDiagram(diagram, factor);
  }

  private zoomLegacyDiagram(diagram: go.Diagram, factor: number): void {
    const viewportBefore = diagram.viewportBounds;
    if (!viewportBefore.isReal()) return;

    const oldScale = Number.isFinite(diagram.scale) && diagram.scale > 0 ? diagram.scale : 1;
    const minScale = Number.isFinite(diagram.minScale) && diagram.minScale > 0
      ? diagram.minScale
      : FALLBACK_MIN_SCALE;
    const maxScale = Number.isFinite(diagram.maxScale) && diagram.maxScale > 0
      ? diagram.maxScale
      : FALLBACK_MAX_SCALE;
    const nextScale = Math.max(minScale, Math.min(maxScale, oldScale * factor));
    if (Math.abs(nextScale - oldScale) < 1e-6) return;

    const centerX = viewportBefore.x + viewportBefore.width / 2;
    const centerY = viewportBefore.y + viewportBefore.height / 2;
    diagram.scale = nextScale;
    const viewportAfter = diagram.viewportBounds;
    if (viewportAfter.isReal()) {
      diagram.position = new go.Point(
        centerX - viewportAfter.width / 2,
        centerY - viewportAfter.height / 2,
      );
    }
  }
}
