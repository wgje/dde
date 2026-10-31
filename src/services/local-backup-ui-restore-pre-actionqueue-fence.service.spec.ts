import { describe, expect, it, vi } from 'vitest';

import type {
  QueueBackupPersonalRestoreIdentityV2,
  QueueBackupPersonalRestoreTerminalReceiptV2,
} from './action-queue.types';
import type { LocalBackupUiRestoreMarker } from './local-backup-ui-restore-types';
import type { QueueBackupRestoreProviderResult } from './queue-backup-restore-provider.helpers';
import {
  LocalBackupUiRestorePreActionQueueFenceController,
  type LocalBackupUiRestorePreActionQueueFenceDependencies,
} from './local-backup-ui-restore-pre-actionqueue-fence.service';

const OWNER_USER_ID = 'restore-owner';
const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const RESULT_DIGEST = `sha256:${'b'.repeat(64)}`;
const IDENTITY: QueueBackupPersonalRestoreIdentityV2 = {
  ownerUserId: OWNER_USER_ID,
  restoreRunId: '11111111-1111-4111-8111-111111111111',
  participant: 'action-queue',
  sourceDigest: SOURCE_DIGEST,
  token: '22222222-2222-4222-8222-222222222222',
  recordId: `queue-backup:${OWNER_USER_ID}`,
  identityDigest: `sha256:${'c'.repeat(64)}`,
  receiptId: `queue-backup-personal-restore-receipt:v2:${'c'.repeat(64)}`,
};

