# Context7 Key Pool MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to execute this plan task by task.
> Every production change follows RED -> GREEN -> REFACTOR, then spec review,
> then code-quality review.

**Goal:** Build a secret-safe local MCP wrapper that exposes the two official
Context7 tools, consumes four dedicated Keys sequentially with a 950-attempt
ceiling per fingerprint and month, persists conservative counters across
process crashes, and falls back to anonymous Context7 without closing Codex's
parent stdio connection.

**Architecture:** Codex connects to one long-lived parent MCP server. The parent
serializes calls, prepares a replaceable locally installed official Context7
child, atomically reserves a keyed attempt in a checksummed two-replica store,
and only then dispatches. State is keyed by credential fingerprint rather than
slot. Key switches replace only the child, never the parent transport.

**Tech Stack:** Node.js 22+, CommonJS runtime modules in the existing ESM
repository, exact `@modelcontextprotocol/sdk@1.25.1`, exact
`@upstash/context7-mcp@2.1.1`, Vitest 4, PowerShell, Codex project MCP TOML.

---

## Non-negotiable execution rules

- Work in `D:\Code\dde` on the existing branch; preserve the concurrent dirty
  worktree. Do not create or switch branches during these tasks.
- Before each task, claim its exact file set with
  `node scripts/agent-file-lease.cjs --owner codex-context7-key-pool claim ...`.
  If any file is owned by another worker, wait; never steal an unexpired lease.
- After the task commit, release the same paths with the same owner.
- Use `git add -- <exact paths>` followed by
  `git commit --only -m "..." -- <exact paths>`. Never commit the pre-existing
  staged set.
- Do not modify `.vscode/mcp.json`.
- Never print, log, snapshot, commit, or request a raw Key in chat. Tests use
  synthetic non-Context7 strings such as `fixture-secret-alpha`.
- Do not edit `.codex/config.toml` until Task 8's hidden four-Key gate and real
  fresh-process smoke both pass.
- The current parent process does not inherit newly written Windows user
  variables. Hidden setup must launch real smoke in its own child environment;
  a full Codex/MCP restart is still required for live-host proof.

## Fixed public and internal contracts

### Official tools

The parent exposes every MCP 1.25.1-standard descriptor field returned by the
pinned child for:

- `resolve-library-id`: required non-empty strings `libraryName` and `query`.
- `query-docs`: required non-empty strings `libraryId` and `query`.

Non-standard fields that the pinned SDK schema deliberately strips are outside
this compatibility claim. It also exposes local `context7-pool-status`, whose input schema is an empty
object with `additionalProperties: false`. The local tool never starts or calls
Context7 and never consumes quota.

Successful official CallTool results preserve every MCP 1.25.1-standard field.
Before any final `isError` result or thrown error reaches Codex, the parent
recursively redacts it; security takes precedence over byte-for-byte error text.

The checked-in local descriptor is defined and exported by
`scripts/context7-key-pool/status.cjs` as `STATUS_TOOL`:

```javascript
const STATUS_TOOL = {
  name: 'context7-pool-status',
  title: 'Context7 Pool Status',
  description: 'Returns redacted local Context7 pool status without consuming quota.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    required: ['schemaVersion', 'mode', 'stateHealth', 'slots'],
    properties: {
      schemaVersion: { const: 1 },
      periodId: { type: 'string' },
      timeZone: { type: 'string' },
      nextResetAt: { type: 'string' },
      mode: { enum: ['keyed', 'anonymous', 'uninitialized', 'stored-unreconciled'] },
      activeSlot: { type: ['integer', 'null'] },
      anonymousReason: { type: ['string', 'null'] },
      stateHealth: { enum: ['uninitialized', 'healthy', 'recovered-replica', 'fail-closed'] },
      slots: { type: 'array' },
      runtime: { type: ['object', 'null'] },
      updatedAt: { type: 'string' },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
```

The pinned child must expose exactly the two official names and must never
collide with `context7-pool-status`.
When a live runtime exists, `runtime` is exactly
`{ instanceId_12, startedAt, keyedDispatches, anonymousDispatches }`; the
instance ID is random/non-secret and counters are process-local. CLI stored
status uses `runtime: null`. These counters attribute live-host smoke even when
another wrapper shares the durable state.

### State payload

Both `state.json` and `state.backup.json` contain the same envelope revision.
`canonicalJson(value)` recursively sorts object keys lexicographically, preserves
array order, rejects non-JSON values, and returns `JSON.stringify()` of that
normalized tree. `checksumSha256` is the lowercase SHA-256 hex digest of
`canonicalJson({ schemaVersion, revision, payload })`; `revision` is a
non-negative safe integer:

```javascript
{
  schemaVersion: 1,
  revision: 42,
  checksumSha256: '<64 lowercase hex of canonical envelope projection>',
  payload: {
    periodId: '2026-07',
    timeZone: 'UTC',
    records: {
      '<full fingerprint>': {
        fingerprintSha256: '<same map key>',
        attemptedCalls: 0,
        successfulCalls: 0,
        status: 'healthy',
        cooldownUntil: null,
        lastErrorClass: null,
        lastErrorAt: null,
        settledAttempts: [
          { periodId: '2026-07', attemptOrdinal: 17 }
        ]
      }
    },
    activeSlots: [
      { slot: 1, fingerprintSha256: '<fingerprint>' },
      { slot: 2, fingerprintSha256: '<fingerprint>' },
      { slot: 3, fingerprintSha256: '<fingerprint>' },
      { slot: 4, fingerprintSha256: '<fingerprint>' }
    ],
    anonymousMode: { active: false, reason: null, since: null },
    updatedAt: '2026-07-15T00:00:00.000Z'
  }
}
```

`records` retains inactive fingerprints, so removing and restoring a Key in the
same month cannot reset its count. Newer months reset counts and
quota-exhausted/soft-exhausted state, retain a future cooldown until it expires,
and retain `auth-invalid` for the same fingerprint. System-clock rollback never
decrements `periodId`.

Allowed record statuses are `healthy`, `soft-exhausted`, `quota-exhausted`,
`auth-invalid`, and `cooldown`. Storage health exposed to the status projector is
one of `uninitialized`, `healthy`, `recovered-replica`, or `fail-closed`; it is
diagnostic metadata and is not embedded in the state payload.

### Reservation token

Every keyed dispatch receives this immutable token from the locked store:

```javascript
{
  kind: 'keyed',
  periodId: '2026-07',
  slot: 1,
  fingerprintSha256: '<64 lowercase hex>',
  attemptOrdinal: 17,
  stateRevision: 42
}
```

Policy produces the token fields through `attemptOrdinal`; the state store adds
`stateRevision` only after it has assigned and durably written the next mirrored
envelope revision. Outcome recording uses the resulting token, never only the
mutable slot number.
`stateRevision` is diagnostic evidence only; outcomes never require it to equal
the current revision because other processes may reserve between dispatch and
response.
Store context is always
`{ identities: [{ slot, fingerprintSha256 } x4], timeZone }`. Outcomes are
exactly `{ kind: 'success' }`, `{ kind: 'auth-invalid' }`,
`{ kind: 'quota-exhausted' }`,
`{ kind: 'rate-limit', retryAfterMs }`, `{ kind: 'transient' }`, or
`{ kind: 'terminal-non-success', statusCode }`, or `{ kind: 'input-invalid' }`.
`terminal-non-success.statusCode` is an integer in 300..499 excluding
401, 403, and 429; policy rejects every other shape and records only the fixed
class `upstream-http-terminal-<statusCode>`.
Outcome idempotency keys are the pair `{ periodId, attemptOrdinal }`, never the
ordinal alone. Reconciliation retains settlement pairs for the retained period
and its immediately preceding calendar period in the stored timezone; the
70-second operation ceiling makes older in-flight outcomes impossible. For a
token from the immediately preceding period, success, transient, input-invalid,
terminal-non-success and
quota-exhausted do not change current-period counters/status; auth-invalid still
invalidates the same fingerprint, and rate-limit may only extend that
fingerprint to a trusted future cooldown. The settlement pair is recorded once.
Tokens older than the immediately preceding period are ignored without mutating
state.

### Retry limits

