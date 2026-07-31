import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const runtimePath = path.join(process.cwd(), 'scripts', 'context7-key-pool', 'runtime.cjs');
const runtimeModule = require(runtimePath) as {
  Context7PoolError: new (kind: string, details?: unknown, redact?: (value: unknown) => unknown) => Error & {
    kind: string;
    details?: unknown;
  };
  canonicalToolSignature: (tools: unknown[]) => string;
  classifyThrownError: (error: unknown) => Record<string, unknown>;
  classifyToolResult: (input: { result: unknown; failureEvidence: unknown }) => Record<string, unknown> | null;
  createPoolRuntime: (options: Record<string, unknown>) => {
    listTools: () => Promise<unknown[]>;
    callTool: (name: string, args: unknown, options?: { signal?: AbortSignal }) => Promise<any>;
    getPublicRuntime: () => Record<string, unknown>;
    getRouteOverride: () => Record<string, unknown> | null;
    close: () => Promise<void>;
  };
  outcomeForClassification: (classification: Record<string, unknown> | null) => Record<string, unknown>;
  validateOfficialToolArguments: (name: string, args: unknown) => void;
};

const {
  Context7PoolError,
  canonicalToolSignature,
  classifyThrownError,
  classifyToolResult,
  createPoolRuntime,
  outcomeForClassification,
  validateOfficialToolArguments,
} = runtimeModule;

const TOOLS = [
  {
    name: 'resolve-library-id',
    description: 'resolve',
    inputSchema: {
      type: 'object',
      properties: { libraryName: { type: 'string' }, query: { type: 'string' } },
      required: ['libraryName', 'query'],
    },
  },
  {
    name: 'query-docs',
    description: 'query',
    inputSchema: {
      type: 'object',
      properties: { libraryId: { type: 'string' }, query: { type: 'string' } },
      required: ['libraryId', 'query'],
    },
  },
];

const FP = ['a', 'b', 'c', 'd'].map(value => value.repeat(64));
const credentials = FP.map((fingerprintSha256, index) => ({
  slot: index + 1,
  name: `CONTEXT7_API_KEY_${index + 1}`,
  value: `fixture-secret-${index + 1}`,
  fingerprintSha256,
}));

function keyed(slot: number) {
  return { kind: 'keyed', periodId: '2026-07', slot, fingerprintSha256: FP[slot - 1] };
}

function success(text = 'ok') {
  return { content: [{ type: 'text', text }] };
}

