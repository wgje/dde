/**
 * GoJS 空壳 Mock（Hollow Shell Pattern）
 * 
 * 目的：在单元测试中阻止真实 GoJS 加载
 * - GoJS 依赖 HTML5 Canvas API，在 happy-dom 中不完整
 * - 初始化复杂对象图，消耗数百毫秒
 * - 测试"如何使用 GoJS"，而非 GoJS 本身
 * 
 * @see docs/test-architecture-modernization-plan.md Section 2.3.1
 */
import { vi } from 'vitest';

// ============================================
// GraphObject - GoJS 核心工厂类
// ============================================
export class GraphObject {
  /**
   * GraphObject.make 是 GoJS 的核心工厂函数
   * 用于创建节点、链接、形状等元素
   */
  static make = vi.fn((type: unknown, ...args: unknown[]) => {
    const obj: Record<string, unknown> = {
      type,
      props: args,
      bind: vi.fn().mockReturnThis(),
      add: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    return obj;
  });
}

// ============================================
// Diagram - 图表核心类
// ============================================
export class Diagram {
  div: string | HTMLDivElement | null;
  model: unknown = {};
  nodes = { each: vi.fn(), count: 0, iterator: { first: vi.fn() } };
  links = { each: vi.fn(), count: 0, iterator: { first: vi.fn() } };
  selection = { 
    each: vi.fn(), 
    first: vi.fn(), 
    count: 0,
    iterator: { first: vi.fn() },
  };
  
  // 图表属性
  scale = 1;
  position = { x: 0, y: 0 };
  contentAlignment = {};
  autoScale = {};
  initialAutoScale = {};
  initialContentAlignment = {};
  padding = 10;
  animationManager = { isEnabled: false };
  toolManager = {
    dragSelectingTool: {},
    panningTool: {},
    draggingTool: { isGridSnapEnabled: false },
    linkingTool: {},
    relinkingTool: {},
  };
  commandHandler = {
    canDeleteSelection: vi.fn().mockReturnValue(true),
    deleteSelection: vi.fn(),
  };
  undoManager = { isEnabled: false };
  grid = {};
  nodeTemplate = {};
  linkTemplate = {};
  
  // 视图边界
  viewportBounds = { x: 0, y: 0, width: 800, height: 600 };
  documentBounds = { x: -500, y: -500, width: 2000, height: 2000 };
  
  constructor(divOrNull: string | HTMLDivElement | null = null) {
    this.div = divOrNull;
  }
  
  // 事务控制
  startTransaction = vi.fn((name?: string) => true);
  commitTransaction = vi.fn((name?: string) => true);
  rollbackTransaction = vi.fn(() => true);
  
  // 节点/链接操作
  findNodeForKey = vi.fn((_key: unknown) => null);
  findLinkForData = vi.fn((_data: unknown) => null);
  findNodeForData = vi.fn((_data: unknown) => null);
  findLinkForKey = vi.fn((_key: unknown) => null);
  findPartForKey = vi.fn((_key: unknown) => null);
  
  // 选择操作
  select = vi.fn();
  selectCollection = vi.fn();
  clearSelection = vi.fn();
  
  // 事件监听
  addDiagramListener = vi.fn((_name: string, _handler: unknown) => {});
  removeDiagramListener = vi.fn((_name: string, _handler: unknown) => {});
  addModelChangedListener = vi.fn((_handler: unknown) => {});
  removeModelChangedListener = vi.fn((_handler: unknown) => {});
  addChangedListener = vi.fn((_handler: unknown) => {});
  removeChangedListener = vi.fn((_handler: unknown) => {});
  
  // 生命周期
  clear = vi.fn();
  requestUpdate = vi.fn();
  delayInitialization = vi.fn((_callback: unknown) => {});
  
  // 视图控制
  zoomToFit = vi.fn();
  zoomToRect = vi.fn();
  centerRect = vi.fn();
  scroll = vi.fn();
  scrollToRect = vi.fn();
  alignDocument = vi.fn();
  
  // 布局
  layoutDiagram = vi.fn((_onlyVisible?: boolean) => {});
  