- Local validation failures: zero reservations and zero upstream dispatches.
- `401/403`: mark that fingerprint `auth-invalid`, then select the next route.
- `429` with trusted Retry-After: persist cooldown and select the next route.
- `429` without Retry-After: persist `quota-exhausted` and select the next route.
- Other normalized non-2xx HTTP statuses are terminal non-success: settle that
  reservation once, do not increment `successfulCalls`, do not switch Keys, and
  return a fixed redacted MCP error.
- Timeout/transport/child-exit/explicit `5xx`: at most three transient upstream
  dispatches total; the first retry stays on the same fingerprint, the third
  transient dispatch excludes that fingerprint and uses the next healthy route.
- Anonymous failure: return once; never retry anonymously.
- Mixed failures have an absolute ceiling of nine upstream dispatches
  (`4 slots * 2 + 1 anonymous`) and three transient dispatches.
- Each keyed dispatch has its own durable reservation. Spawn, initialize,
  `tools/list`, schema validation, and local validation failures do not count.

Trusted Retry-After means an explicit integer seconds value from normalized
upstream status evidence whose converted duration is between 1 second and 24
hours. Missing, malformed, zero, negative, or larger values use
`quota-exhausted`; raw headers or child stderr are never trusted implicitly.
Each attempt is capped at 20 seconds and the full runtime call at 70 seconds;
Codex's tool timeout is 90 seconds so the parent has shutdown/error margin.

## File map

| File | Responsibility |
| --- | --- |
| `scripts/context7-key-pool/credentials.cjs` | Load exactly four ordered Keys and derive identities |
| `scripts/context7-key-pool/redaction.cjs` | Recursive string, Error, environment and circular-safe redaction |
| `scripts/context7-key-pool/policy.cjs` | State validation, period reconciliation, selection and token-based outcomes |
| `scripts/context7-key-pool/state-store.cjs` | PID/token lock, checksummed mirrored revisions, transactions and events |
| `scripts/context7-key-pool/context7-child.cjs` | Pinned local official child lifecycle and raw MCP forwarding |
| `scripts/context7-key-pool/context7-fetch-observer.cjs` | Non-secret per-child nonce bridge for trustworthy upstream failure status |
| `scripts/context7-key-pool/runtime.cjs` | FIFO, prepare-before-reserve, retries, child switching and shutdown |
| `scripts/context7-key-pool/status.cjs` | Pure public status projection with short fingerprints only |
| `scripts/context7-key-pool-mcp.cjs` | Parent stdio entry and `--status` CLI mode |
| `scripts/configure-context7-key-pool.ps1` | Atomic hidden-input Windows user setup and optional real smoke |
| `scripts/smoke-context7-key-pool.cjs` | Fake default and authenticated fresh-process smoke |
| `src/tests/scripts/context7-key-pool/*.spec.ts` | Focused unit, integration and stress suites |
| `src/tests/fixtures/context7-key-pool/*.cjs` | Fake MCP child and reservation workers |
| `src/tests/contracts/tooling-security.contract.spec.ts` | Dependency, config and secret-safety contract |
| `docs/context7-key-pool-operations.md` | Detailed Chinese operations and rollback guide |

## Task 1: Credential boundary and recursive redaction

**Files:**

- Create `scripts/context7-key-pool/credentials.cjs`
- Create `scripts/context7-key-pool/redaction.cjs`
- Create `src/tests/scripts/context7-key-pool/credentials.spec.ts`

### Steps

1. Claim the three exact paths:

```powershell
node scripts/agent-file-lease.cjs --owner codex-context7-key-pool claim scripts/context7-key-pool/credentials.cjs scripts/context7-key-pool/redaction.cjs src/tests/scripts/context7-key-pool/credentials.spec.ts
```
2. Write RED tests named:
   - `loads four ordered slots and exposes only public identities`
   - `rejects every missing slot and duplicate fingerprint`
   - `rejects empty or surrounding-whitespace values without normalizing them`
   - `redacts nested strings, Error fields, circular values and every CONTEXT7_API_KEY prefix field`
   - `does not mutate the original diagnostic object`

   Create the test file with this complete content:

```typescript
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = process.cwd();
const credentialsPath = path.join(projectRoot, 'scripts', 'context7-key-pool', 'credentials.cjs');
const redactionPath = path.join(projectRoot, 'scripts', 'context7-key-pool', 'redaction.cjs');

const { KEY_NAMES, fingerprint, loadCredentialPool } = require(credentialsPath) as {
  KEY_NAMES: readonly string[];
  fingerprint(value: string): string;
  loadCredentialPool(env: Record<string, string | undefined>): Array<{
    slot: number;
    name: string;
    value: string;
    fingerprintSha256: string;
    publicIdentity: { slot: number; fingerprintSha256_12: string; length: number };
  }>;
};
const { createRedactor } = require(redactionPath) as {
  createRedactor(values: string[]): (input: unknown) => unknown;
};

function fixtureEnv(): Record<string, string | undefined> {
  return {
    CONTEXT7_API_KEY_1: 'fixture-secret-alpha',
    CONTEXT7_API_KEY_2: 'fixture-secret-bravo',
    CONTEXT7_API_KEY_3: 'fixture-secret-charlie',
    CONTEXT7_API_KEY_4: 'fixture-secret-delta',
  };
}

describe('Context7 credential boundary', () => {
  it('loads four ordered slots and exposes only public identities', () => {
    const env = fixtureEnv();
    const pool = loadCredentialPool(env);

    expect(KEY_NAMES).toEqual([
      'CONTEXT7_API_KEY_1',
      'CONTEXT7_API_KEY_2',
      'CONTEXT7_API_KEY_3',
      'CONTEXT7_API_KEY_4',
    ]);
    expect(pool.map(entry => entry.slot)).toEqual([1, 2, 3, 4]);
    expect(pool.map(entry => entry.name)).toEqual(KEY_NAMES);
    expect(pool.map(entry => entry.value)).toEqual(KEY_NAMES.map(name => env[name]));
    for (const entry of pool) {
      expect(entry.fingerprintSha256).toBe(fingerprint(entry.value));
      expect(entry.publicIdentity).toEqual({
        slot: entry.slot,
        fingerprintSha256_12: entry.fingerprintSha256.slice(0, 12),
        length: entry.value.length,
      });
      expect(Object.keys(entry.publicIdentity).sort()).toEqual([
        'fingerprintSha256_12',
        'length',
        'slot',
      ]);
      expect(JSON.stringify(entry.publicIdentity)).not.toContain(entry.value);
    }
  });

  it('rejects every missing slot and duplicate fingerprint', () => {
    for (let slot = 1; slot <= 4; slot += 1) {
      const env = fixtureEnv();
      delete env[`CONTEXT7_API_KEY_${slot}`];
      expect(() => loadCredentialPool(env)).toThrow(`missing-context7-key-slot:${slot}`);
    }

    const duplicate = fixtureEnv();
    duplicate.CONTEXT7_API_KEY_4 = duplicate.CONTEXT7_API_KEY_2;
    expect(() => loadCredentialPool(duplicate)).toThrow('duplicate-context7-key-slots:2,4');
  });

  it('rejects empty or surrounding-whitespace values without normalizing them', () => {
    const empty = fixtureEnv();
    empty.CONTEXT7_API_KEY_3 = '';
    expect(() => loadCredentialPool(empty)).toThrow('missing-context7-key-slot:3');

    for (const invalid of [' ', ' fixture-secret-alpha', 'fixture-secret-alpha ']) {
      const env = fixtureEnv();
      env.CONTEXT7_API_KEY_1 = invalid;
      expect(() => loadCredentialPool(env)).toThrow('invalid-context7-key-whitespace-slot:1');
    }
  });

  it('redacts nested strings, Error fields, circular values and every CONTEXT7_API_KEY prefix field', () => {
    const first = 'fixture-secret-alpha';
    const second = 'fixture-secret-bravo';
    const error = new Error(`request failed for ${second}`, {
      cause: { detail: `cause=${first}` },
    });
    const input: Record<string, unknown> = {
      message: `selected=${first}`,
      nested: [{ value: `token:${second}` }],
      CONTEXT7_API_KEY_1: 'field-value-is-always-redacted',
      context7_api_key_backup: 'case-insensitive-field-redaction',
      error,
    };
    input.self = input;

    const output = createRedactor([first, second])(input) as Record<string, unknown>;
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain(first);
    expect(serialized).not.toContain(second);
    expect(output.CONTEXT7_API_KEY_1).toBe('[REDACTED_SECRET]');
    expect(output.context7_api_key_backup).toBe('[REDACTED_SECRET]');
    expect(output.self).toBe('[Circular]');
    expect(output.error).toEqual(expect.objectContaining({
      name: 'Error',
      message: 'request failed for [REDACTED_SECRET]',
      cause: { detail: 'cause=[REDACTED_SECRET]' },
    }));
  });

  it('does not mutate the original diagnostic object', () => {
    const secret = 'fixture-secret-alpha';
    const nested = { value: `token:${secret}` };
    const error = new Error(`failed:${secret}`);
    const input = { nested, error };

    const output = createRedactor([secret])(input) as typeof input;

    expect(output).not.toBe(input);
    expect(output.nested).not.toBe(nested);
    expect(input.nested).toBe(nested);
    expect(input.nested.value).toBe(`token:${secret}`);
    expect(input.error).toBe(error);
    expect(input.error.message).toBe(`failed:${secret}`);
  });
});
```
3. The desired exported API is exact:

