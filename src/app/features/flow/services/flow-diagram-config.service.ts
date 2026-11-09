import { Injectable, inject, computed } from '@angular/core';
import { ThemeService } from '../../../../services/theme.service';
import { getFlowStyles, FlowTheme } from '../../../../config/flow-styles';
import { GOJS_CONFIG } from '../../../../config';
import { Task, Project } from '../../../../models';
import { buildTaskSidecarSummary } from '../../../../utils/task-sidecar';
import { LayoutService } from '../../../../services/layout.service';
import { LineageColorService } from '../../../../services/lineage-color.service';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import {
  createFlowConnectionLabelConfig,
  createFlowLinkMainShapesConfig,
  createFlowNodeMainPanelConfig,
  createFlowPort,
} from './flow-diagram-config-builders.helpers';
import { buildFlowLinkDataSeed } from './flow-diagram-link-data.helpers';
import { assignCrossTreeLabelStagger } from './flow-cross-tree-label-stagger.helpers';
import {
  applyFlowLineageDisplayColors,
  compressFlowDisplayId,
  computeFlowNodeColors,
  computeFlowNodeLocation,
  isFlowTaskSearchMatch,
  needsFlowDisplayIdRenumbering,
  resolveFlowDisplayId,
} from './flow-diagram-node-data.helpers';
import {
  buildProjectSiyuanBadgeContext,
  createFlowNodeSidecarBadgeItems,
  createFlowNodeSidecarBadgeSlots,
  type FlowNodeSidecarBadgeItem,
  type ProjectSiyuanBadgeContext,
} from './flow-diagram-sidecar-data.helpers';
import * as go from 'gojs';

export type FlowRelationDisplayMode = 'all' | 'focused' | 'hidden';

/**
 * GoJS 节点数据结构
 */
export interface GoJSNodeData {
  key: string;
  title: string;
  displayId: string;
  stage: number | null;
  parentId: string | null;
  status: Task['status'];
  rank?: number;
  loc: string;
  color: string;
  borderColor: string;
  borderWidth: number;
  titleColor: string;
  displayIdColor: string;
  selectedBorderColor: string;
  isUnassigned: boolean;
  isSearchMatch: boolean;
  isSelected: boolean;
  /** 始祖节点索引（用于血缘聚类） */
  rootAncestorIndex?: number;
  /** 家族专属颜色（HSL 格式） */
  familyColor?: string;
  /** 是否已被停泊 */
  isParked?: boolean;
  /** 是否已入坞（本地专注控制台状态） */
  isDocked?: boolean;
  /** 是否为当前专注中的入坞任务 */
  isDockFocused?: boolean;
  /** 当前任务是否已关联思源锚点 */
  hasSiyuanLink?: boolean;
  /** 用于流程图节点徽标 hover/click 预览的首个思源锚点 */
  siyuanLink?: ExternalSourceLink;
  /** 当前流程图可见思源徽标的连续序号（1-based） */
  siyuanLinkBadgeIndex?: number;
  /** 节点僚机短徽标文本（不参与拓扑，仅用于扫读） */
  sidecarBadgeText?: string;
  /** 节点僚机独立徽标列表（不参与拓扑，仅用于扫读） */
  sidecarBadgeItems?: FlowNodeSidecarBadgeItem[];
  sidecarTopBadgeItems?: FlowNodeSidecarBadgeItem[];
  sidecarRightBadgeItems?: FlowNodeSidecarBadgeItem[];
  sidecarBottomBadgeItems?: FlowNodeSidecarBadgeItem[];
  sidecarLeftBadgeItems?: FlowNodeSidecarBadgeItem[];
  sidecarTopVisible?: boolean;
  sidecarRightVisible?: boolean;
  sidecarBottomVisible?: boolean;
  sidecarLeftVisible?: boolean;
  /** 节点僚机悬停提示文本 */
  sidecarTooltipText?: string;
  /** 是否存在可显示的僚机信号 */
  sidecarHasSignals?: boolean;
  /** 当前任务僚机是否展开显示在任务块周围 */
  sidecarExpanded?: boolean;
}

/**
 * GoJS 连接数据结构
 */
