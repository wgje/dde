type UnknownRecord = Record<string | symbol, unknown>;
const GOJS_MOCK_OBJECT = '__gojsMockObject';
const BOOLEAN_DEFAULT_PROPS = new globalThis.Set([
  'handled',
  'isActive',
  'isBackwards',
  'isEnabled',
  'isForwards',
  'isSelected',
]);
const CONTAINER_METHOD_NAMES = new globalThis.Set([
  'add',
  'clear',
  'delete',
  'remove',
]);

function isStrictGojsMockEnabled(): boolean {
  return Boolean((globalThis as { __GOJS_MOCK_STRICT__?: boolean }).__GOJS_MOCK_STRICT__ === true);
}

function createUnknownPropertyError(prop: string | symbol): Error {
  return new Error(`gojs-mock: unknown property access ${String(prop)}`);
}

function isBooleanLikeProperty(prop: string | symbol): boolean {
  return typeof prop === 'string' && BOOLEAN_DEFAULT_PROPS.has(prop);
}

function createRecursiveStub(seed: UnknownRecord = {}): unknown {
  const state: UnknownRecord = {
    [GOJS_MOCK_OBJECT]: true,
    ...seed,
  };
  const callable = function mockGoCallable(..._args: unknown[]) {
    return undefined;
  };

  return new Proxy(callable, {
    apply() {
      return undefined;
    },
    get(target, prop, receiver) {
      if (prop === 'then') {
        return undefined;
      }

      if (Reflect.has(state, prop)) {
        return Reflect.get(state, prop, receiver);
      }

      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }

      if (prop === Symbol.iterator) {
        return function* iterator(): Generator<never, void, unknown> {
          return;
        };
      }

      if (prop === Symbol.toPrimitive) {
        return () => undefined;
      }

      if (prop === 'iterator') {
        return () => ({ next: () => ({ done: true, value: undefined }) });
      }

      if (prop === 'each') {
        return (_callback: (value: unknown) => void) => undefined;
      }

      if (prop === 'copy') {
        return () => createRecursiveStub({ ...state });
      }

      if (prop === 'first' || prop === 'last' || prop === 'elt') {
        return () => null;
      }

      if (prop === 'count' || prop === 'size' || prop === 'length') {
        return 0;
      }

      if (prop === 'toArray') {
        return () => [];
      }

      if (prop === 'contains' || prop === 'includes') {
        return () => false;
      }

      if (typeof prop === 'string' && CONTAINER_METHOD_NAMES.has(prop)) {
        return (..._args: unknown[]) => undefined;
      }

      if (isBooleanLikeProperty(prop)) {
        return false;
      }

      if (isStrictGojsMockEnabled()) {
        throw createUnknownPropertyError(prop);
      }

      const nested = createRecursiveStub();
      state[prop] = nested;
      return nested;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (Reflect.has(state, prop)) {
        return {
          configurable: true,
          enumerable: true,
          value: state[prop],
          writable: true,
        };
      }

      return undefined;
    },
    ownKeys() {
      return Reflect.ownKeys(state);
    },
    set(_target, prop, newValue) {
      state[prop] = newValue;
      return true;
    },
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function wrapInstance<T extends object>(value: T): T {
  return new Proxy(value, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }

      if (prop === Symbol.iterator) {
        return function* iterator(): Generator<never, void, unknown> {
          return;
        };
      }

      if (prop === 'iterator') {
        return () => ({ next: () => ({ done: true, value: undefined }) });
      }

      if (prop === 'each') {
        return (_callback: (value: unknown) => void) => undefined;
      }

      if (prop === 'copy') {
        return () => wrapInstance({ ...(target as UnknownRecord) });
      }

      if (prop === 'first' || prop === 'last' || prop === 'elt') {
        return () => null;
      }

      if (prop === 'count' || prop === 'size' || prop === 'length') {
        return 0;
      }

      if (prop === 'toArray') {
        return () => [];
      }

      if (prop === 'contains' || prop === 'includes') {
        return () => false;
      }

      if (typeof prop === 'string' && CONTAINER_METHOD_NAMES.has(prop)) {
        return (..._args: unknown[]) => undefined;
      }

      if (isBooleanLikeProperty(prop)) {
        return false;
      }

      if (isStrictGojsMockEnabled()) {
        throw createUnknownPropertyError(prop);
      }

      const stub = createRecursiveStub();
      (target as UnknownRecord)[prop] = stub;
      return stub;
    },
    set(target, prop, newValue) {
      (target as UnknownRecord)[prop] = newValue;
      return true;
    },
  });
}

class MockGoBase {
  constructor(initial?: Record<string, unknown>) {
    Object.defineProperty(this, GOJS_MOCK_OBJECT, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });

    if (initial) {
      Object.assign(this, initial);
    }
    return wrapInstance(this);
  }
}

function createEnumBag(seed: Record<string, string>) {
  return new Proxy(seed, {
    get(target, prop) {
      if (typeof prop !== 'string') {
        return undefined;
      }
      if (!(prop in target)) {
        if (isStrictGojsMockEnabled()) {
          throw createUnknownPropertyError(prop);
        }
        return undefined;
      }
      return target[prop];
    },
  });
}