```javascript
'use strict';

const crypto = require('node:crypto');

const KEY_NAMES = Object.freeze([
  'CONTEXT7_API_KEY_1',
  'CONTEXT7_API_KEY_2',
  'CONTEXT7_API_KEY_3',
  'CONTEXT7_API_KEY_4',
]);

function fingerprint(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function loadCredentialPool(env = process.env) {
  const pool = KEY_NAMES.map((name, index) => {
    const slot = index + 1;
    const value = typeof env[name] === 'string' ? env[name] : '';
    if (!value) throw new Error(`missing-context7-key-slot:${slot}`);
    if (!value.trim() || value !== value.trim()) {
      throw new Error(`invalid-context7-key-whitespace-slot:${slot}`);
    }
    const fingerprintSha256 = fingerprint(value);
    return {
      slot,
      name,
      value,
      fingerprintSha256,
      publicIdentity: {
        slot,
        fingerprintSha256_12: fingerprintSha256.slice(0, 12),
        length: value.length,
      },
    };
  });
  const firstSlotByFingerprint = new Map();
  for (const entry of pool) {
    const firstSlot = firstSlotByFingerprint.get(entry.fingerprintSha256);
    if (firstSlot !== undefined) {
      throw new Error(`duplicate-context7-key-slots:${firstSlot},${entry.slot}`);
    }
    firstSlotByFingerprint.set(entry.fingerprintSha256, entry.slot);
  }
  return pool;
}

module.exports = { KEY_NAMES, fingerprint, loadCredentialPool };
```

`redaction.cjs` implements this exact copy-on-redact behavior:

```javascript
'use strict';

const SECRET_FIELD = /^CONTEXT7_API_KEY(?:_.*)?$/i;

function createRedactor(secretValues) {
  const secrets = [...new Set(secretValues.filter(value => typeof value === 'string' && value))]
    .sort((left, right) => right.length - left.length);
  const cleanString = value => secrets.reduce(
    (current, secret) => current.split(secret).join('[REDACTED_SECRET]'),
    value,
  );
  return input => {
    const seen = new WeakMap();
    const visit = (value, key = '') => {
      if (SECRET_FIELD.test(key)) return '[REDACTED_SECRET]';
      if (typeof value === 'string') return cleanString(value);
      if (!value || typeof value !== 'object') return value;
      if (seen.has(value)) return '[Circular]';
      if (Array.isArray(value)) {
        const copy = [];
        seen.set(value, copy);
        for (const child of value) copy.push(visit(child));
        return copy;
      }
      const copy = {};
      seen.set(value, copy);
      if (value instanceof Error) {
        copy.name = visit(value.name, 'name');
        copy.message = visit(value.message, 'message');
        if (value.stack) copy.stack = visit(value.stack, 'stack');
        if ('cause' in value) copy.cause = visit(value.cause, 'cause');
      }
      for (const [childKey, child] of Object.entries(value)) {
        if (!Object.hasOwn(copy, childKey)) copy[childKey] = visit(child, childKey);
      }
      return copy;
    };
    return visit(input);
  };
}

module.exports = { createRedactor };
```

4. Run RED before creating either production module:

```powershell
npx vitest run --config vitest.config.mts src/tests/scripts/context7-key-pool/credentials.spec.ts
```

   Expected: module-not-found for `credentials.cjs`.
5. Implement the minimum code, rerun the same command to GREEN, then run:

```powershell
git diff --check -- scripts/context7-key-pool/credentials.cjs scripts/context7-key-pool/redaction.cjs src/tests/scripts/context7-key-pool/credentials.spec.ts
```

6. Commit only the three paths, then release their leases:

```powershell
git add -- scripts/context7-key-pool/credentials.cjs scripts/context7-key-pool/redaction.cjs src/tests/scripts/context7-key-pool/credentials.spec.ts
git diff --cached --check -- scripts/context7-key-pool/credentials.cjs scripts/context7-key-pool/redaction.cjs src/tests/scripts/context7-key-pool/credentials.spec.ts
git commit --only -m "feat(context7): add key-pool credential boundary" -- scripts/context7-key-pool/credentials.cjs scripts/context7-key-pool/redaction.cjs src/tests/scripts/context7-key-pool/credentials.spec.ts
node scripts/agent-file-lease.cjs --owner codex-context7-key-pool release scripts/context7-key-pool/credentials.cjs scripts/context7-key-pool/redaction.cjs src/tests/scripts/context7-key-pool/credentials.spec.ts
```

## Task 2: Fingerprint ledger, routing policy and public status projection

**Files:**

- Create `scripts/context7-key-pool/policy.cjs`
- Create `scripts/context7-key-pool/status.cjs`
- Create `src/tests/scripts/context7-key-pool/policy.spec.ts`
- Create `src/tests/scripts/context7-key-pool/status.spec.ts`

### Steps

1. Claim all four paths.
2. Write RED coverage for these exact cases:
   - reservations 1..950 use slot 1; stale reservation 951 throws; next route is slot 2;
   - `excludeFingerprints` temporarily selects the next healthy route without changing health;
   - cooldown skips and later returns to the lowest slot;
   - auth-invalid, quota-exhausted and all-unavailable anonymous fallback;
   - selecting anonymous persists its reason/since, while the next keyed
     reservation clears anonymous mode; anonymous dispatch has no outcome token;
   - fingerprint swap and remove/re-add preserve same-month counts;
   - new fingerprint starts at zero;
   - newer month resets counts and quota exhaustion, retains same-fingerprint
     auth-invalid, and retains a future cooldown until it expires;
   - clock rollback and a timezone change whose computed period is older do not
     roll back the period; an equal-period timezone change updates the stored zone;
   - malformed counts, duplicate slots/fingerprints, invalid dates/status/timezone fail validation;
   - duplicate outcome delivery is a no-op via the
     `{ periodId, attemptOrdinal }` settlement pair, while a new period may
     reuse the same ordinal without collision;
   - terminal non-success settles once without incrementing successful calls or
     changing a healthy credential's routing status;
   - input-invalid outcome settles once without incrementing success, retrying,
     or changing credential routing status;
   - late success cannot clear auth-invalid, soft-exhausted or quota-exhausted;
     auth-invalid has highest precedence and cooldown keeps the maximum expiry;
   - status output includes only 12-character fingerprints and no state path, query, stderr or full hash;
   - `nextPeriodStartAt(retainedPeriodId, timeZone)` is correct for UTC,
     `America/New_York`, and
     `Asia/Shanghai`.
3. Export exactly:

```javascript
// policy.cjs
module.exports = {
  SOFT_LIMIT: 950,
  periodIdAt,
  nextPeriodStartAt,    // (retainedPeriodId, timeZone) -> Date
  validateStatePayload,
  reconcileState,
  selectRoute,          // (state, now, { excludeFingerprints = [] })
  reserveRoute,         // eligibility rechecked; returns { state, reservation }
  applyOutcome,         // idempotent (state, token, outcome, now)
  markAnonymous,        // persist { active, reason, since }
  clearAnonymous,       // called by every keyed reservation
  createFailClosedState,
};

// status.cjs
const { nextPeriodStartAt, selectRoute } = require('./policy.cjs');

function projectPublicStatus({
  state,
  health,
  activeRoute,
  now,
  reconciliation = 'applied',
  runtime = null,
}) {
  if (!state) {
    const failClosed = health.status === 'fail-closed';
    return {
      schemaVersion: 1,
      mode: failClosed ? 'anonymous' : 'uninitialized',
      activeSlot: null,
      anonymousReason: failClosed ? 'state-unavailable-fail-closed' : null,
      stateHealth: health.status,
      slots: [],
      runtime,
    };
  }
  const route = reconciliation === 'applied'
    ? (activeRoute ?? selectRoute(state, now))
    : { kind: 'stored-unreconciled', reason: 'credentials-not-applied' };
  return {
    schemaVersion: 1,
    periodId: state.periodId,
    timeZone: state.timeZone,
    nextResetAt: nextPeriodStartAt(state.periodId, state.timeZone).toISOString(),
    mode: route.kind,
    activeSlot: route.kind === 'keyed' ? route.slot : null,
    anonymousReason: route.kind === 'anonymous' ? route.reason : null,
    stateHealth: health.status,
    slots: [...state.activeSlots]
      .sort((left, right) => left.slot - right.slot)
      .map(identity => {
        const record = state.records[identity.fingerprintSha256];
        return {
          slot: identity.slot,
          fingerprintSha256_12: identity.fingerprintSha256.slice(0, 12),
          attemptedCalls: record.attemptedCalls,
          successfulCalls: record.successfulCalls,
          status: record.status,
          cooldownUntil: record.cooldownUntil,
          lastErrorClass: record.lastErrorClass,
        };
      }),
    runtime,
    updatedAt: state.updatedAt,
  };
}

module.exports = { STATUS_TOOL, projectPublicStatus };
```

4. `applyOutcome` semantics are exact: same-period success increments only the
   token fingerprint once; terminal non-success only settles and records a
   normalized last error class. For the immediately preceding period, success,
   transient, input-invalid, terminal non-success and quota exhaustion are ignored, auth-invalid follows the same
   fingerprint, and only a trusted future cooldown may extend it. Outcomes older
   than that window are ignored without adding a settlement. Slot reorder cannot
   redirect an outcome. Auth-invalid is never cleared by a late result,
   soft/quota exhaustion is never cleared by success, and cooldown uses the
   later of the existing/new expiry.
5. Run each new spec once RED, implement minimum policy/status code, rerun both
   GREEN, and run `git diff --check` on all four paths.
6. Commit only the four paths with `feat(context7): add sequential pool policy`,
   then release their leases.

## Task 3: Crash-safe cross-process state store

**Files:**

- Create `scripts/context7-key-pool/state-store.cjs`
- Create `src/tests/fixtures/context7-key-pool/state-reserve-worker.cjs`
- Create `src/tests/scripts/context7-key-pool/state-store.spec.ts`

### Exact store API

```javascript
const store = createStateStore({
  stateDir,
  now: () => new Date(),
  sleep,
  lockWaitMs: 5000,
  staleLockMs: 10000,
  processExists,
  maxEventBytes: 1024 * 1024,
  redact,
});

// createStateStore returns only the public methods below. Its transaction
// primitive and reducers are private closures and are never exposed to callers.
// Before persistence, the private transition validator rejects same-period
// count decreases, record deletion, settlement deletion, and auth-invalid
// clearing. Only reconcileState may perform a controlled period advance/reset.
// Canonically identical payloads do not bump revision; replica repair copies
// the selected envelope without creating a new revision.

await store.preview(context, { excludeFingerprints: [] });
// -> { route, state, health, stateRevision }; never increments.

await store.reserveExpected(context, expectedRoute, { excludeFingerprints: [] });
// -> { kind: 'retry', route, state, health, stateRevision }
// or { kind: 'keyed', route, token, state, health, stateRevision }
// or { kind: 'anonymous', route, token: null, state, health, stateRevision }
// Route equality compares kind and, for keyed routes, slot + full fingerprint.
// Anonymous selection persists markAnonymous when storage is writable and
// never calls recordOutcome.

await store.recordOutcome(context, token, outcome);
// -> { state, health, stateRevision }
await store.read(context); // -> { state, health, stateRevision }
await store.inspectStored();
// -> { state: null, health: { status: 'uninitialized' }, stateRevision: null,
//      reconciliation: 'not-applied' }
// or { state: null, health: { status: 'fail-closed', reason },
//      stateRevision: null, reconciliation: 'not-applied' }
// or { state, health, stateRevision, reconciliation: 'not-applied' };
// no credentials, no reconciliation, no repair/archive/write, unchanged mtimes
await store.appendEvent(allowlistedEvent);
```

### Steps

1. Claim the three paths.
2. Write RED tests named exactly:
   - `persists both replicas before returning a reservation`
   - `selects the highest valid revision and repairs the other replica`
   - `rejects revision-only tampering and accepts reordered record keys with the same canonical checksum`
   - `fails closed on equal revisions with different checksums`
   - `archives dual corruption and persists a fail-closed mirrored revision`
   - `treats non-ENOENT read errors as storage failure, not first run`
   - `returns only a synthetic fail-closed anonymous route when storage is unavailable`
   - `never steals an old lock owned by a live pid`
   - `quarantines a proven-dead stale lock and token-checks release`
   - `fails closed on malformed published lock ownership instead of stealing it`
   - `rejects keyed dispatch when either mirrored replace cannot complete`
   - `serializes 40 reservation worker processes with an exact total of 40`
   - `allows exactly one ordinal 950 when workers race from 949`
   - `never persists transaction result or reservation token in the payload`
   - `rejects same-period count, record, settlement and auth-invalid rollback`
   - `does not increment revision for a no-op, duplicate outcome or replica-only repair`
   - `rotates events.jsonl and redacts secrets without recording query text`
   - `inspectStored is non-mutating and reports reconciliation not applied`
   The worker constructs `createStateStore({ stateDir, now, lockWaitMs: 30000 })`
   from its state-directory and ISO-time argv values, writes no stdout, and
   exits nonzero with only a normalized error class.
3. Implement replica writes in this exact order:
   - reconcile and validate once under the lock; sample `txNow` once;
   - only when canonical payload changes, increment revision and compute its
     envelope-projection checksum; a no-op or replica-only repair keeps the
     selected revision unchanged;
   - write and `FileHandle.sync()` independent same-directory temp files for
     the same new envelope;
   - replace backup first, then primary, retrying only `EPERM`, `EACCES`,
     `EBUSY`, and `ENOTEMPTY` a maximum of five times;
   - on Windows, replacement removes only that single destination immediately
     before renaming its prepared temp; the other validated equal-or-newer
     replica makes this bounded gap recoverable;
   - return only after both replacements succeed; clean unused temps;
   - recovery validates both envelopes and chooses the greater revision;
     equal revision plus different checksum is corruption;
   - a crash after backup replacement may conservatively overcount an unsent
     attempt, but recovery can never choose an older valid count.
4. Lock owner is `{ ownerId: randomUUID(), pid, claimedAt }`. Write it inside a
   unique candidate directory and publish the complete candidate by atomic
   rename to `state.lock`. A lock is
   stealable only when valid owner metadata names a PID proven dead by `ESRCH`.
   `EPERM` and every unknown liveness error mean alive. A published lock with
   missing/malformed ownership fails closed for manual recovery; it is never
   stolen automatically. Quarantine by atomic rename before deletion; release must reread and
   match `ownerId` before rename/delete. Abandoned candidate directories are
   removed only after `staleLockMs`.
5. This JSON protocol is process-crash safe and calls `FileHandle.sync()` for
   best-effort power-loss durability. Node has no portable Windows parent-
   directory fsync guarantee; do not claim sudden-power-loss atomicity.
6. A non-ENOENT read/write/lock failure never yields a keyed route. `preview`
   returns an in-memory fail-closed state for the four identities and anonymous
   reason `state-unavailable-fail-closed`; `reserveExpected` can return only its
   anonymous variant. This degraded state is never presented as persisted.
7. Run the spec RED before production creation, then GREEN. Run it three times
   to expose lock flakes:

```powershell
1..3 | ForEach-Object {
  npx vitest run --config vitest.config.mts src/tests/scripts/context7-key-pool/state-store.spec.ts
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

8. Commit only the three paths with
   `feat(context7): persist pool reservations safely`, then release leases.

## Task 4: Exact dependencies and official Context7 child adapter

**Files:**

- Modify `package.json`
- Modify `package-lock.json`
- Create `scripts/context7-key-pool/context7-child.cjs`
- Create `scripts/context7-key-pool/context7-fetch-observer.cjs`
- Create `src/tests/fixtures/context7-key-pool/fake-context7-mcp.cjs`
- Create `src/tests/fixtures/context7-key-pool/fake-context7-upstream-fetch.cjs`
- Create `src/tests/scripts/context7-key-pool/child.spec.ts`

### Steps

1. Wait until both package files are lease-free and both the worktree and index
   are clean for those exact paths. If either has an existing diff, wait for its
   owner to commit/release it; never fold that diff into this task. Then claim all
   seven paths and repeat the same four clean checks before writing:

```powershell
git diff --quiet -- package.json package-lock.json
if ($LASTEXITCODE -ne 0) { throw 'package-worktree-not-clean' }
git diff --cached --quiet -- package.json package-lock.json
if ($LASTEXITCODE -ne 0) { throw 'package-index-not-clean' }
node scripts/agent-file-lease.cjs --owner codex-context7-key-pool claim package.json package-lock.json scripts/context7-key-pool/context7-child.cjs scripts/context7-key-pool/context7-fetch-observer.cjs src/tests/fixtures/context7-key-pool/fake-context7-mcp.cjs src/tests/fixtures/context7-key-pool/fake-context7-upstream-fetch.cjs src/tests/scripts/context7-key-pool/child.spec.ts
git diff --quiet -- package.json package-lock.json
if ($LASTEXITCODE -ne 0) { throw 'package-worktree-drift-after-claim' }
git diff --cached --quiet -- package.json package-lock.json
if ($LASTEXITCODE -ne 0) { throw 'package-index-drift-after-claim' }
```
2. Install exact local packages:

```powershell
npm install --save-exact --ignore-scripts @modelcontextprotocol/sdk@1.25.1 @upstash/context7-mcp@2.1.1
npm ls @modelcontextprotocol/sdk @upstash/context7-mcp --depth=0
```

   Add `"overrides": { "@modelcontextprotocol/sdk": "1.25.1" }`, regenerate
   the lockfile, and require `npm ls @modelcontextprotocol/sdk --all` to show no
   other SDK version. No `latest` or registry launch remains in runtime code.
3. Create a fake SDK `Server`/`StdioServerTransport` child that supports
   initialize, `tools/list`, and `tools/call`. It returns only a derived
   12-character fingerprint and environment variable names, never the selected
   secret. Behavior is selected by non-secret test env flags for success,
   `isError`, delay, schema drift, and immediate exit.
   Check in this expected contract beside the factory and validate the first
   child as well as every replacement:

```javascript
const EXPECTED_CONTEXT7_TOOL_CONTRACT = Object.freeze({
  'resolve-library-id': Object.freeze({
    required: Object.freeze(['libraryName', 'query']),
    stringProperties: Object.freeze(['libraryName', 'query']),
  }),
  'query-docs': Object.freeze({
    required: Object.freeze(['libraryId', 'query']),
    stringProperties: Object.freeze(['libraryId', 'query']),
  }),
});
```

   `validateOfficialToolSet()` rejects missing/extra names, the status-tool name,
   non-object input schemas, non-string required properties, or changed required
   sets. Runtime additionally compares the complete canonical MCP-standard
   descriptor signature of every replacement to the validated first child.
4. Write RED child tests for:
   - keyed child receives allowlisted OS/proxy variables plus exactly one
     `CONTEXT7_API_KEY`, and none of `_1.._4` or unrelated secret variables;
   - lowercase/mixed-case `context7_api_key*` sentinels are absent on Windows;
   - anonymous child receives no variable beginning `CONTEXT7_API_KEY`;
   - the local package entry and version resolve to `2.1.1`;
   - the fetch observer replaces every non-2xx response on the two exact API
     endpoints, transport failure, and recoverable observer-internal failure
     with the exact per-child nonce envelope, validates integer Retry-After in
     1..86400, and never copies response body, request URL/query, raw headers or
     inherited marker values;
   - invalid preload configuration fails before MCP initialize; injected
     body-cancel/header/normalization faults produce `observer-internal` evidence,
     while an impossible fallback-envelope construction terminates only the
     child so the parent sees a transient child exit rather than false success;
   - a synthetic 304 (representative of a non-2xx status that cannot legally
     carry a WHATWG Response body) uses carrier status 599 but retains
     `status=304` in the nonce envelope, so runtime classifies it as terminal 304
     rather than observer-internal/transient;
   - normal content containing `401`, `403`, `429` or the public envelope prefix
     without the current child nonce produces no trusted failure evidence;
   - marker-like upstream JSON, a user query containing a fake/current-looking
     marker, a stale child generation, extra prefix/suffix, multiple content
     blocks and a nonce mismatch are all untrusted and cannot switch Keys;
   - a no-network integration launches the actual pinned 2.1.1 entry with the
     test fetch stub preloaded before the production observer, performs real MCP
     `tools/call` for both official tools, and proves synthetic 401 and 429 with
     Retry-After survive official formatting as exact extractable envelopes;
   - the first child is rejected for missing/extra/colliding tools or changed
     required string fields;
   - tools/list and all schema-valid MCP 1.25.1-standard CallTool result fields
     pass through unchanged at this internal child boundary, including
     `isError`, `_meta`, `structuredContent` and standard content kinds; the
     sole security exception is recursive removal of that child's capability
     marker after evidence extraction. The child result is never returned
     directly to Codex, and Task 5 owns final error sanitization;
   - connect/list/call timeouts close the child;
   - unexpected exit rejects safely and never exits the parent test process;
   - child stderr is set to `ignore`, so it cannot leak, block on pipe
     backpressure, or enter parent diagnostics.
   - the actual local 2.1.1 entry starts anonymously with `--transport stdio`
     and completes initialize + tools/list without any real network tool call.
5. Implement this exact factory:

```javascript
await createContext7Child({
  apiKey,                         // undefined means anonymous
  inheritedEnv: process.env,
  command: process.execPath,
  entryPath: resolvePinnedContext7Entry(),
  observerPath: path.join(__dirname, 'context7-fetch-observer.cjs'),
  args: ['--transport', 'stdio'],
  cwd: repoRoot,
  connectTimeoutMs: 10000,
  callTimeoutMs: 20000,
  redact,
});