  // 数据操作
  set(obj: Record<string, unknown>) {
    Object.assign(this, obj);
  }
  
  // 渲染
  makeImage = vi.fn((_options?: unknown) => 'data:image/png;base64,mock');
  makeImageData = vi.fn((_options?: unknown) => 'data:image/png;base64,mock');
  makeSvg = vi.fn((_options?: unknown) => document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
}

// ============================================
// Overview - 缩略图类
// ============================================
export class Overview extends Diagram {
  observed: Diagram | null = null;
  
  constructor(divOrNull: string | HTMLDivElement | null = null) {
    super(divOrNull);
  }
}

// ============================================
// Palette - 调色板类
// ============================================
export class Palette extends Diagram {
  constructor(divOrNull: string | HTMLDivElement | null = null) {
    super(divOrNull);
  }
}

// ============================================
// Part - 节点/链接基类
// ============================================
export class Part {
  data: unknown = {};
  location = { x: 0, y: 0, copy: vi.fn() };
  position = { x: 0, y: 0 };
  actualBounds = { x: 0, y: 0, width: 100, height: 50 };
  diagram: Diagram | null = null;
  isSelected = false;
  
  findObject = vi.fn((_name: string) => null);
  updateTargetBindings = vi.fn();
}

// ============================================
// Node - 节点类
// ============================================
export class Node extends Part {
  key: unknown = null;
  isTreeExpanded = true;
  wasTreeExpanded = true;
  
  findLinksConnected = vi.fn(() => ({ iterator: { each: vi.fn() } }));
  findLinksOutOf = vi.fn(() => ({ iterator: { each: vi.fn() } }));
  findLinksInto = vi.fn(() => ({ iterator: { each: vi.fn() } }));
  findNodesConnected = vi.fn(() => ({ iterator: { each: vi.fn() } }));
  collapseTree = vi.fn();
  expandTree = vi.fn();
}

// ============================================
// Link - 链接类
// ============================================
export class Link extends Part {
  fromNode: Node | null = null;
  toNode: Node | null = null;
  fromPort: unknown = null;
  toPort: unknown = null;
  points = [];
  
  findObject = vi.fn((_name: string) => null);
}

// ============================================
// 模型类
// ============================================
export class Model {
  nodeDataArray: unknown[] = [];
  
  constructor(nodeDataArray?: unknown[]) {
    this.nodeDataArray = nodeDataArray || [];
  }
  
  addNodeData = vi.fn((data: unknown) => {
    this.nodeDataArray.push(data);
  });
  removeNodeData = vi.fn((data: unknown) => {
    const idx = this.nodeDataArray.indexOf(data);
    if (idx >= 0) this.nodeDataArray.splice(idx, 1);
  });
  setDataProperty = vi.fn((_data: unknown, _propname: string, _val: unknown) => {});
  findNodeDataForKey = vi.fn((_key: unknown) => null);
  containsNodeData = vi.fn((_data: unknown) => false);
  
  // 事务
  commit = vi.fn((_func: unknown, _name?: string) => {});
  startTransaction = vi.fn((_name?: string) => true);
  commitTransaction = vi.fn((_name?: string) => true);
  rollbackTransaction = vi.fn(() => true);
}

export class GraphLinksModel extends Model {
  linkDataArray: unknown[] = [];
  
  constructor(nodeDataArray?: unknown[], linkDataArray?: unknown[]) {
    super(nodeDataArray);
    this.linkDataArray = linkDataArray || [];
  }
  
  addLinkData = vi.fn((data: unknown) => {
    this.linkDataArray.push(data);
  });
  removeLinkData = vi.fn((data: unknown) => {
    const idx = this.linkDataArray.indexOf(data);
    if (idx >= 0) this.linkDataArray.splice(idx, 1);
  });
  findLinkDataForKey = vi.fn((_key: unknown) => null);
  containsLinkData = vi.fn((_data: unknown) => false);
}

export class TreeModel extends Model {
  constructor(nodeDataArray?: unknown[]) {
    super(nodeDataArray);
  }
}

// ============================================
// 布局类
// ============================================
export class Layout {
  diagram: Diagram | null = null;
  network: unknown = null;
  isOngoing = true;
  isInitial = true;
  isViewportSized = false;
  