function failureEvidence(status: number, retryAfterSeconds: number | null = null) {
  return { kind: 'http', status, retryAfterSeconds };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type HarnessOptions = {
  responses?: Record<string, Array<unknown>>;
  previewRoutes?: Array<Record<string, unknown>>;
  reserveResults?: Array<Record<string, unknown>>;
  schemaByFactoryCall?: unknown[][];
  recordOutcome?: (token: Record<string, unknown>, outcome: Record<string, unknown>) => Promise<void>;
  childFactoryFailureAt?: number;
  childFactoryGate?: Promise<void>;
  sleep?: (ms: number, options?: { signal?: AbortSignal }) => Promise<void>;
  operationTimeoutMs?: number;
  previewError?: unknown;
};

function createHarness(options: HarnessOptions = {}) {
  const events: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  const outcomes: Array<{ token: Record<string, unknown>; outcome: Record<string, unknown> }> = [];
  const children: any[] = [];
  const previewRoutes = [...(options.previewRoutes ?? [])];
  const reserveResults = [...(options.reserveResults ?? [])];
  const responses = Object.fromEntries(
    Object.entries(options.responses ?? { '1': [success()] }).map(([key, value]) => [key, [...value]]),
  );
  let currentSlot = 1;
  let ordinal = 0;
  let factoryCalls = 0;

  const store = {
    preview: vi.fn(async (_context: unknown, routeOptions: { excludeFingerprints?: string[] } = {}) => {
      events.push({ event: 'store.preview' });
      if (options.previewError !== undefined) throw options.previewError;
      if (previewRoutes.length > 0) return { route: previewRoutes.shift() };
      const excluded = new Set(routeOptions.excludeFingerprints ?? []);
      while (currentSlot <= 4 && excluded.has(FP[currentSlot - 1])) currentSlot += 1;
      return { route: currentSlot <= 4 ? keyed(currentSlot) : { kind: 'anonymous', reason: 'all-keyed-slots-unavailable' } };
    }),
    reserveExpected: vi.fn(async (_context: unknown, route: any) => {
      events.push({ event: 'store.reserve', slot: route.slot });
      if (reserveResults.length > 0) return reserveResults.shift();
      if (route.kind === 'anonymous') return { kind: 'anonymous', route, token: null };
      ordinal += 1;
      return {
        kind: 'keyed',
        route,
        token: { ...route, attemptOrdinal: ordinal, stateRevision: ordinal },
      };
    }),
    recordOutcome: vi.fn(async (_context: unknown, token: Record<string, unknown>, outcome: Record<string, unknown>) => {
      outcomes.push({ token, outcome });
      events.push({ event: 'store.outcome', slot: token.slot, kind: outcome.kind });
      if (options.recordOutcome) await options.recordOutcome(token, outcome);
      if (['auth-invalid', 'quota-exhausted', 'rate-limit'].includes(String(outcome.kind))) {
        currentSlot = Math.max(currentSlot, Number(token.slot) + 1);
      }
    }),
  };

  const childFactory = vi.fn(async (factoryOptions: any) => {
    factoryCalls += 1;
    if (options.childFactoryGate) await options.childFactoryGate;
    if (options.childFactoryFailureAt === factoryCalls) throw Object.assign(new Error('secret factory failure'), { code: 'EPIPE' });
    const route = factoryOptions.route;
    const key = route.kind === 'keyed' ? String(route.slot) : 'anonymous';
    const generation = factoryCalls;
    const exitListeners = new Set<() => void>();
    const child = {
      key,
      generation,
      tools: structuredClone(options.schemaByFactoryCall?.[factoryCalls - 1] ?? TOOLS),
      closed: false,
      close: vi.fn(async () => { child.closed = true; }),
      onExit(listener: () => void) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      exit() { for (const listener of [...exitListeners]) listener(); },
      callTool: vi.fn(async (name: string, args: unknown, callOptions: { signal?: AbortSignal } = {}) => {
        calls.push({ child, generation, key, name, args, signal: callOptions.signal });
        events.push({ event: 'child.dispatch', key, generation });
        const next = responses[key]?.shift() ?? success(`${key}-ok`);
        if (typeof next === 'function') return (next as Function)({ child, name, args, signal: callOptions.signal });
        if (next instanceof Error) throw next;
        return next;
      }),
    };
    children.push(child);
    events.push({ event: 'child.prepare', key, generation });
    return child;
  });

  const redact = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => (
    typeof entry === 'string' ? entry.replaceAll('fixture-secret', '[REDACTED]') : entry
  )));
  const pool = createPoolRuntime({
    credentials,
    store,
    childFactory,
    now: () => new Date('2026-07-31T00:00:00.000Z'),
    sleep: options.sleep ?? (async () => undefined),
    timeZone: 'UTC',
    redact,
    onEvent: (event: Record<string, unknown>) => events.push(event),
    operationTimeoutMs: options.operationTimeoutMs ?? 70_000,
  });
  return { pool, store, childFactory, children, calls, outcomes, events };
}