describe('LocalBackupUiRestorePreActionQueueFenceController', () => {
  it('returns CLEAR only after an absent marker remains absent after recovery', async () => {
    const context = makeContext([null, null]);
    context.recover.mockResolvedValue({ status: 'none' });

    await expect(context.controller.run(currentInput())).resolves.toEqual({
      status: 'CLEAR',
      ownerUserId: OWNER_USER_ID,
      recovered: false,
      terminalResultDigest: null,
    });
    expect(context.readMarker).toHaveBeenCalledTimes(2);
    expect(context.readIdentityState).not.toHaveBeenCalled();
    expect(context.readProviderEvidence).not.toHaveBeenCalled();
  });

  it('settles an absent prepared participant and verifies exact terminal evidence before CLEAR', async () => {
    const marker = makeMarker();
    const trace: string[] = [];
    const context = makeContext([marker, null], trace);
    context.readIdentityState.mockImplementation(async () => {
      trace.push('queue:state');
      return {
        status: 'absent-for-identity' as const,
        identity: IDENTITY,
        absenceProof: {},
      };
    });
    context.recover.mockImplementation(async () => {
      trace.push('restore:recover');
      return { status: 'recovered' as const };
    });
    context.readProviderEvidence.mockImplementation(async () => {
      trace.push('queue:provider');
      return makeTerminalEvidence('abandoned-before-prepare');
    });

    await expect(context.controller.run(currentInput())).resolves.toEqual({
      status: 'CLEAR',
      ownerUserId: OWNER_USER_ID,
      recovered: true,
      terminalResultDigest: RESULT_DIGEST,
    });
    expect(trace).toEqual([
      'marker:read',
      'queue:state',
      'restore:recover',
      'queue:provider',
      'marker:read',
    ]);
    expect(context.readIdentityState).toHaveBeenCalledWith(IDENTITY, OWNER_USER_ID);
    expect(context.readProviderEvidence).toHaveBeenCalledWith(IDENTITY, OWNER_USER_ID);
  });

  it('returns HOLD without recovery when QueueBackup identity state is unknown', async () => {
    const context = makeContext([makeMarker()]);
    context.readIdentityState.mockResolvedValue({
      status: 'unknown',
      reason: 'storage-unavailable',
    });

    await expectHold(context, 'QUEUE_STATE_UNKNOWN');
    expect(context.recover).not.toHaveBeenCalled();
    expect(context.readProviderEvidence).not.toHaveBeenCalled();
  });

  it('holds incompatible or stale QueueBackup identity state before recovery takeover', async () => {
    const restoring = makeContext([makeMarker({ state: 'restoring', phase: 'projects' })]);
    restoring.readIdentityState.mockResolvedValue({
      status: 'absent-for-identity', identity: IDENTITY, absenceProof: {},
    });
    await expectHold(restoring, 'QUEUE_STATE_UNKNOWN');
    expect(restoring.recover).not.toHaveBeenCalled();

    const stale = makeContext([makeMarker()]);
    stale.readIdentityState.mockResolvedValue({
      status: 'active',
      transition: {
        preparedReceipt: { ...IDENTITY, restoreRunId: 'stale-restore-run' },
      } as never,
    });
    await expectHold(stale, 'QUEUE_STATE_UNKNOWN');
    expect(stale.recover).not.toHaveBeenCalled();

    const staleTerminal = makeContext([
      makeMarker({ state: 'restoring', phase: 'projects' }),
    ]);
    staleTerminal.readIdentityState.mockResolvedValue({
      status: 'terminal',
      receipt: makeTerminalEvidence('abandoned-before-prepare').terminal.receipt,
    });
    await expectHold(staleTerminal, 'QUEUE_STATE_UNKNOWN');
    expect(staleTerminal.recover).not.toHaveBeenCalled();
  });

  it('returns HOLD when startup recovery remains blocked', async () => {
    const context = makeContext([makeMarker()]);
    context.readIdentityState.mockResolvedValue({
      status: 'active',
      transition: makeActiveTransition(),
    });
    context.recover.mockResolvedValue({ status: 'blocked', reason: 'active-or-mutated' });

    await expectHold(context, 'RECOVERY_BLOCKED');
    expect(context.readProviderEvidence).not.toHaveBeenCalled();
  });

  it('returns HOLD on terminal result-digest or identity drift', async () => {
    const marker = makeMarker({ state: 'completed', phase: 'finalizing' });
    const context = makeContext([marker]);
    context.readIdentityState.mockResolvedValue({
      status: 'terminal',
      receipt: makeTerminalEvidence('finalized').terminal.receipt,
    });
    context.recover.mockResolvedValue({ status: 'recovered' });
    const evidence = makeTerminalEvidence('finalized');
    evidence.terminal.resultDigest = `sha256:${'d'.repeat(64)}`;
    context.readProviderEvidence.mockResolvedValue(evidence);

    await expectHold(context, 'TERMINAL_EVIDENCE_INVALID');
    expect(context.readMarker).toHaveBeenCalledTimes(1);
  });

  it('returns HOLD when the marker reappears after terminal verification', async () => {
    const marker = makeMarker();
    const context = makeContext([marker, marker]);
    context.readIdentityState.mockResolvedValue({
      status: 'active',
      transition: makeActiveTransition(),
    });
    context.recover.mockResolvedValue({ status: 'recovered' });
    context.readProviderEvidence.mockResolvedValue(makeTerminalEvidence('rolled-back'));

    await expectHold(context, 'MARKER_NOT_CLEAR');
  });

  it('fails closed on malformed marker reads and owner-generation ABA', async () => {
    const readFailure = makeContext([]);
    readFailure.readMarker.mockRejectedValue(new Error('invalid marker'));
    await expectHold(readFailure, 'MARKER_READ_FAILED');

    let current = true;
    const stale = makeContext([makeMarker()]);
    stale.readIdentityState.mockImplementation(async () => {
      current = false;
      return { status: 'active', transition: makeActiveTransition() };
    });
    await expect(stale.controller.run({
      ownerUserId: OWNER_USER_ID,
      isCurrent: () => current,
    })).resolves.toEqual({
      status: 'HOLD',
      ownerUserId: OWNER_USER_ID,
      reason: 'OWNER_GENERATION_STALE',
    });
    expect(stale.recover).not.toHaveBeenCalled();
  });

  it('serializes overlapping fence attempts without allowing a later attempt to overtake', async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>(resolve => { releaseFirst = resolve; });
    const trace: string[] = [];
    const dependencies = makeDependencies(trace);
    dependencies.createJournal
      .mockReturnValueOnce({ read: vi.fn(async () => {
        trace.push('first:read');
        await firstRead;
        return null;
      }) })
      .mockReturnValueOnce({ read: vi.fn(async () => {
        trace.push('second:read');
        return null;
      }) });
    const controller = new LocalBackupUiRestorePreActionQueueFenceController(dependencies);

    const first = controller.run(currentInput());
    const second = controller.run(currentInput());
    await vi.waitFor(() => expect(trace).toEqual(['first:read']));
    releaseFirst();
    await Promise.all([first, second]);

    expect(trace.indexOf('second:read')).toBeGreaterThan(trace.lastIndexOf('first:read'));
  });
});

function currentInput() {
  return { ownerUserId: OWNER_USER_ID, isCurrent: () => true };
}

async function expectHold(context: ReturnType<typeof makeContext>, reason: string): Promise<void> {
  await expect(context.controller.run(currentInput())).resolves.toEqual({
    status: 'HOLD', ownerUserId: OWNER_USER_ID, reason,
  });
}