  doLayout = vi.fn((_coll?: unknown) => {});
  invalidateLayout = vi.fn();
}

export class TreeLayout extends Layout {
  angle = 0;
  layerSpacing = 50;
  nodeSpacing = 20;
  arrangement = {};
  compaction = {};
}

export class LayeredDigraphLayout extends Layout {
  direction = 0;
  layerSpacing = 50;
  columnSpacing = 20;
  packOption = 0;
}

export class ForceDirectedLayout extends Layout {
  maxIterations = 100;
  defaultSpringLength = 50;
  defaultElectricalCharge = 150;
}

export class GridLayout extends Layout {
  wrappingWidth = Infinity;
  cellSize = { width: 100, height: 100 };
  spacing = { width: 10, height: 10 };
}

export class CircularLayout extends Layout {
  radius = 100;
  spacing = 20;
}

// ============================================
// 几何类
// ============================================
export class Point {
  x: number;
  y: number;
  
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  
  copy = () => new Point(this.x, this.y);
  equals = (p: Point) => this.x === p.x && this.y === p.y;
  static parse = vi.fn((_str: string) => new Point());
  static stringify = vi.fn((p: Point) => `${p.x} ${p.y}`);
}

export class Size {
  width: number;
  height: number;
  
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }
  
  copy = () => new Size(this.width, this.height);
}

export class Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
  
  copy = () => new Rect(this.x, this.y, this.width, this.height);
  static parse = vi.fn((_str: string) => new Rect());
  static stringify = vi.fn((r: Rect) => `${r.x} ${r.y} ${r.width} ${r.height}`);
  containsPoint = vi.fn((_p: Point) => false);
  containsRect = vi.fn((_r: Rect) => false);
  intersectsRect = vi.fn((_r: Rect) => false);
  center = new Point();
}

export class Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
  
  constructor(top = 0, right = 0, bottom = 0, left = 0) {
    this.top = top;
    this.right = right;
    this.bottom = bottom;
    this.left = left;
  }
}

export class Spot {
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  
  constructor(x = 0.5, y = 0.5, ox = 0, oy = 0) {
    this.x = x;
    this.y = y;
    this.offsetX = ox;
    this.offsetY = oy;
  }
  
  // 常用位置常量
  static Center = new Spot(0.5, 0.5);
  static Top = new Spot(0.5, 0);
  static Bottom = new Spot(0.5, 1);
  static Left = new Spot(0, 0.5);
  static Right = new Spot(1, 0.5);
  static TopLeft = new Spot(0, 0);
  static TopRight = new Spot(1, 0);
  static BottomLeft = new Spot(0, 1);
  static BottomRight = new Spot(1, 1);
  static TopSide = new Spot(0.5, 0, 0, 0);
  static BottomSide = new Spot(0.5, 1, 0, 0);
  static LeftSide = new Spot(0, 0.5, 0, 0);
  static RightSide = new Spot(1, 0.5, 0, 0);
  static AllSides = new Spot(0.5, 0.5, 0, 0);
  static None = new Spot(0, 0, NaN, NaN);
  static Default = new Spot(0, 0, NaN, NaN);
}

export class Geometry {
  type: number;
  figures: unknown[] = [];
  
  constructor(type = 0) {
    this.type = type;
  }
  
  static Line = 0;
  static Rectangle = 1;
  static Ellipse = 2;
  static Path = 3;
  
  static parse = vi.fn((_str: string) => new Geometry());
  static stringify = vi.fn((_g: Geometry) => '');
}

export class PathFigure {
  startX: number;
  startY: number;
  segments: unknown[] = [];
  
  constructor(startX = 0, startY = 0, isFilled = true, isShadowed = true) {
    this.startX = startX;
    this.startY = startY;
  }
}

export class PathSegment {
  type: number;
  endX: number;
  endY: number;
  
  constructor(type = 0, ex = 0, ey = 0) {
    this.type = type;
    this.endX = ex;
    this.endY = ey;
  }
  
  static Line = 0;
  static Arc = 1;
  static Bezier = 2;
  static QuadraticBezier = 3;
  static Move = 4;
}

