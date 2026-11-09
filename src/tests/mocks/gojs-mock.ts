import {
  Binding,
  GOJS_MOCK_OBJECT,
  Margin,
  MockGoBase,
  Point,
  Rect,
  Size,
  Spot,
  createEnumBag,
  createMockClass,
  createRecursiveStub,
  isPlainRecord,
  type UnknownRecord,
  wrapInstance,
} from './gojs-mock-core';

export {
  Binding,
  Margin,
  Point,
  Rect,
  Size,
  Spot,
};

function isTemplateConfig(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && value[GOJS_MOCK_OBJECT] !== true;
}

function cloneDataArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isPlainRecord)
    .map((entry) => ({ ...entry }));
}

function mergeDataArray(
  current: Record<string, unknown>[],
  incoming: unknown,
  keyProperty: string,
): Record<string, unknown>[] {
  if (!Array.isArray(incoming)) {
    return [...current];
  }

  const currentByKey = new globalThis.Map<string, Record<string, unknown>>();
  const withoutKeys: Record<string, unknown>[] = [];
  for (const entry of current) {
    const key = entry[keyProperty];
    if (typeof key === 'string' && key.length > 0) {
      currentByKey.set(key, entry);
      continue;
    }
    withoutKeys.push({ ...entry });
  }

  const merged: Record<string, unknown>[] = [];
  for (const candidate of incoming) {
    if (!isPlainRecord(candidate)) {
      continue;
    }

    const key = candidate[keyProperty];
    if (typeof key === 'string' && key.length > 0) {
      const existing = currentByKey.get(key);
      merged.push(existing ? { ...existing, ...candidate } : { ...candidate });
      currentByKey.delete(key);
      continue;
    }

    merged.push({ ...candidate });
  }

  return [...merged, ...withoutKeys, ...Array.from(currentByKey.values(), (entry) => ({ ...entry }))];
}

function setNestedValue(target: UnknownRecord, key: string, value: unknown): void {
  if (!key.includes('.')) {
    target[key] = value;
    return;
  }

  const parts = key.split('.').filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  let current: UnknownRecord = target;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (typeof existing === 'object' && existing !== null) {
      current = existing as UnknownRecord;
      continue;
    }

    const nested = createRecursiveStub() as UnknownRecord;
    current[part] = nested;
    current = nested;
  }

  current[parts[parts.length - 1]] = value;
}

function applyTemplateConfig(target: UnknownRecord, config: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(config)) {
    setNestedValue(target, key, value);
  }
}

export class GraphObject extends MockGoBase {
  static make(kind?: unknown, ...args: unknown[]) {
    if (kind === undefined || kind === null) {
      throw new Error('gojs-mock: GraphObject.make called without a valid kind');
    }

    if (typeof kind === 'function') {
      const supportsCtorArgs = kind === Diagram || kind === Overview || kind === GraphLinksModel || kind === Model;
      const config = supportsCtorArgs
        ? args.find((arg, index) => index > 0 && isTemplateConfig(arg))
        : args.find(isTemplateConfig);
      const ctorArgs = kind === Diagram || kind === Overview
        ? (args.length > 0 ? [args[0]] : [])
        : (supportsCtorArgs ? args.filter((arg) => arg !== config) : []);
      const instance = new (kind as new (...ctorArgs: unknown[]) => UnknownRecord)(...ctorArgs);
      const children = args.filter((arg) => arg !== config);

      if (typeof args[0] === 'string') {
        instance.panelType = args[0];
      }
      if (config) {
        applyTemplateConfig(instance, config as Record<string, unknown>);
      }
      instance.mockArgs = args;
      instance.mockChildren = children;
      return instance;
    }

    return wrapInstance({ [GOJS_MOCK_OBJECT]: true, kind, args });
  }
}

class MockGraphLinksModel extends MockGoBase {
  public nodeDataArray: Record<string, unknown>[];
  public linkDataArray: Record<string, unknown>[];
  public linkKeyProperty!: string;
  public nodeKeyProperty!: string;
  public linkFromPortIdProperty!: string;
  public linkToPortIdProperty!: string;
  public linkCategoryProperty!: string;