// -> { tools,
//      callTool(name, args, { signal }) -> { result, failureEvidence },
//      close(), onExit(listener) }
```

   `repoRoot` is `path.resolve(__dirname, '../..')`.
   Because the published 2.1.1 package has `bin` but no `main`/`exports`,
   `resolvePinnedContext7Entry()` first resolves
   `@upstash/context7-mcp/package.json`, parses it, requires exact name
   `@upstash/context7-mcp`, version `2.1.1`, and
   `bin.context7-mcp === 'dist/index.js'`, then resolves that path and verifies
   its real path remains inside the package root and is a regular file. It never
   falls back to `npx`, a registry URL, or PATH lookup. Export it together with
   `validateOfficialToolSet` and `extractTrustedFailureEvidence` for focused
   tests.
   The factory creates a fresh 64-lowercase-hex (256-bit) failure marker per child, passes
   Node `--require <observerPath>` before the official ESM entry, and injects the
   marker only as `NANOFLOW_CONTEXT7_FAILURE_MARKER`. The observer wraps global
   `fetch` before the pinned entry loads. Startup validates the marker grammar,
   exact endpoints, captured native `fetch`/`Response`, and wrapper installation;
   any failure throws before the official MCP server initializes. It has no dependencies, logging or
   environment enumeration and acts only on exact requests to
   `https://context7.com/api/v2/libs/search` and
   `https://context7.com/api/v2/context`; the marker is never added to the
   upstream request. For every non-2xx response on those endpoints it best-effort
   cancels the original body and replaces it with a same-status JSON message
   `nanoflow-context7-failure-v1:<marker>:kind=http;status=<status>;retry-after=<none|seconds>`;
   If the observed non-2xx status cannot legally carry a WHATWG Response body,
   the synthetic Response uses carrier status 599 while the authenticated
   envelope retains the original `kind=http;status=<status>`; 304 is the required
   RED case. The parent always classifies the envelope status, not the carrier
   status. Normal 204/205 are 2xx and pass through untouched.
   for a fetch transport throw on those endpoints it returns status 599 with the
   same envelope using `kind=transport;status=none;retry-after=none`. A runtime
   fault in cancel/header/normalization uses status 599 and
   `kind=observer-internal;status=none;retry-after=none`; if even fixed fallback
   Response construction fails, the preload terminates the child with a fixed
   nonzero code and no logging. All 2xx and all other origins/paths pass through
   untouched. `extractTrustedFailureEvidence()` accepts only
   `content.length === 1`, a text block, whole-string equality to the current
   child closure's private marker grammar;
   it intentionally does not require `isError === true`, because pinned 2.1.1
   converts API failures to ordinary text results. It returns only
   `{ kind, status, retryAfterSeconds }`, where kind is exactly `http`,
   `transport`, or `observer-internal`. Before any result or diagnostic leaves
   the child adapter, every occurrence of that child's marker is unconditionally
   replaced with `[REDACTED_MARKER]`, including partial/mismatched envelopes that
   produce no failure evidence. The marker is random/non-secret but is never
   logged, persisted, returned by the parent or reused by a replacement child.

   The effective child env is exactly the key union of SDK 1.25.1
   `getDefaultEnvironment()` and an explicit safe selection from `inheritedEnv`,
   plus only the selected canonical `CONTEXT7_API_KEY`. The checked-in test
   snapshots the exact sorted SDK-default key list from installed 1.25.1 so a
   dependency drift fails closed. Explicit safe names are exactly `PATH`,
   `PATHEXT`, `SYSTEMROOT`, `COMSPEC`, `TEMP`, `TMP`, `TMPDIR`, `HOME`,
   `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HTTP_PROXY`, `HTTPS_PROXY`,
   `NO_PROXY`, `NODE_EXTRA_CA_CERTS`; POSIX additionally accepts exactly the
   lowercase `http_proxy`, `https_proxy`, and `no_proxy`. On Windows, inherited
   names are compared case-insensitively and emitted under those canonical
   uppercase names; on POSIX comparison is exact. Before selection, every name
   whose uppercase form starts with `CONTEXT7_API_KEY` is discarded. The
   implementation never spreads `process.env`, discards any inherited
   `NANOFLOW_CONTEXT7_FAILURE_MARKER`, and the test asserts that the final sorted
   key set equals this algorithm's union plus the factory-generated marker with
   no extras. The factory
   uses raw `client.request` with `ListToolsResultSchema` and
   `CallToolResultSchema`, explicit timeout and AbortSignal options, and
   `StdioClientTransport` with `stderr: 'ignore'`; its implementation spawns
   with `shell: false`.
   The child return value is `{ tools, callTool, close, onExit }`; `callTool`
   preserves the schema-parsed standard result under `result` and separately
   returns nullable trusted `failureEvidence`.
   `onExit(listener)` subscribes to the SDK client's close notification and
   returns an unsubscribe function. Runtime, not the child, assigns a monotonic
   generation number; an exit invalidates active state only when generation and
   child identity still match.
   `fake-context7-upstream-fetch.cjs` is test-only, contains no network or key
   handling, and replaces global fetch only for the two exact Context7 URLs with
   deterministic `Response` objects selected by non-secret fixture flags. It is
   never reachable from production factory configuration.
6. Run the child spec and `node --check` on all four CJS files, inspect the package
   diff for unrelated edits, commit only the seven paths with
   `feat(context7): supervise pinned MCP child`, then release leases.

## Task 5: FIFO runtime, schema stability and bounded retry routing

**Files:**

- Create `scripts/context7-key-pool/runtime.cjs`
- Create `src/tests/scripts/context7-key-pool/runtime.spec.ts`

### Exact helper contracts

```javascript
validateOfficialToolArguments('resolve-library-id', { libraryName, query });
validateOfficialToolArguments('query-docs', { libraryId, query });
// Throws Context7PoolError('input-invalid') before preview/reservation.

classifyToolResult({ result, failureEvidence });
classifyThrownError(error);
// -> null
// | { kind: 'auth-invalid' }
// | { kind: 'rate-limit', retryAfterMs }
// | { kind: 'quota-exhausted' }
// | { kind: 'terminal-non-success', statusCode }
// | { kind: 'transient' }
// | { kind: 'input-invalid' }

outcomeForClassification(classification);
// null -> { kind: 'success' }
// Every non-null branch projects to the same-named policy outcome, retaining
// only retryAfterMs or statusCode where that exact outcome permits it.

canonicalToolSignature(tools);
// Stable recursive key ordering over the complete tool descriptors.
```

`Context7PoolError` stores only `kind`, a fixed safe message
`context7-pool-<kind>`, and redacted structured details. Argument validation
requires a plain object and the exact required non-empty trimmed string fields;
unknown tool names and missing/blank fields are `input-invalid`.

Classifiers never scan arbitrary result text or `error.message` for HTTP digits,
status words, or Retry-After. `classifyToolResult` trusts only the exact
nonce-bound `failureEvidence` produced by Task 4: status 401/403 ->
`auth-invalid`; status 429 plus `retryAfterSeconds` in 1..86400 -> `rate-limit`;
other status 429 -> `quota-exhausted`; 5xx, `kind: transport`, or
`kind: observer-internal` -> `transient`; every other normalized non-2xx status
-> `terminal-non-success` with its integer `statusCode`.
An `isError` result without trusted evidence is transient; a normal result
without trusted evidence is success even if its content contains `401`, `429`,
`unauthorized`, or a public marker prefix. `classifyThrownError` uses only typed
SDK/Node properties: JSON-RPC code `-32602` -> `input-invalid`; internal deadline
abort, SDK connection-closed/request-timeout, `EPIPE`, `ECONNRESET`,
`ECONNABORTED`, `ETIMEDOUT`, child close, and every unknown throw -> `transient`.
Caller cancellation is detected from the caller signal identity and propagated,
not classified for retry. All final failure objects are recursively redacted and
capped at 4096 UTF-8 bytes after classification; truncation affects only returned
diagnostics, never routing evidence. A nonce-validated marker result is consumed
internally and is never returned as normal content; if retries/fallback cannot
produce a success, runtime creates its own fixed, redacted MCP `isError: true`
result.

`outcomeForClassification()` is the only runtime-to-store handoff. It creates a
fresh allowlisted object and never forwards classifier/control/diagnostic fields.
The exact stored-shape regression covers every union branch, including
`{ kind: 'terminal-non-success', statusCode: 404 }`, and proves no `retryable`,
result content, query, marker, error or child metadata reaches `recordOutcome`.

### Steps

1. Claim both paths.
2. Write RED tests for:
   - two concurrent calls produce exact FIFO event order;
   - invalid arguments never preview, reserve, start a child or dispatch;
   - child is initialized and schema-checked before `reserveExpected`;
   - a route change between preview and reserve closes/switches without count;
   - when a prepared keyed route becomes fail-closed anonymous at reservation,
     runtime closes the keyed child, prepares/validates an anonymous child, and
     never dispatches the keyed child without a keyed token;
   - success records outcome by reservation token after dispatch;
   - every classifier branch reaches `recordOutcome` only through
     `outcomeForClassification`, with exact allowlisted stored shape and no
     retry/control/result fields;
   - outcome-persistence failure never re-dispatches an already completed
     upstream attempt; the result returns safely and the runtime permanently
     latches fail-closed anonymous until that parent runtime is closed/restarted;
   - four consecutive 401/403 results dispatch slots 1,2,3,4 and then one
     anonymous attempt; 429 with Retry-After and 429 without Retry-After switch;
   - normalized 400/404/422 and other terminal non-2xx responses settle once,
     do not increment `successfulCalls`, do not switch Keys, and return a fixed
     redacted error; observer-internal evidence follows bounded transient retry;
   - transient attempts 1 and 2 use the same fingerprint; attempt 3 excludes it;
   - each keyed dispatch has a distinct token and reservation;
   - thrown timeout, child exit, broken pipe and explicit 5xx use bounded retry;
   - every final `isError` result and thrown error is recursively sanitized,
     while argument/query text containing strings such as `401` or `429` cannot
     create auth/quota state transitions;
   - all keyed routes unavailable creates anonymous child; anonymous failure returns once;
   - replacement child schema drift fails before reservation;
   - child factory failure clears active generation and does not reuse a closed child;
   - every dispatch captures its exact child object, runtime generation and
     reservation; replacement/exit cannot attribute that result or evidence to
     a newer child/Key, and a previous-generation marker is never trusted by a
     newer child's extractor;
   - mixed errors stop at the nine-dispatch absolute ceiling;
   - process-local public counters increment only at actual keyed/anonymous
     dispatch and contain no request content;
   - `close()` rejects new work, aborts an active hang, closes the child and does
     not wait behind the FIFO indefinitely.
   - a call cancelled while queued never previews/reserves/dispatches, and
     shutdown during retry backoff produces no later dispatch.
