/**
 * FlowMinimapComponent —— SVG 自绘小地图，替代 GoJS go.Overview。
 *
 * 设计目标（详见 .copilot-tracking/plans/20260606-svg-minimap-replacement-plan.md）：
 * - 几何映射对标商用 React Flow MiniMap：viewBox 直接采用世界坐标，浏览器负责缩放，
 *   零手动 scale → 根治「边缘拖动抖动」；viewBox 是「当前 state 的纯函数」无历史缓存
 *   → 根治「minimap↔主图切换瞬移」。
 * - 全元素呈现：节点 rect（familyColor 填充）+ 连线（父子实线/跨树虚线）+ 装饰 pip
 *   （僚机/思源/入坞）+ 状态色（停泊/搜索/专注）。
 * - 拖动期冻结映射，防止「viewBox 含视口 → 拖动正反馈发散」的历史回归。
 */
import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  Input,
  NgZone,
  AfterViewInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';

import { FlowDiagramService } from '../services/flow-diagram.service';
import { FlowDiagramConfigService } from '../services/flow-diagram-config.service';
import { LoggerService } from '../../../../services/logger.service';
import * as go from 'gojs';
import {
  cancelMinimapFrame,
  computeViewBox,
  FALLBACK_MAX_SCALE,
  FALLBACK_MIN_SCALE,
  FALLBACK_WORLD,
  MINIMAP_KEYBOARD_PAN_PX,
  MINIMAP_KEYBOARD_ZOOM_FACTOR,
  MINIMAP_FOCUSED_OUTLINE_SCALE,
  MINIMAP_PARKED_OUTLINE_SCALE,
  MINIMAP_REBIND_INTERVAL_MS,
  MINIMAP_SEARCH_CROSSHAIR_SCALE,
  MINIMAP_ZOOM_STEP,
  requestMinimapFrame,
  unionWorldRect,
  VIEWPORT_FILL,
  VIEWPORT_STROKE,
  filterMinimapSemanticMarkers,
  toggleMinimapLegendCategory,
  type MinimapFrameHandle,
  type MinimapLegendCategory,
  type MinimapPip,
  type MinimapSemanticMarker,
  type MinimapWorldRect,
} from './flow-minimap-geometry';
import {
  collectMinimapLinks,
  collectMinimapNodeSnapshot,
  type MinimapLinkShape,
  type MinimapNodeShape,
} from './flow-minimap-snapshot.helpers';
import {
  FlowMinimapAttentionController,
  projectMinimapAttentionPoint,
  type MinimapAttentionPoint,
} from './flow-minimap-attention.controller';
import {
  FLOW_MINIMAP_STYLES,
  FLOW_MINIMAP_TEMPLATE,
  FlowMinimapLegendComponent,
} from './flow-minimap-legend.component';

let nextMinimapAttentionId = 1;

export {
  buildDecorationPips,
  computeViewBox,
  resolveNodeFill,
  resolveNodeStroke,
  resolveNodeStrokeWidth,
  unionWorldRect,
  type MinimapNodeData,
  type MinimapPip,
  type MinimapWorldRect,
} from './flow-minimap-geometry';

