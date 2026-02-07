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
  GojsNodeExt,
  GojsLinkingToolExt,
  GojsRelinkingToolExt,
  GojsMake,
  LinkStyleConfig,
} from './flow-template.types';

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
    const radiusSquared = linkStyleConfig.captureRadius * linkStyleConfig.captureRadius;

    // 禁止自连接
    const originalRelinkIsValidLink = relinkingTool.isValidLink;
    relinkingTool.isValidLink = function(fromNode: go.Node, fromPort: go.GraphObject, toNode: go.Node, toPort: go.GraphObject): boolean {
      if (fromNode === toNode) return false;
      return originalRelinkIsValidLink.call(this, fromNode, fromPort, toNode, toPort);
    };

    // 辅助函数
    const getNodeBodyBounds = (node: go.Node): go.Rect | null => {
      const bodyPanel = node.findObject("BODY") as go.Panel;
      if (bodyPanel) {
        const panelBounds = bodyPanel.getDocumentBounds();
        if (panelBounds.isReal()) return panelBounds;
      }
      const bounds = node.actualBounds;
      return bounds.isReal() ? bounds : null;
    };

    const isPointerNearBody = (node: go.Node, pointer: go.Point, tolerance: number): boolean => {
      const bounds = getNodeBodyBounds(node);
      if (!bounds) return false;
      const expanded = bounds.copy();
      expanded.inflate(tolerance, tolerance);
      return expanded.containsPoint(pointer);
    };

    const distanceToBodySquared = (node: go.Node, pointer: go.Point): number => {
      const bounds = getNodeBodyBounds(node);
      if (!bounds) return Number.POSITIVE_INFINITY;
      const clampedX = Math.min(Math.max(pointer.x, bounds.x), bounds.right);
      const clampedY = Math.min(Math.max(pointer.y, bounds.y), bounds.bottom);
      const dx = pointer.x - clampedX;
      const dy = pointer.y - clampedY;
      return dx * dx + dy * dy;
    };

    const isRealNode = (node: go.Node | null, excludeNode: go.Node | null): node is go.Node => {
      if (!node || node === excludeNode) return false;
      const nodeExt = node as go.Node & GojsNodeExt;
      const hasData = !!nodeExt.data;
      const hasBody = !!node.findObject?.('BODY');
      if (!hasData && !hasBody) return false;
      const mainPort = node.findPort("");
      return !!(mainPort && mainPort.toLinkable);
    };

    const getMainPort = (node: go.Node | null): go.GraphObject | null => {
      if (!node) return null;
      const mainPort = node.findPort("");
      if (mainPort && mainPort.toLinkable) return mainPort;
      return null;
    };

    const normalizePort = (port: go.GraphObject | null): go.GraphObject | null => {
      if (!port) return null;
      const node = port.part;
      if (node instanceof go.Node) {
        const portId = port.portId || '';
        if (portId === "") return port.toLinkable ? port : getMainPort(node);
        if (allowedPortIds.includes(portId)) return getMainPort(node) || port;
      }
      return port;
    };

    const findNodeNearPointer = (tool: go.LinkingTool, fromEnd: boolean): go.Node | null => {
      const dia = tool.diagram;
      const pointer = dia?.lastInput?.documentPoint;
      if (!dia || !pointer) return null;
      const toolExt = tool as go.LinkingTool & GojsLinkingToolExt & {
        toNode?: go.Node | null;
        originalToNode?: go.Node | null;
        originalFromNode?: go.Node | null;
        temporaryLink?: go.Link | null;
      };
      const excludeNode = fromEnd
        ? (toolExt.toNode || toolExt.originalToNode)
        : (toolExt.fromNode || toolExt.originalFromNode || toolExt.temporaryLink?.fromNode || toolExt._originNode);

      const directParts = dia.findPartsAt(pointer, true);
      let found: go.Node | null = null;
      directParts.each((part: go.Part) => {
        if (!found && part instanceof go.Node && isRealNode(part, excludeNode ?? null) && isPointerNearBody(part, pointer, pointerTolerance)) {
          found = part;
        }
      });
      if (found) return found;

      const searchRect = new go.Rect(
        pointer.x - linkStyleConfig.captureRadius,
        pointer.y - linkStyleConfig.captureRadius,
        linkStyleConfig.captureRadius * 2,
        linkStyleConfig.captureRadius * 2
      );
      let closest: go.Node | null = null;
      let closestDist = Number.POSITIVE_INFINITY;
      dia.findPartsIn(searchRect, true, true).each((part: go.Part) => {
        if (!(part instanceof go.Node) || !isRealNode(part, excludeNode ?? null)) return;
        if (!isPointerNearBody(part, pointer, pointerTolerance)) return;
        const dist = distanceToBodySquared(part, pointer);
        if (dist <= radiusSquared && dist < closestDist) {
          closestDist = dist;
          closest = part;
        }
      });
      if (closest) return closest;

      dia.nodes.each((node: go.Node) => {
        if (!isRealNode(node, excludeNode ?? null)) return;
        if (!isPointerNearBody(node, pointer, pointerTolerance)) return;
        const dist = distanceToBodySquared(node, pointer);
        if (dist <= radiusSquared && dist < closestDist) {
          closestDist = dist;
          closest = node;
        }
      });
      return closest;
    };

    // 增强 findTargetPort
    const enhanceTargetFinding = (tool: go.LinkingTool, original: go.LinkingTool['findTargetPort']): void => {
      tool.findTargetPort = function(fromEnd: boolean) {
        const node = findNodeNearPointer(this, fromEnd);
        const directPort = getMainPort(node);

        const toolExt = this as go.LinkingTool & GojsLinkingToolExt & {
          toNode?: go.Node | null;
          originalToNode?: go.Node | null;
          originalFromNode?: go.Node | null;
          temporaryLink?: go.Link | null;
        };
        const originNode = toolExt.fromNode || toolExt.originalFromNode || toolExt.temporaryLink?.fromNode || toolExt._originNode;
        if (node && originNode && node === originNode) return null;

        if (directPort) return directPort;
        return normalizePort(original.call(this, fromEnd));
      };
    };

    enhanceTargetFinding(linkingTool, linkingTool.findTargetPort);
    enhanceTargetFinding(
      relinkingTool as unknown as go.LinkingTool,
      relinkingTool.findTargetPort as unknown as go.LinkingTool['findTargetPort']
    );

    // 端口引力
    const portGravity = Math.max(4, pointerTolerance * 2);
    linkingTool.portGravity = portGravity;
    (relinkingTool as go.RelinkingTool & { portGravity?: number }).portGravity = portGravity;

    // 重连手柄
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

    // 临时连接线
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
