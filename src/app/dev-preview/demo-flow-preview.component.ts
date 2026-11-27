import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Injectable, inject, Input, NgZone, OnDestroy, signal, ViewChild } from '@angular/core';
import * as go from 'gojs';
import { GOJS_CONFIG } from '../../config';
import { getFlowStyles } from '../../config/flow-styles';
import type { Task } from '../../models';
import { buildTaskSidecarSummary } from '../../utils/task-sidecar';
import { LoggerService } from '../../services/logger.service';
import { FlowOverviewPanelComponent } from '../features/flow/components/flow-overview-panel.component';
import { FlowMinimapComponent } from '../features/flow/components/flow-minimap.component';
import { FlowMinimapLegendComponent } from '../features/flow/components/flow-minimap-legend.component';
import { FlowDiagramService } from '../features/flow/services/flow-diagram.service';
import { FlowDiagramConfigService } from '../features/flow/services/flow-diagram-config.service';
import { createFlowDiagram, initializeFlowDiagramModel } from '../features/flow/services/flow-diagram-setup.helpers';
import { createFlowConnectionLabelConfig, createFlowLinkMainShapesConfig, createFlowNodeMainPanelConfig, createFlowPort } from '../features/flow/services/flow-diagram-config-builders.helpers';
import { createFlowNodeSidecarTemplateParts } from '../features/flow/services/flow-template-sidecar.helpers';
import { createFlowNodeSidecarBadgeItems, createFlowNodeSidecarBadgeSlots } from '../features/flow/services/flow-diagram-sidecar-data.helpers';
import { computeFlowNodeColors } from '../features/flow/services/flow-diagram-node-data.helpers';

function createDenseFlowData(): { nodes: go.ObjectData[]; links: go.ObjectData[] } {
    const nodes: go.ObjectData[] = [];
    const links: go.ObjectData[] = [];
    for (let tree = 0; tree < 4; tree += 1) {
      const ids = Array.from({ length: 31 }, () => crypto.randomUUID());
      for (let index = 0; index < ids.length; index += 1) {
        const depth = index === 0 ? 0 : index < 6 ? 1 : 2;
        const row = index === 0 ? 15 : index < 6 ? index * 5 : index - 6;
        nodes.push({ key: ids[index], title: `树 ${tree + 1} · 任务 ${index + 1}`, loc: `${tree * 1800 + depth * 420} ${row * 110}`,
          color: '#ffffff', borderColor: '#78716c', borderWidth: 1, familyColor: '#4a8c8c', stage: depth + 1,
          displayId: `${tree + 1}.${index + 1}`, titleColor: '#292524', displayIdColor: '#4a8c8c' });
        if (index > 0) links.push({ key: crypto.randomUUID(), from: ids[index < 6 ? 0 : 1 + Math.floor((index - 6) / 5)],
          to: ids[index], familyColor: '#4a8c8c', isCrossTree: false });
      }
    }
    links.push({ key: crypto.randomUUID(), from: nodes[12].key, to: nodes[80].key, isCrossTree: true, title: '跨树依赖' });
    return { nodes, links };
}

export function createDemoFlowData(state: string): { nodes: go.ObjectData[]; links: go.ObjectData[] } {
  if (['overview-dense', 'overview-selected', 'overview-zoomed', 'overview-dense-mobile'].includes(state)) return createDenseFlowData();
  const styles = getFlowStyles('default', 'light');
  const firstId = crypto.randomUUID();
  const tasks: Task[] = ['规划下一步', '完成核心任务', '整理验证结果'].map((title, index) => ({
    id: index === 0 ? firstId : crypto.randomUUID(), title, content: '这是可操作的虚拟流程任务。', stage: index + 1,
    parentId: index === 1 ? firstId : null, order: index, rank: index * 10000, status: index === 2 ? 'completed' : 'active',
    x: 160 + index * 250, y: index === 2 ? 260 : 140, createdDate: '2026-01-01T00:00:00Z', displayId: `${index + 1}`,
    expected_minutes: 25, cognitive_load: 'high',
  }));
  const nodes = tasks.map((task, index) => {
    const selected = index === 0;
    const summary = buildTaskSidecarSummary(task);
    const badgeItems = state === 'sidecar' && selected ? createFlowNodeSidecarBadgeItems(summary.badges) : [];
    const slots = createFlowNodeSidecarBadgeSlots(badgeItems);
    const expanded = state === 'sidecar' && selected;
    const colors = computeFlowNodeColors(task, state === 'search' && selected, styles);
    return { key: task.id, title: task.title, displayId: task.displayId, loc: `${task.x} ${task.y}`, stage: task.stage,
      status: task.status, color: colors.nodeColor, borderColor: state === 'parked' && selected ? '#d97706' : colors.borderColor,
      borderWidth: colors.borderWidth, titleColor: colors.titleColor, displayIdColor: styles.text.displayIdColor,
      isUnassigned: false, familyColor: '#4A8C8C', isParked: state === 'parked' && selected,
      isDocked: state === 'focused' && selected, isDockFocused: state === 'focused' && selected,
      isSearchMatch: state === 'search' && selected, sidecarHasSignals: badgeItems.length > 0, sidecarExpanded: expanded,
      sidecarBadgeItems: badgeItems, sidecarTopBadgeItems: slots.top, sidecarRightBadgeItems: slots.right,
      sidecarBottomBadgeItems: slots.bottom, sidecarLeftBadgeItems: slots.left,
      sidecarTopVisible: expanded && slots.top.length > 0, sidecarRightVisible: expanded && slots.right.length > 0,
      sidecarBottomVisible: expanded && slots.bottom.length > 0, sidecarLeftVisible: expanded && slots.left.length > 0,
    };
  });
  return { nodes, links: [
    { key: crypto.randomUUID(), from: tasks[0].id, to: tasks[1].id, familyColor: '#4A8C8C', isCrossTree: false },
    { key: crypto.randomUUID(), from: tasks[1].id, to: tasks[2].id, isCrossTree: true, title: '验证关联' },
  ] };
}