describe('Context7 pool helper contracts', () => {
  it('accepts only exact official tool arguments with non-empty trimmed strings', () => {
    expect(() => validateOfficialToolArguments('resolve-library-id', { libraryName: 'next.js', query: 'app router' })).not.toThrow();
    expect(() => validateOfficialToolArguments('query-docs', { libraryId: '/vercel/next.js', query: 'cache' })).not.toThrow();
    for (const [name, args] of [
      ['unknown', { query: 'x' }],
      ['resolve-library-id', null],
      ['resolve-library-id', { libraryName: 'next.js' }],
      ['resolve-library-id', { libraryName: ' ', query: 'x' }],
      ['resolve-library-id', { libraryName: ' next.js', query: 'x' }],
      ['query-docs', { libraryId: '/x', query: 'x', extra: 'forbidden' }],
    ] as const) {
      expect(() => validateOfficialToolArguments(name, args)).toThrowError(expect.objectContaining({
        kind: 'input-invalid', message: 'context7-pool-input-invalid',
      }));
    }
  });

  it('classifies only exact trusted result evidence and ignores arbitrary content', () => {
    expect(classifyToolResult({ result: success(), failureEvidence: null })).toBeNull();
    expect(classifyToolResult({ result: success('401 429 unauthorized Retry-After public-marker'), failureEvidence: null })).toBeNull();
    expect(classifyToolResult({ result: { ...success(), isError: true }, failureEvidence: null })).toEqual({ kind: 'transient' });
    expect(classifyToolResult({ result: success(), failureEvidence: failureEvidence(401) })).toEqual({ kind: 'auth-invalid' });
    expect(classifyToolResult({ result: success(), failureEvidence: failureEvidence(403) })).toEqual({ kind: 'auth-invalid' });
    expect(classifyToolResult({ result: success(), failureEvidence: failureEvidence(429, 8) })).toEqual({ kind: 'rate-limit', retryAfterMs: 8000 });
    expect(classifyToolResult({ result: success(), failureEvidence: failureEvidence(429) })).toEqual({ kind: 'quota-exhausted' });
    expect(classifyToolResult({ result: success(), failureEvidence: failureEvidence(404) })).toEqual({ kind: 'terminal-non-success', statusCode: 404 });
    expect(classifyToolResult({ result: success(), failureEvidence: failureEvidence(500) })).toEqual({ kind: 'transient' });
    expect(classifyToolResult({ result: success(), failureEvidence: { kind: 'transport', status: null, retryAfterSeconds: null } })).toEqual({ kind: 'transient' });
    expect(classifyToolResult({ result: success(), failureEvidence: { kind: 'observer-internal', status: null, retryAfterSeconds: null } })).toEqual({ kind: 'transient' });
    expect(classifyToolResult({ result: success('404'), failureEvidence: { kind: 'http', status: 404, retryAfterSeconds: null, marker: 'extra' } })).toBeNull();
  });

  it('classifies thrown errors only from typed SDK, JSON-RPC and Node fields', () => {
    expect(classifyThrownError({ code: -32602, message: 'timeout 500' })).toEqual({ kind: 'input-invalid' });
    for (const error of [
      { code: 'MCP_REQUEST_TIMEOUT' }, { code: 'MCP_CONNECTION_CLOSED' }, { code: 'EPIPE' },
      { code: 'ECONNRESET' }, { code: 'ECONNABORTED' }, { code: 'ETIMEDOUT' },
      { name: 'TimeoutError' }, { name: 'ConnectionClosedError' }, new Error('401 Retry-After: 999'),
    ]) expect(classifyThrownError(error)).toEqual({ kind: 'transient' });
  });

  it('projects every classification to a fresh exact policy outcome', () => {
    const cases = [
      [null, { kind: 'success' }],
      [{ kind: 'auth-invalid', result: 'secret' }, { kind: 'auth-invalid' }],
      [{ kind: 'rate-limit', retryAfterMs: 4000, marker: 'x' }, { kind: 'rate-limit', retryAfterMs: 4000 }],
      [{ kind: 'quota-exhausted', retryable: true }, { kind: 'quota-exhausted' }],
      [{ kind: 'terminal-non-success', statusCode: 404, child: 'x' }, { kind: 'terminal-non-success', statusCode: 404 }],
      [{ kind: 'transient', error: 'x' }, { kind: 'transient' }],
      [{ kind: 'input-invalid', query: 'x' }, { kind: 'input-invalid' }],
    ] as const;
    for (const [classification, expected] of cases) {
      const actual = outcomeForClassification(classification as any);
      expect(actual).toEqual(expected);
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      if (classification) expect(actual).not.toBe(classification);
    }
  });

  it('canonicalizes complete descriptors and Context7PoolError exposes only safe data', () => {
    const reordered = TOOLS.map(tool => ({ inputSchema: tool.inputSchema, description: tool.description, name: tool.name })).reverse();
    expect(canonicalToolSignature(reordered)).toBe(canonicalToolSignature(TOOLS));
    const error = new Context7PoolError('transient', { value: 'fixture-secret-1' }, value => JSON.parse(JSON.stringify(value).replaceAll('fixture-secret-1', '[REDACTED]')));
    expect(error.message).toBe('context7-pool-transient');
    expect(error.kind).toBe('transient');
    expect(error.details).toEqual({ value: '[REDACTED]' });
  });
});