// ============================================
// Brush（画刷）
// ============================================
export class Brush {
  type: string;
  color: string;
  
  constructor(type = 'Solid') {
    this.type = type;
    this.color = 'black';
  }
  
  static randomColor = vi.fn((_min?: number, _max?: number) => '#000000');
  
  static Solid = 'Solid';
  static Linear = 'Linear';
  static Radial = 'Radial';
  static Pattern = 'Pattern';
}

// ============================================
// Binding（数据绑定）
// ============================================
export class Binding {
  targetProperty: string;
  sourceName: string;
  converter: unknown;
  backConverter: unknown;
  mode: number;
  
  constructor(target = '', source = '', converter?: unknown) {
    this.targetProperty = target;
    this.sourceName = source;
    this.converter = converter;
    this.backConverter = undefined;
    this.mode = 0;
  }
  
  makeTwoWay = vi.fn((_backconv?: unknown) => this);
  ofObject = vi.fn((_srcname?: string) => this);
  ofModel = vi.fn(() => this);
  
  static TwoWay = 1;
  static OneWay = 0;
}

// ============================================
// 动画管理器
// ============================================
export class AnimationManager {
  isEnabled = false;
  isAnimating = false;
  duration = 600;
  
  stopAnimation = vi.fn();
  canStart = vi.fn(() => true);
}

export class Animation {
  duration = 600;
  easing: unknown = null;
  
  add = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

// ============================================
// 工具类
// ============================================
export class Tool {
  diagram: Diagram | null = null;
  name = '';
  isActive = false;
  isEnabled = true;
  
  canStart = vi.fn(() => true);
  doStart = vi.fn();
  doStop = vi.fn();
  doCancel = vi.fn();
}

export class ClickSelectingTool extends Tool {}
export class DragSelectingTool extends Tool {
  box: unknown = null;
  delay = 175;
}
export class PanningTool extends Tool {}
export class DraggingTool extends Tool {
  isGridSnapEnabled = false;
}
export class ResizingTool extends Tool {}
export class RotatingTool extends Tool {}
export class LinkingTool extends Tool {}
export class RelinkingTool extends Tool {}
export class LinkReshapingTool extends Tool {}
export class TextEditingTool extends Tool {}

// ============================================
// 命令处理器
// ============================================
export class CommandHandler {
  diagram: Diagram | null = null;
  
  canDeleteSelection = vi.fn(() => true);
  deleteSelection = vi.fn();
  canCopySelection = vi.fn(() => true);
  copySelection = vi.fn();
  canCutSelection = vi.fn(() => true);
  cutSelection = vi.fn();
  canPasteSelection = vi.fn(() => true);
  pasteSelection = vi.fn();
  canUndo = vi.fn(() => false);
  undo = vi.fn();
  canRedo = vi.fn(() => false);
  redo = vi.fn();
  canSelectAll = vi.fn(() => true);
  selectAll = vi.fn();
  canZoomToFit = vi.fn(() => true);
  zoomToFit = vi.fn();
  canResetZoom = vi.fn(() => true);
  resetZoom = vi.fn();
  canGroupSelection = vi.fn(() => false);
  groupSelection = vi.fn();
  canUngroupSelection = vi.fn(() => false);
  ungroupSelection = vi.fn();
}

// ============================================
// 撤销管理器
// ============================================
export class UndoManager {
  isEnabled = false;
  maxHistoryLength = 999;
  history: unknown[] = [];
  historyIndex = -1;
  