export interface GoJSLinkData {
  key: string;
  from: string;
  to: string;
  isCrossTree: boolean;
  /** 稳定曲率：避免 GoJS 在刷新/重建后按自动曲率重新选择路径。 */
  curviness?: number;
  /** 联系块标题（外显内容） */
  title?: string;
  /** 联系块详细描述 */
  description?: string;
  /** 始祖节点索引（用于血缘聚类） */
  rootAncestorIndex?: number;
  /** 家族专属颜色（HSL 格式） */
  familyColor?: string;
  /**
   * 【2026-02-25 性能优化】GoJS link template category
   * 空字符串 = 默认模板（父子链接，无 label panel）
   * 'crossTree' = 跨树链接模板（含 label panel + tooltip）
   */
  category?: string;
  /**
   * 【关联块错开 2026-04-23】同一 stage-pair 内跨树链接的 label 沿线长方
    * 向的错开位置（范围 0.10-0.90）。默认靠近 target 端三分之一处，
    * 同 stage-pair 多链接时自动分散避免关联块堆叠。
   */
  labelSegmentFraction?: number;
  /**
    * 【关联块错开 2026-04-23】保留给旧快照/兼容路径的 label 偏移字段。
    * 新布局默认保持关联块嵌在线内，此值通常为 0。
   */
  labelSegmentOffsetY?: number;
}

const FLOW_LINK_ROUTE_CONFIG = {
  PARENT_CHILD_CURVINESS: 20,
  CROSS_TREE_CURVINESS: 18,
  PARALLEL_CURVINESS_STEP: 12,
} as const;

/**
 * GoJS 图表数据
 */
export interface GoJSDiagramData {
  nodeDataArray: GoJSNodeData[];
  linkDataArray: GoJSLinkData[];
}

export interface FlowRelationDisplayOptions {
  relationDisplayMode: FlowRelationDisplayMode;
  focusedTaskId: string | null;
}

/**
 * 流程图配置服务
 * 
 * 职责：
 * - 提供 GoJS 节点和连接线模板配置
 * - 构建图表数据（从任务数据转换为 GoJS 数据）
 * - 管理主题样式
 * 
 * 设计原则：
 * - 纯配置和数据转换逻辑，不持有 GoJS Diagram 实例
 * - 所有配置集中在此处，FlowViewComponent 只负责视图交互
 * - 可独立测试
 */
@Injectable({
  providedIn: 'root'
})
export class FlowDiagramConfigService {
  private readonly themeService = inject(ThemeService);
  private readonly lineageColorService = inject(LineageColorService);
  private readonly externalSourceLinks = inject(ExternalSourceLinkService, { optional: true });
  private readonly layoutService = inject(LayoutService);

  /** 当前主题样式配置（响应式） */
  readonly currentStyles = computed(() => {
    const theme = this.themeService.theme() as FlowTheme;
    return getFlowStyles(theme);
  });

  // ========== 图表配置常量 ==========

  /** 布局配置 */
  readonly layoutConfig = {
    layerSpacing: GOJS_CONFIG.LAYER_SPACING,
    columnSpacing: GOJS_CONFIG.COLUMN_SPACING,
    scrollMargin: GOJS_CONFIG.SCROLL_MARGIN
  } as const;

  /** 节点配置 */
  readonly nodeConfig = {
    unassignedWidth: GOJS_CONFIG.UNASSIGNED_NODE_WIDTH,
    assignedWidth: GOJS_CONFIG.ASSIGNED_NODE_WIDTH,
    cornerRadius: 10,
    portSize: GOJS_CONFIG.PORT_SIZE
  } as const;

  /** 连接线配置 */
  readonly linkConfig = {
    cornerRadius: 20,  // 增加圆角
    toShortLength: 5,  // 减小偏移量，让箭头更贴近目标节点（之前 10 太大会导致箭头角度计算问题）
    mobileStrokeWidth: 24,   // 移动端透明触控区域
    desktopStrokeWidth: 14,  // 桌面端透明触控区域
    visibleStrokeWidth: 6,   // 可见线条粗度：增加至6使其更明显
    arrowType: "Standard",   // 实心三角箭头
    arrowScale: 0.9,         // 调小补偿粗描边带来的视觉膨胀
    arrowStrokeWidth: 7      // 粗描边让 strokeJoin: round 生效，呈现圆角效果
  } as const;

  // ========== 数据构建方法 ==========

  /**
   * 从任务列表构建 GoJS 图表数据
   * @param tasks 任务列表
   * @param project 当前项目（用于获取连接信息）
   * @param searchQuery 搜索关键词（用于高亮）
   * @param existingNodeMap 现有节点数据映射（用于保持位置）
   */
  buildDiagramData(
    tasks: Task[],
    project: Project,
    searchQuery: string,
    existingNodeMap: Map<string, go.ObjectData>,
    dockState: { dockedTaskIds: ReadonlySet<string>; focusedTaskId: string | null },
    relationDisplay: FlowRelationDisplayOptions = { relationDisplayMode: 'all', focusedTaskId: null },
    sidecarExpandedTaskIds: ReadonlySet<string> = new Set<string>(),
  ): GoJSDiagramData {
    // 过滤显示的任务：只排除已归档的任务
    // 待分配任务（stage === null）也应该显示，不应该因为坐标为(0,0)而被过滤
    const tasksToShow = tasks.filter(t => t.status !== 'archived');
    const nodeDataArray = this.buildVisibleNodeData(
      tasks,
      project,
      searchQuery,
      existingNodeMap,
      dockState,
      tasksToShow,
      sidecarExpandedTaskIds,
    );
    const linkDataArray = this.buildVisibleLinkData(tasks, project, tasksToShow, relationDisplay);
    const enhancedData = this.lineageColorService.preprocessDiagramData(
      nodeDataArray,
      linkDataArray,
      tasksToShow
    );

    return {
      nodeDataArray: applyFlowLineageDisplayColors(
        enhancedData.nodeDataArray,
        familyColor => this.lineageColorService.getDarkerFamilyColor(familyColor),
      ),
      linkDataArray: enhancedData.linkDataArray,
    };
  }

