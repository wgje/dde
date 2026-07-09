export type UnknownRecord = Record<string | symbol, unknown>;

export const GOJS_MOCK_OBJECT = '__gojsMockObject';
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
const UNKNOWN_STUB_MEMBER = Symbol('unknownGojsStubMember');
type StubMemberFactory = (copyFactory: () => unknown) => unknown;

const createNoopMethod = () => (..._args: unknown[]) => undefined;
const createNullMethod = () => () => null;
const createFalseMethod = () => () => false;
const createEmptyArrayMethod = () => () => [];
const createIteratorMethod = () => () => ({ next: () => ({ done: true, value: undefined }) });
const createEmptyIterable = () => function* iterator(): Generator<never, void, unknown> {
  return;
};

const STRING_STUB_MEMBER_FACTORIES = new globalThis.Map<string, StubMemberFactory>([
  ['iterator', createIteratorMethod],
  ['each', createNoopMethod],
  ['copy', (copyFactory) => () => copyFactory()],
  ['first', createNullMethod],
  ['last', createNullMethod],
  ['elt', createNullMethod],
  ['count', () => 0],
  ['size', () => 0],
  ['length', () => 0],
  ['toArray', createEmptyArrayMethod],
  ['contains', createFalseMethod],
  ['includes', createFalseMethod],
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

function resolveCommonStubMember(prop: string | symbol, copyFactory: () => unknown): unknown {
  if (prop === Symbol.iterator) {
    return createEmptyIterable();
  }

  if (prop === Symbol.toPrimitive) {
    return () => undefined;
  }

  if (typeof prop !== 'string') {
    return UNKNOWN_STUB_MEMBER;
  }

  const factory = STRING_STUB_MEMBER_FACTORIES.get(prop);
  if (factory) {
    return factory(copyFactory);
  }

  if (CONTAINER_METHOD_NAMES.has(prop)) {
    return createNoopMethod();
  }

  return isBooleanLikeProperty(prop) ? false : UNKNOWN_STUB_MEMBER;
}

function createNestedRecursiveStub(state: UnknownRecord, prop: string | symbol): unknown {
  const nested = createRecursiveStub();
  state[prop] = nested;
  return nested;
}

function getRecursiveStubProperty(
  state: UnknownRecord,
  target: object,
  prop: string | symbol,
  receiver: unknown,
): unknown {
  if (prop === 'then') {
    return undefined;
  }

  if (Reflect.has(state, prop)) {
    return Reflect.get(state, prop, receiver);
  }

  if (Reflect.has(target, prop)) {
    return Reflect.get(target, prop, receiver);
  }

  const fallback = resolveCommonStubMember(prop, () => createRecursiveStub({ ...state }));
  if (fallback !== UNKNOWN_STUB_MEMBER) {
    return fallback;
  }

  if (isStrictGojsMockEnabled()) {
    throw createUnknownPropertyError(prop);
  }

  return createNestedRecursiveStub(state, prop);
}

export function createRecursiveStub(seed: UnknownRecord = {}): unknown {
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
      return getRecursiveStubProperty(state, target, prop, receiver);
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

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getWrappedInstanceProperty<T extends object>(
  target: T,
  prop: string | symbol,
  receiver: unknown,
): unknown {
  if (Reflect.has(target, prop)) {
    return Reflect.get(target, prop, receiver);
  }

  const fallback = resolveCommonStubMember(prop, () => wrapInstance({ ...(target as UnknownRecord) }));
  if (fallback !== UNKNOWN_STUB_MEMBER) {
    return fallback;
  }

  if (isStrictGojsMockEnabled()) {
    throw createUnknownPropertyError(prop);
  }

  const stub = createRecursiveStub();
  (target as UnknownRecord)[prop] = stub;
  return stub;
}

export function wrapInstance<T extends object>(value: T): T {
  return new Proxy(value, {
    get(target, prop, receiver) {
      return getWrappedInstanceProperty(target, prop, receiver);
    },
    set(target, prop, newValue) {
      (target as UnknownRecord)[prop] = newValue;
      return true;
    },
  });
}

export class MockGoBase {
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

export function createEnumBag(seed: Record<string, string>) {
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

export function createMockClass<TStatic extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  staticValues: TStatic = {} as TStatic,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor?: new (...args: any[]) => object,
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
  static Top: Spot;
  static Bottom: Spot;
  static Left: Spot;
  static Right: Spot;
  static Center: Spot;
  static None: Spot;
  static AllSides: Spot;

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