3. Implement `createPoolRuntime({ credentials, store, childFactory, now, sleep,
   timeZone, redact, onEvent, operationTimeoutMs: 70000 })`. `listTools()` performs preview -> child prepare ->
   full schema capture without reservation. `callTool()` performs validation ->
   preview -> child prepare/schema compare -> `reserveExpected`; `kind: retry`
   loops without dispatch, `kind: keyed` dispatches with its token, and
   `kind: anonymous` first requires an anonymous child that matches the returned
   route, then dispatches once without recording an outcome. If a keyed child
   was prepared for preview, it is closed before anonymous preparation; child
   identity and keyed token must match at the final dispatch assertion.
   Immediately before the child call, runtime captures
   `{ dispatchedChild, dispatchedGeneration, reservation }`. Classification and
   `recordOutcome` use only the result Promise returned by that captured child
   and the captured reservation. The exit listener may clear/replace `active`
   only when its object and generation still match, but that does not rebind an
   already dispatched result to the replacement. Evidence is never accepted by
   a different child object's extractor or generation.
   `callTool(name, args, { signal })` starts its 70-second
   deadline before joining the FIFO, combines it with the caller signal, checks
   both before every preview/reserve/dispatch, and uses an abortable retry delay.
   The factory returns exactly
   `{ listTools, callTool, getPublicRuntime, getRouteOverride, close }`.
   `getPublicRuntime()` is side-effect free and returns a fresh object exactly
   `{ instanceId_12, startedAt, keyedDispatches, anonymousDispatches }`.
   `instanceId_12` is random once per parent runtime; the two counters start at
   zero and increment only immediately before an actual child dispatch.
   `getRouteOverride()` is side-effect free and returns `null` normally or
   `{ kind: 'anonymous', reason: 'outcome-persistence-failed' }` while the
   storage-fault latch is set.
   A `recordOutcome` persistence error sets a process-local, one-way
   `storageFaultLatched` flag. While latched, preview/reservation are bypassed,
   every later official call uses only anonymous routing with reason
   `outcome-persistence-failed`, and no automatic probe can clear the flag.
   Only `close()` followed by a new parent/runtime instance permits keyed routing
   again, at which point normal mirrored-store recovery remains authoritative.
4. The queue uses a promise tail for ordering, but `close()` bypasses the tail:
   it sets `closing`, aborts the current controller, detaches `active`, closes
   the child with a five-second bound, and then observes the tail rejection.
5. Event objects are allowlisted and contain only event name, slot, short
   fingerprint, ordinal, attempt count and normalized failure class. Tool names,
   query text, raw result content and stderr are not event fields.
6. Run RED, then GREEN:

```powershell
npx vitest run --config vitest.config.mts src/tests/scripts/context7-key-pool/runtime.spec.ts
node --check scripts/context7-key-pool/runtime.cjs
```

7. Commit only both paths with `feat(context7): add durable pool runtime`, then
   release leases.

## Task 6: Stable parent MCP, public status and fake stress/crash proof

**Files:**

- Create `scripts/context7-key-pool-mcp.cjs`
- Create `src/tests/scripts/context7-key-pool/mcp.spec.ts`
- Create `src/tests/scripts/context7-key-pool/stress.spec.ts`

### Steps

1. Claim all three paths.
2. Write RED subprocess tests that connect with SDK `Client` and assert:
   - tools are exactly `resolve-library-id`, `query-docs`, and
     `context7-pool-status`, with official descriptors preserved;
   - one official call increments `attemptedCalls` once and parent PID remains;
   - switching at 950 replaces the child while the same parent client continues;
   - a child crash is recovered without closing parent stdio;
   - local status does not start/call a child;
   - status recursively excludes raw synthetic secrets, 64-char fingerprints,
     state paths, query text and stderr;
   - parent bootstrap failure emits one normalized stderr class and exits
     nonzero before MCP connection; child/tool-call failures return a redacted
     MCP `isError` while the connected parent remains alive;
   - stdin end and SIGTERM close the active child;
   - fake-child command/args overrides are ignored unless both `NODE_ENV=test`
     and `CONTEXT7_POOL_TEST_FIXTURE=1`, and the resolved entry remains under
     `src/tests/fixtures/context7-key-pool`;
   - `--status` uses `inspectStored()`, prints one redacted JSON document and
     exits without requiring four credentials or starting stdio; missing state
     reports `mode: "uninitialized"`, while unreadable/corrupt stored state
     reports anonymous `state-unavailable-fail-closed` rather than first run.
3. The low-level parent uses SDK `Server`, `StdioServerTransport`,
   `ListToolsRequestSchema`, and `CallToolRequestSchema`. The status handler reads
   the store without starting a child and calls:

```javascript
const routeOverride = runtime.getRouteOverride();
projectPublicStatus({
  ...storedSnapshot,
  ...(routeOverride ? { activeRoute: routeOverride } : {}),
  runtime: runtime.getPublicRuntime(),
});
```

   Every other call passes `extra.signal` from the SDK request handler through runtime. Top-level
   stderr is a fixed normalized class produced after redaction, never raw
   `error.message`.
   The status response is
   `{ content: [{ type: 'text', text: JSON.stringify(status) }],
   structuredContent: status }` and its advertised descriptor is exactly
   `STATUS_TOOL`.
4. Stress spec performs 1000 fake successful calls and asserts slot 1 is exactly
   950 and slot 2 exactly 50. It then restarts the parent on the same temporary
   state directory and verifies the next reservation is slot 2 ordinal 51.
5. Crash spec kills a reservation worker after mirrored persistence but before
   fake response and proves restart retains the conservative count. A second
   test runs two parent processes sharing one state directory and verifies the
   combined count.
6. Run:

```powershell
npx vitest run --config vitest.config.mts src/tests/scripts/context7-key-pool/mcp.spec.ts
npx vitest run --config vitest.config.mts src/tests/scripts/context7-key-pool/stress.spec.ts
node --check scripts/context7-key-pool-mcp.cjs
```

7. Commit only the three paths with `feat(context7): expose stable key-pool MCP`,
   then release leases.

## Task 7: Hidden setup, smoke, package gates, security contract and Chinese operations

**Files:**

- Create `scripts/configure-context7-key-pool.ps1`
- Create `scripts/smoke-context7-key-pool.cjs`
- Create `docs/context7-key-pool-operations.md`
- Modify `package.json`
- Modify `src/tests/contracts/tooling-security.contract.spec.ts`
- Create `src/tests/scripts/context7-key-pool/configuration.spec.ts`

### Steps

1. Wait for `package.json` to be lease-free and require both its worktree and
   index views to be clean before and immediately after claiming all six paths.
   Also require `.vscode/mcp.json` clean in both views and record its SHA-256 as
   non-secret task evidence. Any existing diff blocks this task; do not absorb or
   revert it:

```powershell
git diff --quiet -- package.json .vscode/mcp.json
if ($LASTEXITCODE -ne 0) { throw 'task7-worktree-attribution-not-clean' }
git diff --cached --quiet -- package.json .vscode/mcp.json
if ($LASTEXITCODE -ne 0) { throw 'task7-index-attribution-not-clean' }
Get-FileHash .vscode/mcp.json -Algorithm SHA256
node scripts/agent-file-lease.cjs --owner codex-context7-key-pool claim scripts/configure-context7-key-pool.ps1 scripts/smoke-context7-key-pool.cjs docs/context7-key-pool-operations.md package.json src/tests/contracts/tooling-security.contract.spec.ts src/tests/scripts/context7-key-pool/configuration.spec.ts
git diff --quiet -- package.json .vscode/mcp.json
if ($LASTEXITCODE -ne 0) { throw 'task7-worktree-drift-after-claim' }
git diff --cached --quiet -- package.json .vscode/mcp.json
if ($LASTEXITCODE -ne 0) { throw 'task7-index-drift-after-claim' }
```
2. Write RED configuration/security tests that assert:
   - PowerShell accepts only non-secret `-RunRealSmoke` and
     `-UseExistingUserKeys` switches, calls `Read-Host -AsSecureString` four
     times in interactive mode, and never
     accepts a Key argument;
   - it collects all four plaintext values in memory, validates non-empty and
     exact (no surrounding whitespace) and distinct fingerprints before the
     first User-scope write, snapshots prior
     User values, and rolls all four back if any write fails;
   - it sets the four variables in its own process before optional real smoke;
   - every SecureString BSTR is released with `ZeroFreeBSTR`, and plaintext
     collection entries are nulled after setup/smoke completes;
   - package dependencies are exact `1.25.1` and `2.1.1`, the SDK override is
     exact `1.25.1`, and every lockfile SDK occurrence resolves to `1.25.1`;
   - package scripts equal the commands below;
   - `.vscode/mcp.json` contains no plaintext/default Context7 secret;
   - new source/config/docs contain none of the four process secret values.