  private buildVisibleNodeData(
    tasks: Task[],
    project: Project,
    searchQuery: string,
    existingNodeMap: Map<string, go.ObjectData>,
    dockState: { dockedTaskIds: ReadonlySet<string>; focusedTaskId: string | null },
    tasksToShow: Task[],
    sidecarExpandedTaskIds: ReadonlySet<string>,
  ): GoJSNodeData[] {
    const styles = this.currentStyles();
    const resolvedDisplayIds = this.createDisplayIdLookup(tasks, project);
    const siyuanBadgeContext = this.createProjectSiyuanBadgeContext(tasksToShow);
    const nodeDataArray: GoJSNodeData[] = [];
    let newNodeIndex = 0;
    const searchLower = searchQuery.toLowerCase().trim();

    for (const task of tasksToShow) {
      const loc = computeFlowNodeLocation(task, existingNodeMap, newNodeIndex);
      if (!existingNodeMap.has(task.id) && task.x === 0 && task.y === 0) {
        newNodeIndex++;
      }

      const isSearchMatch = isFlowTaskSearchMatch(task, searchLower);
      const { nodeColor, borderColor, borderWidth, titleColor } =
        computeFlowNodeColors(task, isSearchMatch, styles);
      const sidecar = this.buildNodeSidecarData(task, dockState, siyuanBadgeContext, sidecarExpandedTaskIds);

      nodeDataArray.push({
        key: task.id,
        title: task.title || '未命名任务',
        displayId: compressFlowDisplayId(resolveFlowDisplayId(task, resolvedDisplayIds)),
        stage: task.stage,
        parentId: task.parentId,
        status: task.status,
        rank: task.rank,
        loc,
        color: nodeColor,
        borderColor: sidecar.isParked ? '#d97706' : borderColor,
        borderWidth: sidecar.isParked ? 2 : borderWidth,
        titleColor,
        displayIdColor: styles.text.displayIdColor,
        selectedBorderColor: styles.node.selectedBorder,
        isUnassigned: task.stage === null,
        isSearchMatch,
        isSelected: false,
        ...sidecar,
      });
    }

    return nodeDataArray;
  }

  private buildVisibleLinkData(
    tasks: Task[],
    project: Project,
    tasksToShow: Task[],
    relationDisplay: FlowRelationDisplayOptions,
  ): GoJSLinkData[] {
    const seed = buildFlowLinkDataSeed({
      tasks,
      project,
      tasksToShow,
      relationDisplay,
    });

    assignCrossTreeLabelStagger(seed.crossTreeLinksToStagger, seed.taskStageMap, seed.stageNodeCount);
    this.assignStableLinkCurviness(seed.linkDataArray);
    seed.linkDataArray.sort((a, b) => this.compareLinkData(a, b));
    return seed.linkDataArray;
  }