  canUndo = vi.fn(() => false);
  undo = vi.fn();
  canRedo = vi.fn(() => false);
  redo = vi.fn();
  clear = vi.fn();
}

// ============================================
// 面板类型常量
// ============================================
export const Panel = {
  Position: 'Position',
  Vertical: 'Vertical',
  Horizontal: 'Horizontal',
  Auto: 'Auto',
  Spot: 'Spot',
  Table: 'Table',
  TableRow: 'TableRow',
  TableColumn: 'TableColumn',
  Viewbox: 'Viewbox',
  Grid: 'Grid',
  Link: 'Link',
  Graduated: 'Graduated',
};

// ============================================
// 形状类型常量
// ============================================
export const Shape = {
  Rectangle: 'Rectangle',
  RoundedRectangle: 'RoundedRectangle',
  Ellipse: 'Ellipse',
  Circle: 'Circle',
  Triangle: 'Triangle',
  Diamond: 'Diamond',
  LineH: 'LineH',
  LineV: 'LineV',
  MinusLine: 'MinusLine',
  PlusLine: 'PlusLine',
  XLine: 'XLine',
  None: 'None',
};

// ============================================
// 链接路由常量
// ============================================
export const Link$ = {
  Normal: 0,
  Orthogonal: 1,
  AvoidsNodes: 2,
};

// ============================================
// 其他导出
// ============================================
export const TextBlock = 'TextBlock';
export const Picture = 'Picture';

// 输入状态
export class InputEvent {
  diagram: Diagram | null = null;
  documentPoint = new Point();
  viewPoint = new Point();
  key = '';
  button = 0;
  buttons = 0;
  control = false;
  shift = false;
  alt = false;
  meta = false;
  handled = false;
  
  constructor() {}
}

export class DiagramEvent {
  diagram: Diagram | null = null;
  subject: unknown = null;
  parameter: unknown = null;
  name = '';
  
  constructor() {}
}

// 模型变更事件
export class ChangedEvent {
  diagram: Diagram | null = null;
  model: Model | null = null;
  change: number = 0;
  propertyName: string = '';
  object: unknown = null;
  oldValue: unknown = null;
  newValue: unknown = null;
  
  static Transaction = 0;
  static Property = 1;
  static Insert = 2;
  static Remove = 3;
}

// 事务
export class Transaction {
  name = '';
  changes: ChangedEvent[] = [];
  isComplete = false;
}

// List 和 Set
export class List<T = unknown> {
  private _items: T[] = [];
  
  get count() { return this._items.length; }
  get iterator() { 
    return { 
      each: (fn: (item: T) => void) => this._items.forEach(fn),
      first: () => this._items[0],
    }; 
  }
  
  add = (item: T) => { this._items.push(item); };
  remove = (item: T) => {
    const idx = this._items.indexOf(item);
    if (idx >= 0) this._items.splice(idx, 1);
  };
  clear = () => { this._items = []; };
  contains = (item: T) => this._items.includes(item);
  each = (fn: (item: T) => void) => this._items.forEach(fn);
  toArray = () => [...this._items];
}

export class Set<T = unknown> extends List<T> {}

export class Map<K = unknown, V = unknown> {
  private _map = new globalThis.Map<K, V>();
  
  get count() { return this._map.size; }
  
  add = (key: K, val: V) => { this._map.set(key, val); };
  get = (key: K) => this._map.get(key);
  remove = (key: K) => { this._map.delete(key); };
  clear = () => { this._map.clear(); };
  contains = (key: K) => this._map.has(key);
  each = (fn: (key: K, val: V) => void) => this._map.forEach((v, k) => fn(k, v));
}

// ============================================
// 默认导出（兼容 import * as go from 'gojs'）
// ============================================
export default {
  GraphObject,
  Diagram,
  Overview,
  Palette,
  Part,
  Node,
  Link,
  Model,
  GraphLinksModel,
  TreeModel,
  Layout,
  TreeLayout,
  LayeredDigraphLayout,
  ForceDirectedLayout,
  GridLayout,
  CircularLayout,
  Point,
  Size,
  Rect,
  Margin,
  Spot,
  Geometry,
  PathFigure,
  PathSegment,
  Brush,
  Binding,
  AnimationManager,
  Animation,
  Tool,
  ClickSelectingTool,
  DragSelectingTool,
  PanningTool,
  DraggingTool,
  ResizingTool,
  RotatingTool,
  LinkingTool,
  RelinkingTool,
  LinkReshapingTool,
  TextEditingTool,
  CommandHandler,
  UndoManager,
  Panel,
  Shape,
  Link$,
  TextBlock,
  Picture,
  InputEvent,
  DiagramEvent,
  ChangedEvent,
  Transaction,
  List,
  Set,
  Map,
};