@Component({
  selector: 'app-flow-minimap',
  standalone: true,
  imports: [FlowMinimapLegendComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: FLOW_MINIMAP_TEMPLATE,
  styles: [FLOW_MINIMAP_STYLES],
})
export class FlowMinimapComponent implements AfterViewInit, OnDestroy {
  /** SVG 显示尺寸（px），同时作为 viewBox 宽高比基准。桌面 180×140 / 移动 100×80。 */
  private readonly widthInput = signal(180);
  private readonly heightInput = signal(140);
  private readonly showLinksInput = signal(true);
  private readonly showDecorationPipsInput = signal(true);

  @Input()
  set width(value: number) { this.widthInput.set(value); }
  get width(): number { return this.widthInput(); }
  @Input()
  set height(value: number) { this.heightInput.set(value); }
  get height(): number { return this.heightInput(); }

  @Input() mobile = false;
  /** 是否绘制连线（关联块），默认开。 */
  @Input()
  set showLinks(value: boolean) { this.showLinksInput.set(value); }
  get showLinks(): boolean { return this.showLinksInput(); }
  /** 是否绘制装饰 pip（僚机/思源/入坞），默认开。 */
  @Input()
  set showDecorationPips(value: boolean) { this.showDecorationPipsInput.set(value); }
  get showDecorationPips(): boolean { return this.showDecorationPipsInput(); }
  readonly viewportStroke = VIEWPORT_STROKE;
  readonly viewportFill = VIEWPORT_FILL;
  readonly focusedOutlineScale = MINIMAP_FOCUSED_OUTLINE_SCALE;
  private readonly diagram = inject(FlowDiagramService);
  private readonly config = inject(FlowDiagramConfigService);
  private readonly zone = inject(NgZone);
  private readonly host = inject(ElementRef);
  private readonly logger = inject(LoggerService).category('FlowMinimap');
  // ===== 渲染快照 signals =====
  private readonly nodeShapesSig = signal<MinimapNodeShape[]>([]);
  private readonly linkShapesSig = signal<MinimapLinkShape[]>([]);
  private readonly pipShapesSig = signal<MinimapPip[]>([]);
  private readonly semanticMarkerShapesSig = signal<MinimapSemanticMarker[]>([]);
  private readonly nodesBounds = signal<MinimapWorldRect | null>(null);
  private readonly viewport = signal<MinimapWorldRect | null>(null);
  readonly nodeShapes = this.nodeShapesSig.asReadonly();
  readonly linkShapes = this.linkShapesSig.asReadonly();
  readonly pipShapes = this.pipShapesSig.asReadonly();
  readonly semanticMarkerShapes = this.semanticMarkerShapesSig.asReadonly();
  readonly hiddenCategories = signal<ReadonlySet<MinimapLegendCategory>>(new Set());
  readonly visibleSemanticMarkers = computed(() => (
    filterMinimapSemanticMarkers(this.semanticMarkerShapes(), this.hiddenCategories())
  ));
  readonly attentionLens = signal<MinimapAttentionPoint | null>(null);
  readonly attentionActive = signal(false);
  readonly attentionLegendVisible = signal(false);
  readonly mobileLegendOpen = signal(false);
  readonly attentionGradientId = `flow-minimap-attention-gradient-${nextMinimapAttentionId}`;
  readonly attentionMaskId = `flow-minimap-attention-mask-${nextMinimapAttentionId++}`;
  readonly attentionLensGradientId = `${this.attentionGradientId}-lens`;
  readonly attentionGradientFill = `url(#${this.attentionGradientId})`;
  readonly attentionMaskFill = `url(#${this.attentionMaskId})`;
  readonly attentionLensGradientFill = `url(#${this.attentionLensGradientId})`;
  private readonly attention = new FlowMinimapAttentionController({
    setLens: point => this.attentionLens.set(point),
    setActive: active => this.attentionActive.set(active),
    setLegendVisible: visible => this.attentionLegendVisible.set(visible),
  });
  /**
   * viewBox 世界矩形 = computeViewBox(nodes ∪ viewport)，**实时**（对齐 React Flow）。
   * 拖动预览框使 viewport 移出节点群 → union 扩大 → viewBox 放大 → 预览框自动缩小（自动放缩✓）。
   * 平移主图 → viewport 移动 → 预览框在小地图里移动；缩放主图 → 预览框尺寸变化。
   * SVG 实时 union 无 GoJS smartLerp，故连续放缩平滑、不抖动、无历史缓存瞬移。
   */
  readonly viewBox = computed<MinimapWorldRect>(() => {
    const bounding = unionWorldRect(this.nodesBounds(), this.viewport()) ?? FALLBACK_WORLD;
    return computeViewBox(bounding, this.widthInput(), this.heightInput());
  });
  readonly viewBoxStr = computed<string>(() => {
    const v = this.viewBox();
    return `${v.x} ${v.y} ${v.w} ${v.h}`;
  });
  /** 预览框世界矩形 = 真实主图视口（union 保证 viewport ⊆ viewBox，无需 clamp）。 */
  readonly viewportRect = computed<MinimapWorldRect>(() => this.viewport() ?? FALLBACK_WORLD);

  readonly attentionGradient = computed(() => {
    const view = this.viewBox();
    const lens = this.attentionLens() ?? { x: 0.5, y: 0.5 };
    return {
      cx: view.x + view.w * lens.x,
      cy: view.y + view.h * lens.y,
      r: Math.max(view.w, view.h) * 0.62,
    };
  });

  /** evenodd 遮罩：外框（viewBox 外扩一圈）减去视口孔 → 框外暗化。 */
  readonly maskPath = computed<string>(() => {
    const v = this.viewBox();
    const vp = this.viewportRect();
    const pad = v.w * 0.05;
    const ox = v.x - pad;
    const oy = v.y - pad;
    const ow = v.w + pad * 2;
    const oh = v.h + pad * 2;
    const outer = `M${ox},${oy} h${ow} v${oh} h${-ow} z`;
    const hole = `M${vp.x},${vp.y} h${vp.w} v${vp.h} h${-vp.w} z`;
    return `${outer} ${hole}`;
  });

  // ===== 运行时状态 =====
  private svgEl: SVGSVGElement | null = null;
  private destroyed = false;
  private dragging = false;
  private dragPointerId: number | null = null;
  /** 拖动起始冻结的「世界单位/屏幕像素」比例，拖动期恒定 → 1:1 跟手、防 viewBox 抽动发散。 */
  private dragWorldPerPixel = 1;
  /** 上一次已应用的 client 坐标（增量平移基准）。 */
  private lastClientX = 0;
  private lastClientY = 0;
  /** 本帧待应用的最新 client 坐标（rAF 合流，避免 120Hz 同步刷主图卡手）。 */
  private pendingClientX = 0;
  private pendingClientY = 0;
  private dragRafId: MinimapFrameHandle | null = null;
  private vpRaf: MinimapFrameHandle | null = null;
  private rebuildRaf: MinimapFrameHandle | null = null;
  private viewportHandler: ((e: go.DiagramEvent) => void) | null = null;
  private documentHandler: ((e: go.DiagramEvent) => void) | null = null;
  private modelHandler: ((e: go.ChangedEvent) => void) | null = null;
  private windowPointerMoveHandler: ((e: PointerEvent) => void) | null = null;
  private windowPointerUpHandler: ((e: PointerEvent) => void) | null = null;
  private windowPointerCancelHandler: ((e: PointerEvent) => void) | null = null;
  /**
   * 已绑定监听的 diagram 实例。GoJS 硬恢复（teardownDiagramForRecovery → 原地重建）会替换
   * diagramInstance，必须按「绑定时的实例」解绑，重取当前实例会解错对象 → 旧实例监听泄漏。
   */
  private boundDiagram: go.Diagram | null = null;
  /** 就绪/重绑看门狗句柄（低频 setInterval 心跳）。 */
  private rebindIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 主题切换 / 开关变化 → 颜色或可见性变 → 重建快照。
    // currentStyles() 依赖 themeService.theme()，故主题切换会触发本 effect。
    effect(() => {
      this.config.currentStyles();
      this.showLinksInput();
      this.showDecorationPipsInput();
      if (!this.destroyed) this.scheduleRebuild();
    });
  }

  ngAfterViewInit(): void {
    this.svgEl = this.host.nativeElement.querySelector('svg');
    this.startRebindWatch();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.attention.destroy();
    this.hiddenCategories.set(new Set());
    this.mobileLegendOpen.set(false);
    if (this.dragging && this.dragPointerId !== null) {
      this.cancelDrag(this.dragPointerId);
    } else {
      this.dragging = false;
      this.dragPointerId = null;
    }
    if (this.rebindIntervalId !== null) clearInterval(this.rebindIntervalId);
    if (this.vpRaf !== null) cancelMinimapFrame(this.vpRaf);
    if (this.rebuildRaf !== null) cancelMinimapFrame(this.rebuildRaf);
    if (this.dragRafId !== null) cancelMinimapFrame(this.dragRafId);
    this.removeWindowDragListeners();
    // 按「绑定时的实例」解绑——硬恢复可能已替换 diagramInstance，重取当前实例会解错对象致泄漏。
    if (this.boundDiagram) this.detachFrom(this.boundDiagram);
  }

  // ===================== 就绪门控 + 监听绑定（实例感知看门狗） =====================

  /**
   * 就绪/重绑看门狗：低频轮询当前 diagram 实例。
   * 旧 pollReady 是「一次性绑定 + 超时即永久放弃」，两处缺陷：
   * ① 超时（~5s）后 diagram 才就绪 → 小地图永久空白，无重试；
   * ② GoJS 硬恢复会原地重建 diagram 实例（teardownDiagramForRecovery 置 null 后重新 $(go.Diagram)），
   *    旧监听仍挂在已废弃实例上 → 小地图冻结。
   * 本心跳持续比对「当前实例 vs 已绑定实例」，不一致即解绑旧、绑定新，覆盖首次就绪与硬恢复两种场景。
   * 跑在 Angular zone 外（仅引用比较），仅命中变化时才进入 zone.run 刷 signal，避免每跳触发 CD。
   */
  private startRebindWatch(): void {
    this.syncBinding();
    this.zone.runOutsideAngular(() => {
      this.rebindIntervalId = setInterval(() => this.syncBinding(), MINIMAP_REBIND_INTERVAL_MS);
    });
  }

  /** 比对当前实例与已绑定实例，必要时解绑旧实例、绑定新实例。 */
  private syncBinding(): void {
    if (this.destroyed) return;
    const current = this.diagram.isInitialized ? this.diagram.diagramInstance : null;
    if (current === this.boundDiagram) return;
    const hadBinding = this.boundDiagram !== null;
    if (this.boundDiagram) this.detachFrom(this.boundDiagram);
    if (current) {
      this.attachTo(current);
      if (hadBinding) this.logger.debug('minimap 检测到 diagram 实例替换，已重绑（GoJS 硬恢复）');
    }
  }

  private attachTo(diagram: go.Diagram): void {
    this.viewportHandler = () => this.onViewportChanged();
    this.documentHandler = () => this.scheduleRebuild();
    this.modelHandler = () => this.scheduleRebuild();
    diagram.addDiagramListener('ViewportBoundsChanged', this.viewportHandler);
    diagram.addDiagramListener('DocumentBoundsChanged', this.documentHandler);
    diagram.addDiagramListener('LayoutCompleted', this.documentHandler);
    diagram.addModelChangedListener(this.modelHandler);
    this.boundDiagram = diagram;
    this.syncViewportNow(diagram);
    this.rebuildSnapshot();
  }

  private detachFrom(diagram: go.Diagram): void {
    if (this.viewportHandler) {
      this.removeDiagramListenerSafely(diagram, 'ViewportBoundsChanged', this.viewportHandler);
    }
    if (this.documentHandler) {
      this.removeDiagramListenerSafely(diagram, 'DocumentBoundsChanged', this.documentHandler);
      this.removeDiagramListenerSafely(diagram, 'LayoutCompleted', this.documentHandler);
    }
    if (this.modelHandler) {
      this.removeModelChangedListenerSafely(diagram, this.modelHandler);
    }
    this.viewportHandler = null;
    this.documentHandler = null;
    this.modelHandler = null;
    this.boundDiagram = null;
  }

  private removeDiagramListenerSafely(
    diagram: go.Diagram,
    name: go.DiagramEventName,
    listener: (event: go.DiagramEvent) => void
  ): void {
    try {
      diagram.removeDiagramListener(name, listener);
    } catch (error) {
      this.logger.warn('minimap 解绑 GoJS diagram listener 失败，继续清理本地状态', { name, error });
    }
  }

  private removeModelChangedListenerSafely(
    diagram: go.Diagram,
    listener: (event: go.ChangedEvent) => void
  ): void {
    try {
      diagram.removeModelChangedListener(listener);
    } catch (error) {
      this.logger.warn('minimap 解绑 GoJS model listener 失败，继续清理本地状态', { error });
    }
  }

  // ===================== 被动同步（zone 外触发，必须 zone.run） =====================

  private onViewportChanged(): void {
    if (this.dragging) return; // 拖动时由 onPointerMove 乐观更新 viewport signal
    if (this.vpRaf !== null) return;
    this.vpRaf = requestMinimapFrame(() => {
      this.vpRaf = null;
      const diagram = this.diagram.diagramInstance;
      if (this.destroyed || !diagram) return;
      this.syncViewportNow(diagram);
    });
  }

  private syncViewportNow(diagram: go.Diagram): void {
    const vb = diagram.viewportBounds;
    if (!vb.isReal()) return;
    const rect: MinimapWorldRect = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    this.zone.run(() => this.viewport.set(rect));
  }

  private scheduleRebuild(): void {
    if (this.rebuildRaf !== null) return;
    this.rebuildRaf = requestMinimapFrame(() => {
      this.rebuildRaf = null;
      if (!this.destroyed) this.rebuildSnapshot();
    });
  }

  // ===================== 快照重建（节点 / 连线 / pip） =====================

  private rebuildSnapshot(): void {
    const diagram = this.diagram.diagramInstance;
    if (!diagram) return;
    const { shapes, pips, markers, bounds } = collectMinimapNodeSnapshot(diagram, {
      showDecorationPips: this.showDecorationPips,
    });
    const links = this.showLinks
      ? collectMinimapLinks(diagram, this.config.currentStyles().link)
      : [];
    this.zone.run(() => {
      this.nodeShapesSig.set(shapes);
      this.linkShapesSig.set(links);
      this.pipShapesSig.set(pips);
      this.semanticMarkerShapesSig.set(markers);
      this.nodesBounds.set(bounds);
    });
  }

  // ===================== Constellation 注意力与图例 =====================

  onAttentionPointerEnter(): void {
    this.attention.pointerEntered();
  }

  onAttentionPointerLeave(): void {
    this.attention.pointerLeft();
  }

  onAttentionFocus(): void {
    this.attention.focused();
  }

  onAttentionFocusOut(event: FocusEvent): void {
    const stage = event.currentTarget;
    const next = event.relatedTarget;
    if (stage instanceof Node && next instanceof Node && stage.contains(next)) return;
    this.attention.blurred();
  }

  toggleLegendCategory(category: MinimapLegendCategory): void {
    const next = toggleMinimapLegendCategory(this.hiddenCategories(), category);
    this.hiddenCategories.set(next);
    this.attention.setLegendPinned(next.size > 0 || this.mobileLegendOpen());
  }

  toggleMobileLegend(): void {
    const next = !this.mobileLegendOpen();
    this.mobileLegendOpen.set(next);
    this.attention.setLegendPinned(next || this.hiddenCategories().size > 0);
  }

  starPath(marker: MinimapSemanticMarker): string {
    const { cx, cy, size } = marker;
    const inner = size * 0.34;
    return [
      `M${cx},${cy - size}`,
      `L${cx + inner},${cy - inner}`,
      `L${cx + size},${cy}`,
      `L${cx + inner},${cy + inner}`,
      `L${cx},${cy + size}`,
      `L${cx - inner},${cy + inner}`,
      `L${cx - size},${cy}`,
      `L${cx - inner},${cy - inner}`,
      'Z',
    ].join(' ');
  }

  diamondPath(marker: MinimapSemanticMarker): string {
    const { cx, cy, size } = marker;
    return `M${cx},${cy - size} L${cx + size},${cy} L${cx},${cy + size} L${cx - size},${cy} Z`;
  }

  openSquarePath(marker: MinimapSemanticMarker): string {
    const { cx, cy, size } = marker;
    const right = cx + size;
    return [
      `M${right},${cy - size}`,
      `H${cx - size}`,
      `V${cy + size}`,
      `H${right}`,
      `V${cy + size * 0.25}`,
    ].join(' ');
  }

  crosshairPath(marker: MinimapSemanticMarker): string {
    const { cx, cy, size } = marker;
    const outer = size * MINIMAP_SEARCH_CROSSHAIR_SCALE;
    return [
      `M${cx},${cy - outer} V${cy - size}`,
      `M${cx},${cy + size} V${cy + outer}`,
      `M${cx - outer},${cy} H${cx - size}`,
      `M${cx + size},${cy} H${cx + outer}`,
    ].join(' ');
  }

  outlineRect(
    marker: MinimapSemanticMarker,
    scale = MINIMAP_PARKED_OUTLINE_SCALE,
  ): MinimapWorldRect {
    const pad = marker.size * scale;
    return {
      x: marker.x - pad,
      y: marker.y - pad,
      w: marker.w + pad * 2,
      h: marker.h + pad * 2,
    };
  }

  private updateAttentionFromClientPoint(
    event: Pick<PointerEvent | WheelEvent, 'clientX' | 'clientY'>,
    marksPointerInside: boolean,
  ): void {
    if (!this.svgEl) return;
    const point = projectMinimapAttentionPoint(
      event.clientX,
      event.clientY,
      this.svgEl.getBoundingClientRect(),
    );
    if (!point) return;
    if (marksPointerInside) this.attention.pointerMoved(point);
    else this.attention.interacted(point);
  }

  // ===================== 指针交互（对齐 React Flow MiniMap：相对拖动平移 + 滚轮缩放） =====================

  onKeyDown(ev: KeyboardEvent): void {
    const diagram = this.diagram.diagramInstance;
    if (!diagram) return;

    const panWorld = this.keyboardPanWorldDelta(diagram);
    let handled = true;

    switch (ev.key) {
      case 'ArrowLeft':
        this.panDiagram(diagram, -panWorld, 0);
        break;
      case 'ArrowRight':
        this.panDiagram(diagram, panWorld, 0);
        break;
      case 'ArrowUp':
        this.panDiagram(diagram, 0, -panWorld);
        break;
      case 'ArrowDown':
        this.panDiagram(diagram, 0, panWorld);
        break;
      case '+':
      case '=':
        this.zoomDiagramAroundViewportCenter(diagram, MINIMAP_KEYBOARD_ZOOM_FACTOR);
        break;
      case '-':
      case '_':
        this.zoomDiagramAroundViewportCenter(diagram, 1 / MINIMAP_KEYBOARD_ZOOM_FACTOR);
        break;
      default:
        handled = false;
        break;
    }

    if (handled) {
      this.attention.interacted({ x: 0.5, y: 0.5 });
      ev.preventDefault();
    }
  }

  private keyboardPanWorldDelta(diagram: go.Diagram): number {
    const worldPerPixel = this.screenToWorldScale();
    if (worldPerPixel !== null) {
      return MINIMAP_KEYBOARD_PAN_PX * worldPerPixel;
    }

    const viewportBounds = diagram.viewportBounds;
    return viewportBounds.isReal()
      ? Math.max(1, viewportBounds.width * 0.1)
      : MINIMAP_KEYBOARD_PAN_PX;
  }

  private panDiagram(diagram: go.Diagram, dx: number, dy: number): void {
    const pos = diagram.position;
    diagram.position = new go.Point(pos.x + dx, pos.y + dy);
    this.syncViewportNow(diagram);
  }

  private zoomDiagramAroundViewportCenter(diagram: go.Diagram, factor: number): void {
    const vbBefore = diagram.viewportBounds;
    if (!vbBefore.isReal()) return;

    const minS =
      Number.isFinite(diagram.minScale) && diagram.minScale > 0 ? diagram.minScale : FALLBACK_MIN_SCALE;
    const maxS =
      Number.isFinite(diagram.maxScale) && diagram.maxScale > 0 ? diagram.maxScale : FALLBACK_MAX_SCALE;
    const oldScale = diagram.scale;
    const newScale = Math.max(minS, Math.min(maxS, oldScale * factor));
    if (Math.abs(newScale - oldScale) < 1e-6) return;

    const center = {
      x: vbBefore.x + vbBefore.width / 2,
      y: vbBefore.y + vbBefore.height / 2,
    };
    diagram.scale = newScale;
    const vbAfter = diagram.viewportBounds;
    if (vbAfter.isReal()) {
      diagram.position = new go.Point(center.x - vbAfter.width / 2, center.y - vbAfter.height / 2);
    }
    this.syncViewportNow(diagram);
  }

  /**
   * pointerdown：开始相对拖动。对齐 React Flow `pannable` —— **按下不跳**，
   * 仅记录起点 client 坐标，后续 move 按增量 delta 平移。
   */
  onPointerDown(ev: PointerEvent): void {
    if (this.destroyed) return;
    if (ev.button !== 0 || (ev.isPrimary === false && ev.pointerType !== '')) return;
    const diagram = this.diagram.diagramInstance;
    if (!diagram) return;
    this.attention.interacted();
    ev.preventDefault();
    this.dragging = true;
    this.dragPointerId = ev.pointerId;
    this.lastClientX = ev.clientX;
    this.lastClientY = ev.clientY;
    this.pendingClientX = ev.clientX;
    this.pendingClientY = ev.clientY;
    // 冻结换算比例（基于拖动起始 viewBox）→ 拖动中主图移动恒定、防发散；
    // viewBox 实时 union 使预览框随拖动自动放缩。
    this.dragWorldPerPixel = this.screenToWorldScale() ?? 1;
    this.installWindowDragListeners();
    try {
      this.svgEl?.setPointerCapture(ev.pointerId);
    } catch {
      /* setPointerCapture 不可用时走 window 级 pointermove/up 兜底 */
    }
  }

  /**
   * pointermove：仅记录最新 client 坐标并调度一次 rAF。
   * 【性能关键】120Hz 鼠标/触控板每秒触发 120 次，60Hz 屏每帧只能消化 1 次；
   * 若每次 move 都同步设 `diagram.position` + 刷 SVG，会「上帧没画完下帧又开一次」
   * 造成主线程拥堵 → 卡手。rAF 合流把同一帧内多次 move 折叠为一次主图位移 + 一次重绘。
   */
  onPointerMove(ev: PointerEvent): void {
    this.handlePointerMove(ev, true);
  }

  private handlePointerMove(ev: PointerEvent, marksPointerInside: boolean): void {
    if (this.destroyed) return;
    if (this.dragging && (this.dragPointerId === null || ev.pointerId === this.dragPointerId)) {
      ev.preventDefault();
      this.pendingClientX = ev.clientX;
      this.pendingClientY = ev.clientY;
      if (this.dragRafId === null) {
        // 保持主图拖动回调先进入同帧队列，避免注意力镜头延后已有导航手感。
        this.dragRafId = requestMinimapFrame(() => {
          this.dragRafId = null;
          this.flushDragDelta();
        });
      }
    }
    this.updateAttentionFromClientPoint(ev, marksPointerInside);
  }

  onPointerUp(ev: PointerEvent): void {
    if (this.destroyed || !this.dragging) return;
    if (this.dragPointerId !== null && ev.pointerId !== this.dragPointerId) return;
    // 取消未执行的 rAF 并同步 flush 最终位移，确保松手帧位置精确。
    if (this.dragRafId !== null) {
      cancelMinimapFrame(this.dragRafId);
      this.dragRafId = null;
    }
    this.pendingClientX = ev.clientX;
    this.pendingClientY = ev.clientY;
    this.flushDragDelta();
    this.dragging = false;
    this.dragPointerId = null;
    this.removeWindowDragListeners();
    try {
      this.svgEl?.releasePointerCapture(ev.pointerId);
    } catch {
      /* 忽略释放失败 */
    }
  }

  onPointerCancel(ev: PointerEvent): void {
    if (this.destroyed || !this.dragging) return;
    if (this.dragPointerId !== null && ev.pointerId !== this.dragPointerId) return;
    this.cancelDrag(ev.pointerId);
  }

  private installWindowDragListeners(): void {
    if (this.windowPointerMoveHandler || this.windowPointerUpHandler || this.windowPointerCancelHandler) return;
    this.windowPointerMoveHandler = (event: PointerEvent) => this.handlePointerMove(event, false);
    this.windowPointerUpHandler = (event: PointerEvent) => {
      const shouldSettleAttention = this.isCurrentDragPointer(event);
      this.onPointerUp(event);
      if (shouldSettleAttention) this.attention.pointerLeft();
    };
    this.windowPointerCancelHandler = (event: PointerEvent) => {
      const shouldSettleAttention = this.isCurrentDragPointer(event);
      this.onPointerCancel(event);
      if (shouldSettleAttention) this.attention.pointerLeft();
    };
    window.addEventListener('pointermove', this.windowPointerMoveHandler, { passive: false });
    window.addEventListener('pointerup', this.windowPointerUpHandler, { passive: false });
    window.addEventListener('pointercancel', this.windowPointerCancelHandler, { passive: false });
  }

  private removeWindowDragListeners(): void {
    if (this.windowPointerMoveHandler) {
      window.removeEventListener('pointermove', this.windowPointerMoveHandler);
      this.windowPointerMoveHandler = null;
    }
    if (this.windowPointerUpHandler) {
      window.removeEventListener('pointerup', this.windowPointerUpHandler);
      this.windowPointerUpHandler = null;
    }
    if (this.windowPointerCancelHandler) {
      window.removeEventListener('pointercancel', this.windowPointerCancelHandler);
      this.windowPointerCancelHandler = null;
    }
  }

  private isCurrentDragPointer(event: PointerEvent): boolean {
    return this.dragging && (this.dragPointerId === null || event.pointerId === this.dragPointerId);
  }

  private cancelDrag(pointerId: number): void {
    if (this.dragRafId !== null) {
      cancelMinimapFrame(this.dragRafId);
      this.dragRafId = null;
    }
    this.dragging = false;
    this.dragPointerId = null;
    this.removeWindowDragListeners();
    try {
      this.svgEl?.releasePointerCapture(pointerId);
    } catch {
      /* 忽略释放失败 */
    }
  }

  /**
   * 应用累积的增量位移（对齐 RF 逐帧 panDelta × moveScale）：
   * `position += 屏幕像素位移 × 世界/像素比`。增量式 → 实时 viewBox 随视口扩大也不发散
   * （每帧位移由鼠标速度限定，非累计偏移）；松手无解冻 → 无瞬移。
   */
  private flushDragDelta(): void {
    if (this.destroyed) return;
    const diagram = this.diagram.diagramInstance;
    if (!diagram) return;
    // 用拖动起始冻结的渲染比例换算位移 → 1:1 跟手（不随 viewBox 抽动）。
    const worldPerPixel = this.dragWorldPerPixel;
    const dx = (this.pendingClientX - this.lastClientX) * worldPerPixel;
    const dy = (this.pendingClientY - this.lastClientY) * worldPerPixel;
    if (dx === 0 && dy === 0) return;
    this.lastClientX = this.pendingClientX;
    this.lastClientY = this.pendingClientY;
    const pos = diagram.position;
    diagram.position = new go.Point(pos.x + dx, pos.y + dy);
    const vb = diagram.viewportBounds;
    if (vb.isReal()) this.viewport.set({ x: vb.x, y: vb.y, w: vb.width, h: vb.height });
  }

  /**
   * wheel：滚轮缩放主视图，**以指针所指世界坐标为锚**（zoom-to-cursor）。
   * 在小地图上指向某处滚轮 → 主视图缩放并把该世界点移到视口中心（缩进你指的区域），
   * 这是小地图导航最实用的语义（优于围绕当前中心缩放）。
   * delta 对齐 React Flow：pinchDelta = -deltaY × (像素 0.002 / 行 0.05 / 页 1) × zoomStep。
   */
  onWheel(ev: WheelEvent): void {
    const diagram = this.diagram.diagramInstance;
    if (!diagram) return;
    this.updateAttentionFromClientPoint(ev, false);
    ev.preventDefault();
    const vbBefore = diagram.viewportBounds;
    if (!vbBefore.isReal()) return;
    // RF 同款 delta：deltaMode 0=像素(0.002) / 1=行(0.05) / 2=页(1)。
    const unit = ev.deltaMode === 1 ? 0.05 : ev.deltaMode === 2 ? 1 : 0.002;
    const pinchDelta = -ev.deltaY * unit * MINIMAP_ZOOM_STEP;
    const oldScale = diagram.scale;
    const minS =
      Number.isFinite(diagram.minScale) && diagram.minScale > 0 ? diagram.minScale : FALLBACK_MIN_SCALE;
    const maxS =
      Number.isFinite(diagram.maxScale) && diagram.maxScale > 0 ? diagram.maxScale : FALLBACK_MAX_SCALE;
    const newScale = Math.max(minS, Math.min(maxS, oldScale * Math.pow(2, pinchDelta)));
    if (Math.abs(newScale - oldScale) < 1e-6) return;
    // 指针所指世界点（小地图坐标系）作为缩放锚：缩放后把它移到视口中心。
    const anchor = this.clientToWorld(ev.clientX, ev.clientY)
      ?? { x: vbBefore.x + vbBefore.width / 2, y: vbBefore.y + vbBefore.height / 2 };
    diagram.scale = newScale;
    const vbAfter = diagram.viewportBounds;
    if (!vbAfter.isReal()) return;
    diagram.position = new go.Point(anchor.x - vbAfter.width / 2, anchor.y - vbAfter.height / 2);
    const vb = diagram.viewportBounds;
    if (vb.isReal()) this.viewport.set({ x: vb.x, y: vb.y, w: vb.width, h: vb.height });
  }

  /**
   * 当前 SVG 渲染度量：屏幕 rect + viewBox + `xMidYMid meet` 等比 scale。
   * clientToWorld 与 screenToWorldScale 的共同前置计算（消除重复）。纯算术，不依赖 getScreenCTM。
   */
  private svgMetrics(): { rect: DOMRect; vbox: MinimapWorldRect; scale: number } | null {
    if (!this.svgEl) return null;
    const rect = this.svgEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const vbox = this.viewBox();
    const scale = Math.min(rect.width / vbox.w, rect.height / vbox.h);
    if (!(scale > 0)) return null;
    return { rect, vbox, scale };
  }

  /**
   * client → world 反变换（考虑 `xMidYMid meet` 等比适配与居中留白）。
   */
  private clientToWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const m = this.svgMetrics();
    if (!m) return null;
    const { rect, vbox, scale } = m;
    const padX = (rect.width - vbox.w * scale) / 2;
    const padY = (rect.height - vbox.h * scale) / 2;
    return {
      x: vbox.x + (clientX - rect.left - padX) / scale,
      y: vbox.y + (clientY - rect.top - padY) / scale,
    };
  }

  /**
   * 当前「世界单位 / 屏幕像素」比例（考虑 `xMidYMid meet` 等比适配）。
   * 用于增量拖动：屏幕像素位移 × 本比例 = 世界位移。
   */
  private screenToWorldScale(): number | null {
    const m = this.svgMetrics();
    return m ? 1 / m.scale : null;
  }
}
