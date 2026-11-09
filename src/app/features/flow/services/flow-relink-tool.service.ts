/**
 * FlowRelinkToolService - GoJS RelinkingTool 配置
 *
 * 从 FlowLinkTemplateService 提取的重连工具配置逻辑
 *
 * 职责：
 * - RelinkingTool 配置（手柄、临时连接线、端口引力）
 * - 增强目标端口查找（findTargetPort）用于 LinkingTool 和 RelinkingTool
 * - 节点体边界计算辅助函数
 */

import { Injectable, inject } from '@angular/core';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { LoggerService } from '../../../../services/logger.service';
import * as go from 'gojs';
import {
  GojsMake,
  LinkStyleConfig,
} from './flow-template.types';
import {
  computeRelinkPortGravity,
} from './flow-relink-tool-geometry.helpers';
import { enhanceRelinkTargetFinding } from './flow-relink-target-finding.helpers';

const selfLinkGuardedRelinkingTools = new WeakSet<go.RelinkingTool>();

@Injectable({
  providedIn: 'root'
})
export class FlowRelinkToolService {
  private readonly uiState = inject(UiStateService);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowRelinkTool');

  /**
   * 配置 RelinkingTool
   */
  configureRelinkingTool(
    diagram: go.Diagram,
    allowedPortIds: string[],
    linkStyleConfig: LinkStyleConfig,
    freeAngleLinkPoint: go.Link['getLinkPoint'],
    pointerTolerance: number,
    $: GojsMake
  ): void {
    const relinkingTool = diagram.toolManager.relinkingTool;
    const linkingTool = diagram.toolManager.linkingTool;

    this.preventSelfRelinking(relinkingTool);
    enhanceRelinkTargetFinding(linkingTool, linkingTool.findTargetPort, {
      allowedPortIds,
      linkStyleConfig,
      pointerTolerance,
    });
    enhanceRelinkTargetFinding(
      relinkingTool as unknown as go.LinkingTool,
      relinkingTool.findTargetPort as unknown as go.LinkingTool['findTargetPort'],
      {
        allowedPortIds,
        linkStyleConfig,
        pointerTolerance,
      },
    );

    // 端口引力
    const portGravity = computeRelinkPortGravity(pointerTolerance);
    linkingTool.portGravity = portGravity;
    (relinkingTool as go.RelinkingTool & { portGravity?: number }).portGravity = portGravity;
    this.configureRelinkHandles(relinkingTool, $);
    this.configureTemporaryRelink(relinkingTool, freeAngleLinkPoint, $);
  }

  private preventSelfRelinking(relinkingTool: go.RelinkingTool): void {
    if (selfLinkGuardedRelinkingTools.has(relinkingTool)) {
      return;
    }

    const originalRelinkIsValidLink = relinkingTool.isValidLink;
    relinkingTool.isValidLink = function(
      fromNode: go.Node,
      fromPort: go.GraphObject,
      toNode: go.Node,
      toPort: go.GraphObject,
    ): boolean {
      if (fromNode === toNode) return false;
      return originalRelinkIsValidLink.call(this, fromNode, fromPort, toNode, toPort);
    };
    selfLinkGuardedRelinkingTools.add(relinkingTool);
  }

  private configureRelinkHandles(relinkingTool: go.RelinkingTool, $: GojsMake): void {
    relinkingTool.fromHandleArchetype = $(go.Shape, "Diamond", {
      desiredSize: new go.Size(14, 14),
      fill: "#8b5cf6",
      stroke: "#6d28d9",
      strokeWidth: 2,
      cursor: "pointer",
      segmentIndex: 0
    });

    relinkingTool.toHandleArchetype = $(go.Shape, "Diamond", {
      desiredSize: new go.Size(14, 14),
      fill: "#8b5cf6",
      stroke: "#6d28d9",
      strokeWidth: 2,
      cursor: "pointer",
      segmentIndex: -1
    });
  }

  private configureTemporaryRelink(
    relinkingTool: go.RelinkingTool,
    freeAngleLinkPoint: go.Link['getLinkPoint'],
    $: GojsMake
  ): void {
    relinkingTool.temporaryLink = $(go.Link,
      {
        layerName: "Tool",
        getLinkPoint: freeAngleLinkPoint,
        curve: go.Link.Bezier
      },
      $(go.Shape, {
        stroke: "#78716C",
        strokeWidth: 6,
        strokeDashArray: [4, 4],
        strokeCap: "round",
        strokeJoin: "round"
      }),
      $(go.Shape, {
        toArrow: "Standard",
        fill: "#78716C",
        stroke: "#78716C",
        strokeWidth: 7,
        strokeCap: "round",
        strokeJoin: "round",
        scale: 0.9,
        segmentOrientation: go.Orientation.Along,
        segmentIndex: -1,
        alignmentFocus: go.Spot.Right
      })
    );
  }
}