function createMockClass<TStatic extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  staticValues: TStatic = {} as TStatic,
  ctor?: new (...args: unknown[]) => object,
) {
  const MockClass = ctor ?? class MockClass extends MockGoBase {};

  Object.defineProperty(MockClass, 'name', { value: name });
  Object.assign(MockClass, staticValues);

  return new Proxy(MockClass, {
    get(target, prop, receiver) {
      const currentValue = Reflect.get(target, prop, receiver);
      if (currentValue !== undefined) {
        return currentValue;
      }

      if (typeof prop === 'string') {
        if (isStrictGojsMockEnabled()) {
          throw createUnknownPropertyError(prop);
        }
        return undefined;
      }

      return undefined;
    },
  });
}

export class Point extends MockGoBase {
  constructor(
    public x = 0,
    public y = 0,
  ) {
    super();
  }

  static parse(value: string): Point {
    const [x = '0', y = '0'] = String(value ?? '').trim().split(/\s+/);
    return new Point(Number(x) || 0, Number(y) || 0);
  }

  static stringify(point: { x?: number; y?: number } | null | undefined): string {
    return `${point?.x ?? 0} ${point?.y ?? 0}`;
  }

  copy(): Point {
    return new Point(this.x, this.y);
  }
  
  equals(point: { x?: number; y?: number } | null | undefined): boolean {
    return (point?.x ?? Number.NaN) === this.x && (point?.y ?? Number.NaN) === this.y;
  }

  isReal(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y);
  }
}

export class Size extends MockGoBase {
  constructor(
    public width = 0,
    public height = 0,
  ) {
    super();
  }
}

export class Rect extends MockGoBase {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {
    super();
  }

  get left(): number {
    return this.x;
  }

  get top(): number {
    return this.y;
  }

  get right(): number {
    return this.x + this.width;
  }

  get bottom(): number {
    return this.y + this.height;
  }

  get center(): Point {
    return new Point(this.x + this.width / 2, this.y + this.height / 2);
  }

  copy(): Rect {
    return new Rect(this.x, this.y, this.width, this.height);
  }

  inflate(width: number, height: number = width): this {
    this.x -= width;
    this.y -= height;
    this.width += width * 2;
    this.height += height * 2;
    return this;
  }

  containsPoint(point: { x?: number; y?: number } | null | undefined): boolean {
    if (!point || !this.isReal()) {
      return false;
    }

    const x = point.x ?? Number.NaN;
    const y = point.y ?? Number.NaN;
    return Number.isFinite(x)
      && Number.isFinite(y)
      && x >= this.left
      && x <= this.right
      && y >= this.top
      && y <= this.bottom;
  }

  containsRect(rect: { x?: number; y?: number; width?: number; height?: number } | null | undefined): boolean {
    if (!rect || !this.isReal()) {
      return false;
    }

    const x = rect.x ?? Number.NaN;
    const y = rect.y ?? Number.NaN;
    const width = rect.width ?? Number.NaN;
    const height = rect.height ?? Number.NaN;
    if (![x, y, width, height].every(Number.isFinite)) {
      return false;
    }

    return x >= this.left
      && y >= this.top
      && x + width <= this.right
      && y + height <= this.bottom;
  }

  isReal(): boolean {
    return [this.x, this.y, this.width, this.height].every(Number.isFinite);
  }

  unionRect(rect: { x?: number; y?: number; width?: number; height?: number } | null | undefined): this {
    if (!rect) {
      return this;
    }

    const x = rect.x ?? Number.NaN;
    const y = rect.y ?? Number.NaN;
    const width = rect.width ?? Number.NaN;
    const height = rect.height ?? Number.NaN;
    if (![x, y, width, height].every(Number.isFinite)) {
      return this;
    }

    const nextLeft = Math.min(this.left, x);
    const nextTop = Math.min(this.top, y);
    const nextRight = Math.max(this.right, x + width);
    const nextBottom = Math.max(this.bottom, y + height);

    this.x = nextLeft;
    this.y = nextTop;
    this.width = nextRight - nextLeft;
    this.height = nextBottom - nextTop;
    return this;
  }
}

export class Margin extends MockGoBase {
  constructor(
    public top = 0,
    public right = top,
    public bottom = top,
    public left = right,
  ) {
    super();
  }
}

export class Spot extends MockGoBase {
  constructor(
    public x = 0,
    public y = 0,
    public offsetX = 0,
    public offsetY = 0,
  ) {
    super();
  }
}

export class Binding extends MockGoBase {
  ofObject(): this {
    return this;
  }

  makeTwoWay(): this {
    return this;
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
        applyTemplateConfig(instance, config);
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
  public linkKeyProperty: string;
  public nodeKeyProperty: string;
  public linkFromPortIdProperty: string;
  public linkToPortIdProperty: string;
  public linkCategoryProperty: string;

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