  constructor(
    nodeDataArray: unknown[] = [],
    linkDataArray: unknown[] = [],
    initial?: Record<string, unknown>,
  ) {
    super(isPlainRecord(initial) ? initial : undefined);
    this.nodeDataArray = cloneDataArray(nodeDataArray);
    this.linkDataArray = cloneDataArray(linkDataArray);
    if (!Object.prototype.hasOwnProperty.call(this, 'linkKeyProperty')) {
      this.linkKeyProperty = 'key';
    }
    if (!Object.prototype.hasOwnProperty.call(this, 'nodeKeyProperty')) {
      this.nodeKeyProperty = 'key';
    }
    if (!Object.prototype.hasOwnProperty.call(this, 'linkFromPortIdProperty')) {
      this.linkFromPortIdProperty = 'fromPortId';
    }
    if (!Object.prototype.hasOwnProperty.call(this, 'linkToPortIdProperty')) {
      this.linkToPortIdProperty = 'toPortId';
    }
    if (!Object.prototype.hasOwnProperty.call(this, 'linkCategoryProperty')) {
      this.linkCategoryProperty = 'category';
    }
  }

  addLinkData(data: Record<string, unknown>): void {
    if (!isPlainRecord(data)) {
      return;
    }
    this.linkDataArray = [...this.linkDataArray, { ...data }];
  }

  addNodeData(data: Record<string, unknown>): void {
    if (!isPlainRecord(data)) {
      return;
    }
    this.nodeDataArray = [...this.nodeDataArray, { ...data }];
  }

  findNodeDataForKey(key: unknown): Record<string, unknown> | null {
    return this.nodeDataArray.find((entry) => entry[this.nodeKeyProperty] === key) ?? null;
  }

  mergeLinkDataArray(data: unknown): void {
    this.linkDataArray = mergeDataArray(this.linkDataArray, data, this.linkKeyProperty);
  }

  mergeNodeDataArray(data: unknown): void {
    this.nodeDataArray = mergeDataArray(this.nodeDataArray, data, this.nodeKeyProperty);
  }

  removeLinkData(data: Record<string, unknown>): void {
    if (!isPlainRecord(data)) {
      return;
    }
    const key = data[this.linkKeyProperty];
    this.linkDataArray = this.linkDataArray.filter((entry) => entry !== data && entry[this.linkKeyProperty] !== key);
  }

  removeNodeData(data: Record<string, unknown>): void {
    if (!isPlainRecord(data)) {
      return;
    }
    const key = data[this.nodeKeyProperty];
    this.nodeDataArray = this.nodeDataArray.filter((entry) => entry !== data && entry[this.nodeKeyProperty] !== key);
  }

  setDataProperty(data: Record<string, unknown>, propertyName: string, value: unknown): void {
    if (!isPlainRecord(data)) {
      return;
    }
    data[propertyName] = value;
  }
}

class MockDiagram extends MockGoBase {
  constructor(div?: unknown, initial?: Record<string, unknown>) {
    super();
    (this as UnknownRecord).div = div ?? null;
    (this as UnknownRecord).lastInput = createRecursiveStub({
      documentPoint: new Point(),
      viewPoint: new Point(),
      handled: false,
    });
    (this as UnknownRecord).position = new Point();
    (this as UnknownRecord).viewportBounds = new Rect(0, 0, 0, 0);
    (this as UnknownRecord).documentBounds = new Rect(0, 0, 0, 0);
    (this as UnknownRecord).selection = createRecursiveStub();
    (this as UnknownRecord).nodes = createRecursiveStub();
    (this as UnknownRecord).links = createRecursiveStub();
    (this as UnknownRecord).linkTemplateMap = createRecursiveStub();
    (this as UnknownRecord).nodeTemplateMap = createRecursiveStub();
    (this as UnknownRecord).groupTemplateMap = createRecursiveStub();
    (this as UnknownRecord).toolManager = createRecursiveStub({
      clickSelectingTool: createRecursiveStub(),
      contextMenuTool: createRecursiveStub(),
      dragSelectingTool: createRecursiveStub(),
      draggingTool: createRecursiveStub(),
      linkingTool: createRecursiveStub(),
      panningTool: createRecursiveStub(),
      relinkingTool: createRecursiveStub(),
    });
    if (!Object.prototype.hasOwnProperty.call(this, 'model')) {
      (this as UnknownRecord).model = new MockGraphLinksModel();
    }
    if (isPlainRecord(initial)) {
      applyTemplateConfig(this as UnknownRecord, initial);
    }
  }
}