function makeContext(markers: Array<LocalBackupUiRestoreMarker | null>, trace: string[] = []) {
  const dependencies = makeDependencies(trace);
  const readMarker = vi.fn(async () => {
    trace.push('marker:read');
    return markers.shift() ?? null;
  });
  dependencies.createJournal.mockReturnValue({ read: readMarker });
  return {
    controller: new LocalBackupUiRestorePreActionQueueFenceController(dependencies),
    readMarker,
    recover: dependencies.recover,
    readIdentityState: dependencies.readIdentityState,
    readProviderEvidence: dependencies.readProviderEvidence,
  };
}

function makeDependencies(trace: string[] = []) {
  return {
    createJournal: vi.fn<LocalBackupUiRestorePreActionQueueFenceDependencies['createJournal']>(),
    recover: vi.fn<LocalBackupUiRestorePreActionQueueFenceDependencies['recover']>(async () => {
      trace.push('restore:recover');
      return { status: 'none' } as const;
    }),
    readIdentityState: vi.fn<LocalBackupUiRestorePreActionQueueFenceDependencies['readIdentityState']>(async () => {
      trace.push('queue:state');
      return { status: 'unknown', reason: 'storage-unavailable' } as const;
    }),
    readProviderEvidence: vi.fn<LocalBackupUiRestorePreActionQueueFenceDependencies['readProviderEvidence']>(async () => {
      trace.push('queue:provider');
      return { status: 'REJECTED', reason: 'AUTH_UNAVAILABLE' } as const;
    }),
  } satisfies LocalBackupUiRestorePreActionQueueFenceDependencies;
}

function makeMarker(
  overrides: Partial<LocalBackupUiRestoreMarker> = {},
): LocalBackupUiRestoreMarker {
  return {
    schemaVersion: 2,
    ownerUserId: OWNER_USER_ID,
    runId: '33333333-3333-4333-8333-333333333333',
    restoreRunId: IDENTITY.restoreRunId,
    actionQueueRestoreIdentity: IDENTITY,
    createdAt: '2026-08-03T00:00:00.000Z',
    leaseExpiresAt: '2026-08-03T00:00:01.000Z',
    state: 'prepared',
    phase: 'pre-image-captured',
    completedStages: [],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: 'restore.json', checksum: SOURCE_DIGEST },
    touchedProjectIds: [],
    preImage: {} as never,
    rollbackErrors: [],
    ...overrides,
  };
}

function makeActiveTransition() {
  return {
    kind: 'queue-backup-personal-restore-transition',
    schemaVersion: 2,
    state: 'prepared',
    id: IDENTITY.recordId,
    preparedReceipt: { ...IDENTITY },
    preimage: [],
    restoredActions: [],
  } as never;
}

function makeTerminalEvidence(outcome: 'finalized' | 'rolled-back' | 'abandoned-before-prepare') {
  const receiptCommon = {
    kind: 'queue-backup-personal-restore-receipt',
    schemaVersion: 2 as const,
    ...IDENTITY,
    id: IDENTITY.receiptId,
    recordPresent: false,
    resultDigest: RESULT_DIGEST,
    completedAt: '2026-08-03T00:00:02.000Z',
  } as const;
  const receipt: QueueBackupPersonalRestoreTerminalReceiptV2 = outcome === 'abandoned-before-prepare'
    ? {
      ...receiptCommon,
      outcome,
      abandonReason: 'marker-committed-before-queue-prepare',
    }
    : {
      ...receiptCommon,
      outcome,
      preimageDigest: `sha256:${'d'.repeat(64)}`,
      restoredDigest: `sha256:${'e'.repeat(64)}`,
      preparedActionsDigest: `sha256:${'f'.repeat(64)}`,
    };
  return {
    status: 'READABLE' as const,
    storage: 'READBACK_CONFIRMED' as const,
    identity: IDENTITY,
    queue: { status: 'ABSENT' as const },
    deadLetters: { status: 'ABSENT' as const },
    catalog: {
      status: 'PRESENT_VALID' as const,
      value: {
        id: `queue-backup-personal-restore-receipts:${OWNER_USER_ID}`,
        kind: 'queue-backup-personal-restore-receipt-catalog' as const,
        schemaVersion: 2 as const,
        ownerUserId: OWNER_USER_ID,
        receiptIds: [IDENTITY.receiptId],
        receipts: { [IDENTITY.receiptId]: receipt },
      },
      rawSignature: 'catalog',
    },
    receipt: { status: 'PRESENT_VALID' as const, value: receipt, rawSignature: 'receipt' },
    terminal: {
      status: 'TERMINAL_CONFIRMED' as const,
      receipt,
      resultDigest: RESULT_DIGEST,
      recordPresent: false,
    },
    snapshotSignature: 'snapshot',
  } satisfies QueueBackupRestoreProviderResult;
}
