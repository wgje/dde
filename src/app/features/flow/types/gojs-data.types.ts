/**
 * GoJS 数据类型定义
 * 
 * 提取自 flow-diagram-config.service.ts 以打破循环依赖
 */

/**
 * GoJS 节点数据结构
 */
export interface GoJSNodeData {
  key: string;
  title: string;
  displayId: string;
  stage: number | null;
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
}

/**
 * GoJS 连接数据结构
 */
export interface GoJSLinkData {
  key: string;
  from: string;
  to: string;
  isCrossTree: boolean;
  /** 联系块标题（外显内容） */
  title?: string;
  /** 联系块详细描述 */
  description?: string;
  /** 始祖节点索引（用于血缘聚类） */
  rootAncestorIndex?: number;
  /** 家族专属颜色（HSL 格式） */
  familyColor?: string;
}

/**
 * GoJS 图表数据
 */
export interface GoJSDiagramData {
  nodeDataArray: GoJSNodeData[];
  linkDataArray: GoJSLinkData[];
}