@Injectable()
export class DemoFlowMemoryService {
  diagramInstance: go.Diagram | null = null;
  get isInitialized(): boolean { return this.diagramInstance !== null; }
  readonly currentStyles = signal(getFlowStyles('default', 'light'));
  category(): { debug: () => void; warn: () => void; info: () => void } { return { debug: () => {}, warn: () => {}, info: () => {} }; }
}

@Component({
  selector: 'app-demo-flow-preview', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FlowOverviewPanelComponent, FlowMinimapComponent, FlowMinimapLegendComponent],
  providers: [DemoFlowMemoryService,
    { provide: FlowDiagramService, useExisting: DemoFlowMemoryService },
    { provide: FlowDiagramConfigService, useExisting: DemoFlowMemoryService },
    { provide: LoggerService, useExisting: DemoFlowMemoryService }],
  template: `
    <section class="flow-preview" data-testid="demo-flow-preview" [attr.data-preview-state]="state()">
      @if (state().startsWith('overview-') && state() !== 'overview-collapsed' && state() !== 'overview-mobile') {
        <nav class="preview-actions" aria-label="多树定位验证">
          <button type="button" (click)="selectFixtureTask(12)">选中树 1 的任务 13</button>
          <button type="button" (click)="selectFixtureTask(80)">选中树 3 的任务 19</button>
          <button type="button" (click)="clearFixtureSelection()">清除选择</button>
          <button type="button" (click)="zoomFixture(1 / 1.25)">缩小主图</button>
          <button type="button" (click)="zoomFixture(1.25)">放大主图</button>
          <button type="button" (click)="fitFixture()">适配全图</button>
        </nav>
      }
      <div #diagramDiv class="preview-canvas" aria-label="虚拟任务流程图"></div>
      @if (state().startsWith('overview')) {
        <app-flow-overview-panel [collapsed]="overviewCollapsed()" [mobile]="state() === 'overview-mobile' || state() === 'overview-dense-mobile'" (collapseToggle)="overviewCollapsed.update(toggle)" />
      } @else { <div class="minimap"><app-flow-minimap [width]="216" [height]="140" /></div> }
      <p>拖动节点、点选任务；点击僚机徽章切换展开。所有变化只留在本页。</p>
      @if (state() === 'legend') { <app-flow-minimap-legend [visible]="true" /> }
    </section>
  `,
  styles: [`:host{display:block;min-width:0}.flow-preview{position:relative;background:#fafaf4;border:1px solid #d6d3d1;border-radius:12px;overflow:hidden}.preview-canvas{height:420px;width:100%;position:relative}.minimap{position:absolute;bottom:42px;right:12px}p{padding:8px 12px;font-size:12px;color:#57534e}.preview-actions{display:flex;flex-wrap:wrap;gap:6px;padding:10px;border-bottom:1px solid #e7e5e4}.preview-actions button{min-height:28px;padding:4px 9px;border:1px solid #d6d3d1;border-radius:6px;background:#fff;font-size:12px}.preview-actions button:focus-visible{outline:2px solid #6366f1;outline-offset:2px}`],
})
export class DemoFlowPreviewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('diagramDiv', { static: true }) private diagramDiv!: ElementRef<HTMLDivElement>;
  readonly state = signal('normal');
  readonly overviewCollapsed = signal(false);
  readonly toggle = (value: boolean) => !value;
  readonly memory = inject(DemoFlowMemoryService);
  private readonly zone = inject(NgZone);
  @Input({ alias: 'state' }) set stateInput(value: string) {
    this.state.set(value); this.overviewCollapsed.set(value === 'overview-collapsed');
    if (this.memory.diagramInstance) this.setFixture(this.memory.diagramInstance);
  }

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      const diagram = createFlowDiagram(this.diagramDiv.nativeElement);
      const $ = go.GraphObject.make;
      diagram.nodeTemplate = $(go.Node, 'Spot', { locationSpot: go.Spot.Center, movable: true },
        new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(go.Point.stringify),
        createFlowNodeMainPanelConfig($, { assignedWidth: GOJS_CONFIG.ASSIGNED_NODE_WIDTH, unassignedWidth: GOJS_CONFIG.UNASSIGNED_NODE_WIDTH, cornerRadius: 10 }),
        ...createFlowNodeSidecarTemplateParts({ context: { isMobile: false, sidecarTitleMaxSize: new go.Size(150, NaN) },
          onToggle: (_id, part) => {
            if (!part) return;
            diagram.commit(() => {
              const expanded = !part.data.sidecarExpanded;
              diagram.model.setDataProperty(part.data, 'sidecarExpanded', expanded);
              for (const side of ['Top', 'Right', 'Bottom', 'Left']) diagram.model.setDataProperty(part.data, `sidecar${side}Visible`, expanded && part.data[`sidecar${side}BadgeItems`].length > 0);
            }, 'toggle preview sidecar');
          } }),
        $(go.Shape, 'RoundedRectangle', { fill: null, stroke: '#4f46e5', strokeWidth: 3, visible: false, width: GOJS_CONFIG.ASSIGNED_NODE_WIDTH + 10, height: 96 }, new go.Binding('visible', 'isDockFocused')),
        ...[['T', go.Spot.Top], ['B', go.Spot.Bottom], ['L', go.Spot.Left], ['R', go.Spot.Right]].map(([name, spot]) => createFlowPort($, name as string, spot as go.Spot, true, true)),
      );
      diagram.linkTemplate = $(go.Link, { routing: go.Routing.AvoidsNodes, curve: go.Curve.JumpOver, corner: 20 },
        ...createFlowLinkMainShapesConfig($, false, { mobileStrokeWidth: 24, desktopStrokeWidth: 14, visibleStrokeWidth: 6, arrowType: 'Standard', arrowScale: 0.9, arrowStrokeWidth: 7 }, this.memory.currentStyles()),
        createFlowConnectionLabelConfig($));
      diagram.addDiagramListener('InitialLayoutCompleted', () => this.applyFixtureView(diagram));
      initializeFlowDiagramModel(diagram);
      this.memory.diagramInstance = diagram;
      this.setFixture(diagram);
    });
  }
  private setFixture(diagram: go.Diagram): void {
    const fixture = createDemoFlowData(this.state());
    diagram.model = new go.GraphLinksModel(fixture.nodes, fixture.links, { linkKeyProperty: 'key' });
    this.applyFixtureView(diagram);
  }
  private applyFixtureView(diagram: go.Diagram): void {
    diagram.zoomToFit();
    if (this.state() === 'overview-zoomed') diagram.scale = 1.5;
    if (this.state() === 'overview-selected' || this.state() === 'overview-zoomed') this.selectFixtureTask(12);
  }
  selectFixtureTask(index: number): void {
    const diagram = this.memory.diagramInstance;
    const data = diagram?.model.nodeDataArray[index];
    if (!diagram || !data) return;
    const node = diagram.findNodeForKey(data.key);
    if (node) { diagram.select(node); diagram.centerRect(node.actualBounds); }
  }
  clearFixtureSelection(): void { this.memory.diagramInstance?.clearSelection(); }
  zoomFixture(factor: number): void {
    const diagram = this.memory.diagramInstance;
    if (!diagram) return;
    const viewport = diagram.viewportBounds.copy();
    diagram.scale = Math.max(diagram.minScale, Math.min(diagram.maxScale, diagram.scale * factor));
    if (viewport.isReal()) diagram.centerRect(viewport);
  }
  fitFixture(): void { this.memory.diagramInstance?.zoomToFit(); }
  ngOnDestroy(): void {
    const diagram = this.memory.diagramInstance;
    this.memory.diagramInstance = null;
    if (diagram) diagram.div = null;
  }
}