class MockOverview extends MockGoBase {
  constructor(div?: unknown, initial?: Record<string, unknown>) {
    super();
    (this as UnknownRecord).div = div ?? null;
    (this as UnknownRecord).animationManager = createRecursiveStub();
    (this as UnknownRecord).box = createRecursiveStub({ actualBounds: new Rect(0, 0, 0, 0) });
    (this as UnknownRecord).observed = null;
    (this as UnknownRecord).position = new Point();
    (this as UnknownRecord).scale = 1;
    (this as UnknownRecord).viewportBounds = new Rect(0, 0, 0, 0);
    if (isPlainRecord(initial)) {
      applyTemplateConfig(this as UnknownRecord, initial);
    }
  }
}

export const Diagram = createMockClass('Diagram', {
  Uniform: 'Uniform',
  InfiniteScroll: 'InfiniteScroll',
  None: 'None',
}, MockDiagram);
export const Overview = createMockClass('Overview', {}, MockOverview);
export const Layout = createMockClass('Layout');
export const TreeLayout = createMockClass('TreeLayout');
export const LayeredDigraphLayout = createMockClass('LayeredDigraphLayout');
export const GraphLinksModel = createMockClass('GraphLinksModel', {}, MockGraphLinksModel);
export const Model = createMockClass('Model');
export const Node = createMockClass('Node');
export const Link = createMockClass('Link', {
  Bezier: 'Bezier',
  None: 'None',
  Normal: 'Normal',
});
export const LinkingTool = createMockClass('LinkingTool');
export const RelinkingTool = createMockClass('RelinkingTool');
export const Router = createMockClass('Router');
export const Shape = createMockClass('Shape');
export const TextBlock = createMockClass('TextBlock', {
  OverflowEllipsis: 'OverflowEllipsis',
  WrapFit: 'WrapFit',
});
export const Panel = createMockClass('Panel');
export const Layer = createMockClass('Layer');
export const Part = createMockClass('Part');
export const Adornment = createMockClass('Adornment');
export const Placeholder = createMockClass('Placeholder');
export const Brush = createMockClass('Brush');
export const InputEvent = createMockClass('InputEvent');
export const DiagramEvent = createMockClass('DiagramEvent');
export const DiagramEventName = createEnumBag({});
export const ObjectData = createMockClass('ObjectData');
export const List = createMockClass('List');
export const Set = createMockClass('Set');
export const Map = createMockClass('Map');
export const Picture = createMockClass('Picture');

Spot.Top = new Spot(0.5, 0);
Spot.Bottom = new Spot(0.5, 1);
Spot.Left = new Spot(0, 0.5);
Spot.Right = new Spot(1, 0.5);
Spot.Center = new Spot(0.5, 0.5);
Spot.None = new Spot(NaN, NaN);
Spot.AllSides = new Spot(0.5, 0.5);

export const Orientation = createEnumBag({
  Along: 'Along',
});

const go = {
  Diagram,
  Overview,
  Layout,
  TreeLayout,
  LayeredDigraphLayout,
  GraphLinksModel,
  Model,
  GraphObject,
  Node,
  Link,
  LinkingTool,
  RelinkingTool,
  Router,
  Shape,
  TextBlock,
  Panel,
  Layer,
  Part,
  Adornment,
  Placeholder,
  Brush,
  InputEvent,
  DiagramEvent,
  DiagramEventName,
  ObjectData,
  Point,
  Size,
  Rect,
  Margin,
  Spot,
  Binding,
  List,
  Set,
  Map,
  Picture,
  Orientation,
};

export default go;