3. Package scripts are exact and use a directory filter that works on Windows:

```json
{
  "context7:pool:test": "vitest run --config vitest.config.mts src/tests/scripts/context7-key-pool",
  "context7:pool:status": "node scripts/context7-key-pool-mcp.cjs --status",
  "context7:pool:smoke": "node scripts/smoke-context7-key-pool.cjs"
}
```

4. `configure-context7-key-pool.ps1` writes only after all validation. It emits
   `slot=<n> length=<n> fingerprint=<12 hex>` and no raw value. With
   `-RunRealSmoke`, it sets the four process env variables and launches
   `node scripts/smoke-context7-key-pool.cjs --real` so the new values are used
   without relying on the already-running Codex environment.
   `-UseExistingUserKeys` performs no prompt/write: it reads all four User-scope
   values, compares full hashes in memory, sets only the child-process env, and
   is the exact post-setup launcher used by Task 8.
5. Fake smoke creates a temporary state directory, supplies four synthetic
   values only to the subprocess, calls both official fake tools, calls status,
   asserts exactly two keyed attempts, and prints a non-secret JSON summary.
   `--real` requires four current process variables and connects an SDK Client
   to a fresh parent wrapper (which starts the real pinned child). It must use
   the production default `%LOCALAPPDATA%\NanoFlow\context7-key-pool\` state
   directory; `--real` rejects test state-directory/fixture overrides so it
   cannot bypass the shared 950 ceiling. It reads public status before and after
   resolving `next.js` to `/vercel/next.js` and querying App Router docs, requires
   the same `runtime.instanceId_12`, and asserts the process-local
   `keyedDispatches + anonymousDispatches` delta is exactly two. Durable aggregate
   attempts may already be higher. Output contains only booleans, slots, lengths
   and 12-character fingerprints.
6. Write `docs/context7-key-pool-operations.md` in detailed Chinese with exact
   install/setup commands, non-secret output examples, status field definitions,
   UTC/IANA reset behavior, anonymous behavior, corruption/fail-closed recovery,
   event/state locations, full host restart, uninstall, and rollback to the
   original single-Key config. State clearly that fake, fresh-process and
   live-host evidence are different boundaries.
7. Run:

```powershell
npm run context7:pool:test
npx vitest run --config vitest.config.mts src/tests/contracts/tooling-security.contract.spec.ts
npm run context7:pool:smoke
npm run context7:pool:status
npm run audit:secrets
```

   Then require `.vscode/mcp.json` still equals the clean index/HEAD baseline and
   record its SHA-256 again; otherwise stop without committing:

```powershell
git diff --quiet -- .vscode/mcp.json
if ($LASTEXITCODE -ne 0) { throw 'vscode-mcp-worktree-changed' }
git diff --cached --quiet -- .vscode/mcp.json
if ($LASTEXITCODE -ne 0) { throw 'vscode-mcp-index-changed' }
Get-FileHash .vscode/mcp.json -Algorithm SHA256
```

8. Inspect `git diff --check` and the package diff, commit only the six paths
   with `docs(context7): add pool operations and security gates`, then release
   leases. Do not edit `.codex/config.toml` in this task.

## Task 8: Hidden four-Key gate and Codex cutover

**Files:**

- Modify `.codex/config.toml`
- Modify `src/tests/contracts/tooling-security.contract.spec.ts`

### Steps

1. Stop here until the user runs this locally; never ask them to paste Keys:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-context7-key-pool.ps1 -RunRealSmoke
```

   Required evidence is four distinct non-secret fingerprints and
   `realSmoke.ok=true`. The script itself performs programmatic duplicate checks.
2. Re-read User-scope presence without outputting values. Compute and compare
   full hashes in memory; output only length and the first 12 characters. Abort
   if any value is absent, whitespace-invalid, or full hash is duplicated.
3. Claim the two paths. Record their pre-task SHA-256 values and retain the
   scoped pre-task diff in the task evidence. Write and run a RED contract that expects this exact
   project block while the current config still uses `npx`:

```toml
[mcp_servers.context7]
command = "node"
args = ["D:/Code/dde/scripts/context7-key-pool-mcp.cjs"]
env_vars = ["CONTEXT7_API_KEY_1", "CONTEXT7_API_KEY_2", "CONTEXT7_API_KEY_3", "CONTEXT7_API_KEY_4"]
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 90

[mcp_servers.context7.env]
CONTEXT7_POOL_TIME_ZONE = "UTC"
```

4. Apply only that TOML change. Run the contract, `codex mcp list`, and
   `codex mcp get context7`; require exit 0 and masked env names. Run fake smoke
   and this exact User-scope real-smoke launcher again. Do not commit yet:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-context7-key-pool.ps1 -UseExistingUserKeys -RunRealSmoke
```
5. Record post-edit SHA-256 for both files in the task update, release both
   leases, and ask for a full Codex/MCP host restart. On resume, reacquire both
   paths before any repository action and require both hashes to match; any drift
   aborts cutover for attribution. Then call the live
   `resolve-library-id`, live `query-docs`, and live `context7-pool-status`.
   Read status both before and after the two official calls. Require real
   content, a redacted status, the same `runtime.instanceId_12`, and that
   runtime's `keyedDispatches + anonymousDispatches` delta exactly two; durable
   aggregate counts may also include other processes.
6. Only after live-host proof, commit the two paths with
   `feat(context7): activate four-key MCP pool`, then release leases. If live
   proof fails, reacquire both paths and apply the captured inverse scoped patch
   to restore both `.codex/config.toml` and the contract to their pre-task state.
   Run the restored baseline contract, release leases, and report the cutover as
   uncommitted/rolled back.

## Task 9: Complete verification, final review and handoff

1. Run fresh full evidence:

```powershell
npm run context7:pool:test
npx vitest run --config vitest.config.mts src/tests/contracts/tooling-security.contract.spec.ts
npm run context7:pool:smoke
npx vitest run --config vitest.config.mts src/tests/scripts/context7-key-pool/stress.spec.ts
npm run audit:secrets
node --check scripts/context7-key-pool-mcp.cjs
Get-ChildItem scripts/context7-key-pool -Filter *.cjs | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

   Expected: every command exits 0; focused Vitest reports zero failed tests;
   stress asserts 950/50; secret audit reports no finding; every CJS syntax
   check is silent. Capture exact pass/test counts from output.

2. Dispatch a final read-only reviewer over the complete feature range. Fix and
   re-review every Critical or Important finding before proceeding.
3. Recheck scoped Git evidence including all feature paths, package files,
   fixtures, security contract, docs and `.codex/config.toml`. Confirm unrelated
   dirty/staged paths are unchanged and excluded from feature commits.

```powershell
git status --short -- .codex/config.toml package.json package-lock.json scripts/context7-key-pool-mcp.cjs scripts/context7-key-pool scripts/configure-context7-key-pool.ps1 scripts/smoke-context7-key-pool.cjs src/tests/scripts/context7-key-pool src/tests/fixtures/context7-key-pool src/tests/contracts/tooling-security.contract.spec.ts docs/context7-key-pool-operations.md docs/2026-07-30-context7-key-pool-mcp-implementation-plan.md
git log --oneline -- docs/2026-07-30-context7-key-pool-mcp-design.md docs/2026-07-30-context7-key-pool-mcp-implementation-plan.md scripts/context7-key-pool-mcp.cjs scripts/context7-key-pool .codex/config.toml
```

   Expected: no unexplained feature-path work remains; commit path lists contain
   no unrelated pre-existing staged files.
4. Report separately: fake policy/state/stress proof; authenticated fresh-process
   proof; post-restart live-host proof; current public counts/mode; every gate not
   run or still red; and confirmation that no raw Key was printed or committed.