describe('Context7 pool runtime', () => {
  it('serializes two concurrent calls in exact FIFO dispatch order', async () => {
    const first = deferred<any>();
    const harness = createHarness({ responses: { '1': [() => first.promise, success('second')] } });
    const one = harness.pool.callTool('query-docs', { libraryId: '/one', query: 'one' });
    const two = harness.pool.callTool('query-docs', { libraryId: '/two', query: 'two' });
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    first.resolve({ result: success('first'), failureEvidence: null });
    await expect(Promise.all([one, two])).resolves.toEqual([success('first'), success('second')]);
    expect(harness.calls.map(call => (call.args as any).query)).toEqual(['one', 'two']);
    expect(harness.events.filter(event => ['dispatch', 'outcome'].includes(String(event.event))))
      .toEqual([
        expect.objectContaining({ event: 'dispatch', attempt: 1 }),
        expect.objectContaining({ event: 'outcome', attempt: 1, failure: 'success' }),
        expect.objectContaining({ event: 'dispatch', attempt: 1 }),
        expect.objectContaining({ event: 'outcome', attempt: 1, failure: 'success' }),
      ]);
  });

  it('rejects invalid arguments before preview, reservation, child preparation or dispatch', async () => {
    const harness = createHarness();
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: ' ' })).rejects.toMatchObject({ kind: 'input-invalid' });
    expect(harness.store.preview).not.toHaveBeenCalled();
    expect(harness.store.reserveExpected).not.toHaveBeenCalled();
    expect(harness.childFactory).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it('initializes and schema-checks a child before reserving and listTools never reserves', async () => {
    const harness = createHarness();
    await expect(harness.pool.listTools()).resolves.toEqual(TOOLS);
    expect(harness.store.reserveExpected).not.toHaveBeenCalled();
    await harness.pool.callTool('resolve-library-id', { libraryName: 'next', query: 'router' });
    expect(harness.events.findIndex(event => event.event === 'child.prepare'))
      .toBeLessThan(harness.events.findIndex(event => event.event === 'store.reserve'));
  });

  it('closes and switches without dispatch when preview and reservation routes differ', async () => {
    const harness = createHarness({
      previewRoutes: [keyed(1), keyed(2)],
      reserveResults: [{ kind: 'retry', route: keyed(2) }, { kind: 'keyed', route: keyed(2), token: { ...keyed(2), attemptOrdinal: 1 } }],
      responses: { '2': [success('slot2')] },
    });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).resolves.toEqual(success('slot2'));
    expect(harness.calls.map(call => call.key)).toEqual(['2']);
    expect(harness.children[0].closed).toBe(true);
    expect(harness.pool.getPublicRuntime()).toMatchObject({ keyedDispatches: 1, anonymousDispatches: 0 });
  });

  it('closes prepared keyed child and prepares anonymous after fail-closed reservation', async () => {
    const anonymous = { kind: 'anonymous', reason: 'state-unavailable-fail-closed' };
    const harness = createHarness({
      previewRoutes: [keyed(1)],
      reserveResults: [{ kind: 'anonymous', route: anonymous, token: null }],
      responses: { anonymous: [success('anon')] },
    });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).resolves.toEqual(success('anon'));
    expect(harness.children.map(child => child.key)).toEqual(['1', 'anonymous']);
    expect(harness.children[0].closed).toBe(true);
    expect(harness.calls.map(call => call.key)).toEqual(['anonymous']);
  });

  it('records success after dispatch by the exact captured reservation token', async () => {
    const harness = createHarness();
    await harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' });
    expect(harness.outcomes).toHaveLength(1);
    expect(harness.outcomes[0].outcome).toEqual({ kind: 'success' });
    expect(harness.outcomes[0].token).toMatchObject({ slot: 1, attemptOrdinal: 1 });
    expect(harness.events.findIndex(event => event.event === 'child.dispatch'))
      .toBeLessThan(harness.events.findIndex(event => event.event === 'store.outcome'));
  });

  it('routes all classifier branches to recordOutcome with exact allowlisted shapes', async () => {
    const sequence = [
      { result: success(), failureEvidence: failureEvidence(401) },
      { result: success(), failureEvidence: failureEvidence(429, 2) },
      { result: success(), failureEvidence: failureEvidence(429) },
      { result: success(), failureEvidence: failureEvidence(404) },
    ];
    const harness = createHarness({ responses: { '1': [sequence[0]], '2': [sequence[1]], '3': [sequence[2]], '4': [sequence[3]] } });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: '401 429 marker' })).resolves.toMatchObject({ isError: true });
    expect(harness.outcomes.map(entry => entry.outcome)).toEqual([
      { kind: 'auth-invalid' },
      { kind: 'rate-limit', retryAfterMs: 2000 },
      { kind: 'quota-exhausted' },
      { kind: 'terminal-non-success', statusCode: 404 },
    ]);
    for (const { outcome } of harness.outcomes) {
      expect(JSON.stringify(outcome)).not.toMatch(/retryable|result|query|marker|error|child/);
    }
  });

  it('latches anonymous fail-closed after outcome persistence failure without redispatch', async () => {
    const harness = createHarness({
      responses: { '1': [success('completed')], anonymous: [success('anonymous')] },
      recordOutcome: async () => { throw new Error('state persistence secret'); },
    });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).resolves.toEqual(success('completed'));
    expect(harness.calls).toHaveLength(1);
    expect(harness.pool.getRouteOverride()).toEqual({ kind: 'anonymous', reason: 'outcome-persistence-failed' });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/y', query: 'y' })).resolves.toEqual(success('anonymous'));
    expect(harness.store.preview).toHaveBeenCalledTimes(1);
    expect(harness.calls.map(call => call.key)).toEqual(['1', 'anonymous']);
  });

  it('switches 401/403 and trusted or untrusted 429 across four slots then anonymous', async () => {
    const harness = createHarness({ responses: {
      '1': [{ result: success(), failureEvidence: failureEvidence(401) }],
      '2': [{ result: success(), failureEvidence: failureEvidence(403) }],
      '3': [{ result: success(), failureEvidence: failureEvidence(429, 10) }],
      '4': [{ result: success(), failureEvidence: failureEvidence(429) }],
      anonymous: [success('anon')],
    } });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).resolves.toEqual(success('anon'));
    expect(harness.calls.map(call => call.key)).toEqual(['1', '2', '3', '4', 'anonymous']);
  });

  it.each([400, 404, 422])('settles terminal HTTP %s once and returns a fixed error', async status => {
    const harness = createHarness({ responses: { '1': [{ result: success(`secret ${status}`), failureEvidence: failureEvidence(status) }] } });
    const result = await harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'context7-pool-terminal-non-success' }], isError: true });
    expect(harness.calls).toHaveLength(1);
    expect(harness.outcomes).toEqual([{ token: expect.any(Object), outcome: { kind: 'terminal-non-success', statusCode: status } }]);
  });

  it('settles a typed JSON-RPC invalid-params failure once through input-invalid outcome', async () => {
    const invalidParams = Object.assign(new Error('fixture-secret 401'), { code: -32602 });
    const harness = createHarness({ responses: { '1': [invalidParams] } });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).resolves.toEqual({
      content: [{ type: 'text', text: 'context7-pool-input-invalid' }],
      isError: true,
    });
    expect(harness.calls).toHaveLength(1);
    expect(harness.outcomes[0].outcome).toEqual({ kind: 'input-invalid' });
  });

  it('bounds observer-internal and thrown timeout/exit/broken-pipe/5xx retries at three transients', async () => {
    const variants = [
      { result: { ...success('observer'), isError: true }, failureEvidence: { kind: 'observer-internal', status: null, retryAfterSeconds: null } },
      Object.assign(new Error('timeout secret'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('pipe secret'), { code: 'EPIPE' }),
      Object.assign(new Error('child exit secret'), { name: 'ConnectionClosedError' }),
      { result: success('server'), failureEvidence: failureEvidence(500) },
    ];
    for (const variant of variants) {
      const harness = createHarness({ responses: { '1': [variant, variant], '2': [variant] } });
      await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).resolves.toMatchObject({ isError: true });
      expect(harness.calls).toHaveLength(3);
      expect(harness.calls.map(call => call.key)).toEqual(['1', '1', '2']);
    }
  });

  it('uses distinct reservations and excludes the first fingerprint on the third transient', async () => {
    const transient = { result: { ...success(), isError: true }, failureEvidence: null };
    const harness = createHarness({ responses: { '1': [transient, transient], '2': [transient] } });
    await harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' });
    expect(harness.calls.map(call => call.key)).toEqual(['1', '1', '2']);
    expect(new Set(harness.outcomes.map(entry => JSON.stringify(entry.token))).size).toBe(3);
  });

  it('sanitizes final failures and query digits never change state without trusted evidence', async () => {
    const hugeSecret = `fixture-secret-${'x'.repeat(6000)} 401 429`;
    const harness = createHarness({ responses: { '1': [{ result: { content: [{ type: 'text', text: hugeSecret }], isError: true }, failureEvidence: null }, success('ok')] } });
    const failed = await harness.pool.callTool('query-docs', { libraryId: '/x', query: '401 429 unauthorized' });
    expect(Buffer.byteLength(JSON.stringify(failed), 'utf8')).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(failed)).not.toContain('fixture-secret');
    expect(harness.outcomes[0].outcome).toEqual({ kind: 'transient' });
  });

  it('recursively redacts and caps unexpected store errors before throwing them', async () => {
    const error = Object.assign(new Error(`fixture-secret-${'x'.repeat(6000)}`), {
      context: { CONTEXT7_API_KEY_1: 'fixture-secret-1', query: '401 429' },
    });
    const harness = createHarness({ previewError: error });
    const caught = await harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' }).catch(value => value);
    expect(caught).toMatchObject({ message: 'context7-pool-transient', kind: 'transient' });
    expect(JSON.stringify(caught)).not.toContain('fixture-secret');
    expect(Buffer.byteLength(JSON.stringify(caught), 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('uses one anonymous attempt when all keyed routes are unavailable', async () => {
    const anonymous = { kind: 'anonymous', reason: 'all-keyed-slots-unavailable' };
    const harness = createHarness({ previewRoutes: [anonymous], responses: { anonymous: [{ result: { ...success('failed'), isError: true }, failureEvidence: null }] } });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).resolves.toMatchObject({ isError: true });
    expect(harness.calls.map(call => call.key)).toEqual(['anonymous']);
    expect(harness.outcomes).toEqual([]);
  });

  it('fails schema drift before reservation and clears a failed child generation', async () => {
    const drifted = structuredClone(TOOLS);
    drifted[0].description = 'drifted';
    const first = createHarness({ schemaByFactoryCall: [TOOLS, drifted], previewRoutes: [keyed(1), keyed(2)] });
    await first.pool.listTools();
    await expect(first.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).rejects.toMatchObject({ message: 'context7-pool-schema-drift' });
    expect(first.store.reserveExpected).not.toHaveBeenCalled();

    const second = createHarness({ childFactoryFailureAt: 1 });
    await expect(second.pool.listTools()).rejects.toMatchObject({ message: 'context7-pool-transient' });
    await expect(second.pool.listTools()).resolves.toEqual(TOOLS);
    expect(second.childFactory).toHaveBeenCalledTimes(2);
  });

  it('attributes an in-flight dispatch to the captured child and ignores stale exits', async () => {
    const pending = deferred<any>();
    const harness = createHarness({ responses: { '1': [() => pending.promise] } });
    const call = harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' });
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    const dispatched = harness.calls[0].child;
    dispatched.exit();
    pending.resolve({ result: success('captured'), failureEvidence: null });
    await expect(call).resolves.toEqual(success('captured'));
    expect(harness.outcomes[0].token).toMatchObject({ slot: 1, attemptOrdinal: 1 });
    expect(harness.calls[0]).toMatchObject({ child: dispatched, generation: dispatched.generation });
  });

  it('stops mixed switching at the absolute nine-dispatch ceiling', async () => {
    const auth = { result: success(), failureEvidence: failureEvidence(401) };
    const harness = createHarness({
      responses: { '1': [auth, auth, auth], '2': [auth, auth], '3': [auth, auth], '4': [auth, auth], anonymous: [success()] },
      previewRoutes: Array.from({ length: 20 }, (_, index) => keyed((index % 4) + 1)),
    });
    await expect(harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' })).resolves.toMatchObject({ isError: true });
    expect(harness.calls).toHaveLength(9);
  });

  it('returns fresh exact public counters containing only actual dispatch counts', async () => {
    const harness = createHarness();
    expect(Object.keys(harness.pool)).toEqual(['listTools', 'callTool', 'getPublicRuntime', 'getRouteOverride', 'close']);
    const before = harness.pool.getPublicRuntime();
    expect(Object.keys(before).sort()).toEqual(['anonymousDispatches', 'instanceId_12', 'keyedDispatches', 'startedAt']);
    expect(before).toMatchObject({ keyedDispatches: 0, anonymousDispatches: 0, startedAt: '2026-07-31T00:00:00.000Z' });
    expect(String(before.instanceId_12)).toMatch(/^[0-9a-f]{12}$/);
    await harness.pool.callTool('query-docs', { libraryId: '/secret', query: 'secret query' });
    const after = harness.pool.getPublicRuntime();
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ instanceId_12: before.instanceId_12, keyedDispatches: 1, anonymousDispatches: 0 });
    expect(JSON.stringify(after)).not.toContain('secret');
  });

  it('close bypasses FIFO, aborts an active hang, closes the child and rejects new work', async () => {
    const hanging = ({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const harness = createHarness({ responses: { '1': [hanging] } });
    const active = harness.pool.callTool('query-docs', { libraryId: '/x', query: 'x' });
    await vi.waitFor(() => expect(harness.calls).toHaveLength(1));
    await expect(harness.pool.close()).resolves.toBeUndefined();
    await expect(active).rejects.toMatchObject({ message: 'context7-pool-closed' });
    expect(harness.children[0].closed).toBe(true);
    await expect(harness.pool.callTool('query-docs', { libraryId: '/y', query: 'y' })).rejects.toMatchObject({ message: 'context7-pool-closed' });
  });

  it('closes a child that finishes preparing after shutdown and never reuses it', async () => {
    const gate = deferred<void>();
    const harness = createHarness({ childFactoryGate: gate.promise });
    const listing = harness.pool.listTools();
    await vi.waitFor(() => expect(harness.childFactory).toHaveBeenCalledTimes(1));
    await harness.pool.close();
    gate.resolve();
    await expect(listing).rejects.toMatchObject({ message: 'context7-pool-closed' });
    expect(harness.children).toHaveLength(1);
    expect(harness.children[0].closed).toBe(true);
    await expect(harness.pool.listTools()).rejects.toMatchObject({ message: 'context7-pool-closed' });
    expect(harness.childFactory).toHaveBeenCalledTimes(1);
  });

  it('queued caller cancellation has no effects and shutdown during backoff prevents later dispatch', async () => {
    const first = deferred<any>();
    const harness = createHarness({ responses: { '1': [() => first.promise, { result: { ...success(), isError: true }, failureEvidence: null }] } });
    const active = harness.pool.callTool('query-docs', { libraryId: '/one', query: 'one' });
    const controller = new AbortController();
    const reason = new Error('caller-cancelled');
    const queued = harness.pool.callTool('query-docs', { libraryId: '/two', query: 'two' }, { signal: controller.signal });
    controller.abort(reason);
    first.resolve({ result: success(), failureEvidence: null });
    await active;
    await expect(queued).rejects.toBe(reason);
    expect(harness.calls).toHaveLength(1);

    const backoff = deferred<void>();
    const second = createHarness({
      responses: { '1': [{ result: { ...success(), isError: true }, failureEvidence: null }] },
      sleep: async () => backoff.promise,
    });
    const retrying = second.pool.callTool('query-docs', { libraryId: '/x', query: 'x' });
    await vi.waitFor(() => expect(second.calls).toHaveLength(1));
    await second.pool.close();
    backoff.resolve();
    await expect(retrying).rejects.toMatchObject({ message: 'context7-pool-closed' });
    expect(second.calls).toHaveLength(1);
  });
});
