/**
 * FlowLinkTemplateService - GoJS 连接线模板配置
 * 
 * 从 FlowTemplateService 提取的连接线相关逻辑
 * 
 * 职责：
 * - 连接线模板配置（样式、标签、工具）
 * - LinkingTool / RelinkingTool 配置
 * - 周界交点计算算法（用于连接线端点定位）
 * - Overview 连接线模板
 */

import { Injectable, inject } from '@angular/core';
import { GOJS_CONFIG } from '../../../../config';
import { getFlowStyles, FlowTheme, FlowColorMode } from '../../../../config/flow-styles';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import { createFreeAngleLinkPoint } from './flow-link-template-link-point.helpers';
import { configureLinkingTool as configureLinkingToolHelper } from './flow-link-template-linking-tool.helpers';
import { setupLinkTemplates } from './flow-link-template-builders.helpers';
import * as go from 'gojs';
import {
  GojsMake,
  LinkStyleConfig,
} from './flow-template.types';
import { FlowRelinkToolService } from './flow-relink-tool.service';

@Injectable({
  providedIn: 'root'
})
export class FlowLinkTemplateService {
  private readonly uiState = inject(UiStateService);
  private readonly configService = inject(FlowDiagramConfigService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLinkTemplate');
  private readonly themeService = inject(ThemeService);
  private readonly relinkToolService = inject(FlowRelinkToolService);

  // ========== 主题感知的样式获取 ==========

  /**
   * 获取当前主题的 GoJS 样式配置
   */
  private getCurrentFlowStyles() {
    const theme = this.themeService.theme() as FlowTheme;
    const colorMode: FlowColorMode = this.themeService.isDark() ? 'dark' : 'light';
    return getFlowStyles(theme, colorMode);
  }

  // ========== 样式配置 ==========

  getLinkStyleConfig(isMobile: boolean): LinkStyleConfig {
    const flowStyles = this.getCurrentFlowStyles();
    const rawCaptureRadius = GOJS_CONFIG.LINK_CAPTURE_THRESHOLD ?? 80;
    const captureRadius = isMobile
      ? Math.min(Math.max(rawCaptureRadius, 28), 60)
      : Math.min(Math.max(rawCaptureRadius, 16), 36);
    
    return {
      defaultStroke: flowStyles.link.parentChildColor,
      parentChildStroke: flowStyles.link.parentChildColor,
      selectedStroke: flowStyles.node.selectedBorder,
      strokeWidth: 1.5,
      captureRadius
    };
  }

  getLinkCurveConfig(): { curve: typeof go.Link.Bezier; curviness: number } {
    return {
      curve: go.Link.Bezier,
      curviness: 20
    };
  }

  // ========== Perimeter Intersection 算法 ==========

  /**
   * 计算从节点中心到目标点的射线与节点边界的交点
   * 效果：连接线端点像水珠一样沿着节点边缘滑动
   */
  computePerimeterIntersection(bounds: go.Rect, targetPoint: go.Point): go.Point {
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    
    const dx = targetPoint.x - centerX;
    const dy = targetPoint.y - centerY;
    
    if (dx === 0 && dy === 0) {
      return new go.Point(centerX, bounds.y);
    }
    
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    
    let t = Infinity;
    
    if (dx > 0) {
      const tRight = halfWidth / dx;
      if (tRight < t && Math.abs(dy * tRight) <= halfHeight) {
        t = tRight;
      }
    }
    
    if (dx < 0) {
      const tLeft = -halfWidth / dx;
      if (tLeft < t && Math.abs(dy * tLeft) <= halfHeight) {
        t = tLeft;
      }
    }
    
    if (dy > 0) {
      const tBottom = halfHeight / dy;
      if (tBottom < t && Math.abs(dx * tBottom) <= halfWidth) {
        t = tBottom;
      }
    }
    
    if (dy < 0) {
      const tTop = -halfHeight / dy;
      if (tTop < t && Math.abs(dx * tTop) <= halfWidth) {
        t = tTop;
      }
    }
    
    if (t === Infinity) {
      return new go.Point(centerX, bounds.y);
    }
    
    return new go.Point(centerX + dx * t, centerY + dy * t);
  }

  /**
   * 计算节点边界交点（从节点获取）
   */
  computeNodeEdgePoint(node: go.Node, targetPoint: go.Point): go.Point {
    const bodyPanel = node.findObject("BODY") as go.Panel;
    let bounds: go.Rect;
    
    if (bodyPanel) {
      bounds = bodyPanel.getDocumentBounds();
    } else {
      bounds = node.actualBounds;
      if (!bounds.isReal() || bounds.width === 0 || bounds.height === 0) {
        return node.getDocumentPoint(go.Spot.Center);
      }
      const loc = node.location;
      bounds = new go.Rect(
        loc.x - bounds.width / 2,
        loc.y - bounds.height / 2,
        bounds.width,
        bounds.height
      );
    }
    
    if (!bounds.isReal()) {
      return node.getDocumentPoint(go.Spot.Center);
    }
    
    return this.computePerimeterIntersection(bounds, targetPoint);
  }

  // ========== 连接线模板 ==========

  /**
   * 设置连接线模板
   * 
   * 包括：
   * - LinkingTool/RelinkingTool 配置
   * - 临时连接线样式
   * - 永久连接线模板
   * - 跨树连接标签面板
   */
  setupLinkTemplate(diagram: go.Diagram): void {
    const $ = go.GraphObject.make;
    const isMobile = this.uiState.isMobile();
    const allowedPortIds = ["T", "B", "L", "R"];
    const linkStyleConfig = this.getLinkStyleConfig(isMobile);
    const pointerTolerance = isMobile ? 6 : 3;
    
    const freeAngleLinkPoint = this.createGetLinkPointFunction(diagram, allowedPortIds);

    setupLinkTemplates({
      diagram,
      isMobile,
      allowedPortIds,
      linkStyleConfig,
      freeAngleLinkPoint,
      pointerTolerance,
      make: $,
      configService: this.configService,
      relinkToolService: this.relinkToolService,
      configureLinkingTool: (targetDiagram, ports, getLinkPoint, make) =>
        this.configureLinkingTool(targetDiagram, ports, getLinkPoint, make),
    });
    
    this.logger.debug('连接线模板已设置（含 crossTree 分类模板）');
  }

  /**
   * 创建 getLinkPoint 函数
   */
  private createGetLinkPointFunction(
    _diagram: go.Diagram,
    _allowedPortIds: string[]
  ): go.Link['getLinkPoint'] {
    return createFreeAngleLinkPoint((node, target) => this.computeNodeEdgePoint(node, target));
  }

  /**
   * 配置 LinkingTool
   */
  private configureLinkingTool(
    diagram: go.Diagram,
    allowedPortIds: string[],
    freeAngleLinkPoint: go.Link['getLinkPoint'],
    $: GojsMake
  ): void {
    configureLinkingToolHelper({
      diagram,
      allowedPortIds,
      freeAngleLinkPoint,
      make: $,
    });
  }

  // ========== Overview 连接线模板 ==========

  /**
   * 设置 Overview 连接线模板（简化版 - 性能优化）
   * 
   * 关键优化：
   * 1. 使用直线而非曲线：减少计算开销
   * 2. 去掉颜色绑定：使用固定颜色
   */
  setupOverviewLinkTemplate(overview: go.Overview): void {
    const $ = go.GraphObject.make;
    const styles = this.configService.currentStyles();
    
    // 简化的连接线模板 - 直线 + 固定颜色
    overview.linkTemplate = $(go.Link,
      {
        routing: go.Link.Normal,
        curve: go.Link.None  // 直线，不用 Bezier
      },
      $(go.Shape,
        {
          // 进一步增加粗细和不透明度，确保在小地图缩放后依然清晰可见
          strokeWidth: 12,
          stroke: styles.link.parentChildColor,
          opacity: 1.0 // 完全不透明以消除虚边
        }
      )
    );
    
    this.logger.debug('Overview 连接线模板已设置（简化版）');
  }
}