  private buildNodeSidecarData(
    task: Task,
    dockState: { dockedTaskIds: ReadonlySet<string>; focusedTaskId: string | null },
    siyuanBadgeContext: ProjectSiyuanBadgeContext,
    sidecarExpandedTaskIds: ReadonlySet<string>,
  ): Partial<GoJSNodeData> {
    const isDocked = dockState.dockedTaskIds.has(task.id);
    const isDockFocused = dockState.focusedTaskId === task.id;
    const siyuanLinks = siyuanBadgeContext.linksByTask.get(task.id) ?? [];
    const siyuanLink = siyuanLinks[0] ?? undefined;
    const sidecarSummary = buildTaskSidecarSummary(task, {
      knowledgeAnchorCount: siyuanLinks.length,
      isDocked,
      isDockFocused,
    });
    const sidecarBadgeItems = createFlowNodeSidecarBadgeItems(sidecarSummary.badges);
    const sidecarBadgeSlots = createFlowNodeSidecarBadgeSlots(sidecarBadgeItems);
    const sidecarExpanded = sidecarSummary.hasSignals && sidecarExpandedTaskIds.has(task.id);

    return {
      isParked: task.parkingMeta?.state === 'parked',
      isDocked,
      isDockFocused,
      hasSiyuanLink: Boolean(siyuanLink),
      siyuanLink,
      siyuanLinkBadgeIndex: siyuanLink
        ? siyuanBadgeContext.badgeIndexByLinkId.get(siyuanLink.id)
        : undefined,
      sidecarBadgeText: sidecarSummary.badges.slice(0, 4).map(badge => badge.label).join(' · '),
      sidecarBadgeItems,
      sidecarTopBadgeItems: sidecarBadgeSlots.top,
      sidecarRightBadgeItems: sidecarBadgeSlots.right,
      sidecarBottomBadgeItems: sidecarBadgeSlots.bottom,
      sidecarLeftBadgeItems: sidecarBadgeSlots.left,
      sidecarTopVisible: sidecarExpanded && sidecarBadgeSlots.top.length > 0,
      sidecarRightVisible: sidecarExpanded && sidecarBadgeSlots.right.length > 0,
      sidecarBottomVisible: sidecarExpanded && sidecarBadgeSlots.bottom.length > 0,
      sidecarLeftVisible: sidecarExpanded && sidecarBadgeSlots.left.length > 0,
      sidecarTooltipText: sidecarSummary.tooltipLines.join('\n'),
      sidecarHasSignals: sidecarSummary.hasSignals,
      sidecarExpanded,
    };
  }

  private assignStableLinkCurviness(linkDataArray: GoJSLinkData[]): void {
    const linksByEndpoint = new Map<string, GoJSLinkData[]>();

    for (const link of linkDataArray) {
      const bucketKey = `${link.from}->${link.to}|${link.category ?? ''}`;
      const bucket = linksByEndpoint.get(bucketKey) ?? [];
      bucket.push(link);
      linksByEndpoint.set(bucketKey, bucket);
    }

    for (const bucket of linksByEndpoint.values()) {
      bucket.sort((a, b) => this.compareLinkData(a, b));
      if (bucket.length === 1) {
        bucket[0].curviness = this.getBaseLinkCurviness(bucket[0]);
        continue;
      }

      const middle = (bucket.length - 1) / 2;
      bucket.forEach((link, index) => {
        const spread = (index - middle) * FLOW_LINK_ROUTE_CONFIG.PARALLEL_CURVINESS_STEP;
        link.curviness = spread === 0 ? this.getBaseLinkCurviness(link) : spread;
      });
    }
  }

  private getBaseLinkCurviness(link: GoJSLinkData): number {
    return link.isCrossTree
      ? FLOW_LINK_ROUTE_CONFIG.CROSS_TREE_CURVINESS
      : FLOW_LINK_ROUTE_CONFIG.PARENT_CHILD_CURVINESS;
  }

  private compareLinkData(a: GoJSLinkData, b: GoJSLinkData): number {
    const categoryCompare = Number(a.isCrossTree) - Number(b.isCrossTree);
    if (categoryCompare !== 0) return categoryCompare;

    return a.key.localeCompare(b.key);
  }

  private createProjectSiyuanBadgeContext(tasksToShow: Task[]): ProjectSiyuanBadgeContext {
    return buildProjectSiyuanBadgeContext(
      tasksToShow,
      this.externalSourceLinks
        ? taskId => this.externalSourceLinks?.activeLinksForTask(taskId) ?? []
        : undefined,
    );
  }

  /**
   * 压缩 displayId 显示（如 A,A,A,A,A → A⁵）
   */
  private createDisplayIdLookup(tasks: Task[], project: Project): ReadonlyMap<string, string> {
    const needsNumbering = tasks.some(task => needsFlowDisplayIdRenumbering(task));
    if (!needsNumbering) {
      return new Map();
    }

    const rebalancedProject = this.layoutService.rebalance({ ...project, tasks });
    return new Map(rebalancedProject.tasks.map(task => [task.id, task.displayId]));
  }

  createPort($: typeof go.GraphObject.make, name: string, spot: go.Spot, output: boolean, input: boolean, isMobile: boolean = false): go.Shape {
    return createFlowPort($, name, spot, output, input, isMobile);
  }

  getNodeMainPanelConfig($: typeof go.GraphObject.make): go.Panel {
    return createFlowNodeMainPanelConfig($, this.nodeConfig);
  }

  getLinkMainShapesConfig($: typeof go.GraphObject.make, isMobile: boolean): go.Shape[] {
    return createFlowLinkMainShapesConfig($, isMobile, this.linkConfig, this.currentStyles());
  }

  getConnectionLabelConfig($: typeof go.GraphObject.make): go.Panel {
    return createFlowConnectionLabelConfig($);
  }
}
