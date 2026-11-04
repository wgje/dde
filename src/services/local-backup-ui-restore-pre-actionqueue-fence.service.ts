import { Injectable, inject } from '@angular/core';

import { canonicalizePersistedValue } from './action-queue-identity.helpers';
import {
  createLocalBackupUiRestoreJournal,
  type LocalBackupUiRestoreJournal,
} from './local-backup-ui-restore-journal';
import {
  LocalBackupUiRestoreStartupRecoveryService,
  type LocalBackupUiRestoreStartupRecoveryResult,
} from './local-backup-ui-restore-startup-recovery.service';
import {
  isLocalBackupUiRestoreQueueStateCompatible,
  type LocalBackupUiRestoreMarker,
} from './local-backup-ui-restore-types';
import type { QueueBackupRestoreProviderResult } from './queue-backup-restore-provider.helpers';
import { QueueBackupService } from './queue-backup.service';
import type {
  QueueBackupPersonalRestoreIdentityStateV2,
  QueueBackupPersonalRestoreIdentityV2,
  QueueBackupPersonalRestoreTerminalReceiptV2,
} from './action-queue.types';

export interface LocalBackupUiRestorePreActionQueueFenceInput {
  ownerUserId: string;
  isCurrent(): boolean;
}

export type LocalBackupUiRestorePreActionQueueFenceResult =
  | {
    status: 'CLEAR';
    ownerUserId: string;
    recovered: boolean;
    terminalResultDigest: string | null;
  }
  | {
    status: 'HOLD';
    ownerUserId: string;
    reason:
      | 'OWNER_GENERATION_STALE'
      | 'MARKER_READ_FAILED'
      | 'QUEUE_STATE_UNKNOWN'
      | 'RECOVERY_BLOCKED'
      | 'RECOVERY_FAILED'
      | 'TERMINAL_EVIDENCE_INVALID'
      | 'MARKER_NOT_CLEAR';
  };

export interface LocalBackupUiRestorePreActionQueueFenceDependencies {
  createJournal(ownerUserId: string): Pick<LocalBackupUiRestoreJournal, 'read'>;
  recover(ownerUserId: string): Promise<LocalBackupUiRestoreStartupRecoveryResult>;
  readIdentityState(
    identity: QueueBackupPersonalRestoreIdentityV2,
    authenticatedOwnerUserId: string | null,
  ): Promise<QueueBackupPersonalRestoreIdentityStateV2>;
  readProviderEvidence(
    identity: QueueBackupPersonalRestoreIdentityV2,
    authenticatedOwnerUserId: string | null,
  ): Promise<QueueBackupRestoreProviderResult>;
}

export class LocalBackupUiRestorePreActionQueueFenceController {
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: LocalBackupUiRestorePreActionQueueFenceDependencies,
  ) {}

  run(
    input: LocalBackupUiRestorePreActionQueueFenceInput,
  ): Promise<LocalBackupUiRestorePreActionQueueFenceResult> {
    const attempt = this.serial.then(() => this.resolve(input));
    this.serial = attempt.then(() => undefined, () => undefined);
    return attempt;
  }

  private async resolve(
    input: LocalBackupUiRestorePreActionQueueFenceInput,
  ): Promise<LocalBackupUiRestorePreActionQueueFenceResult> {
    if (!input.isCurrent()) return hold(input, 'OWNER_GENERATION_STALE');
    const journal = this.dependencies.createJournal(input.ownerUserId);
    let marker: LocalBackupUiRestoreMarker | null;
    try {
      marker = await journal.read();
    } catch {
      return hold(input, 'MARKER_READ_FAILED');
    }
    if (!input.isCurrent()) return hold(input, 'OWNER_GENERATION_STALE');

    if (marker) {
      let queueState: QueueBackupPersonalRestoreIdentityStateV2;
      try {
        queueState = await this.dependencies.readIdentityState(
          marker.actionQueueRestoreIdentity,
          input.ownerUserId,
        );
      } catch {
        return hold(input, 'QUEUE_STATE_UNKNOWN');
      }
      if (!input.isCurrent()) return hold(input, 'OWNER_GENERATION_STALE');
      if (!isLocalBackupUiRestoreQueueStateCompatible(marker, queueState)) {
        return hold(input, 'QUEUE_STATE_UNKNOWN');
      }
    }

    let recovery: LocalBackupUiRestoreStartupRecoveryResult;
    try {
      recovery = await this.dependencies.recover(input.ownerUserId);
    } catch {
      return hold(input, 'RECOVERY_FAILED');
    }
    if (!input.isCurrent()) return hold(input, 'OWNER_GENERATION_STALE');
    if (recovery.status === 'blocked') return hold(input, 'RECOVERY_BLOCKED');

    let terminalResultDigest: string | null = null;
    if (marker) {
      let evidence: QueueBackupRestoreProviderResult;
      try {
        evidence = await this.dependencies.readProviderEvidence(
          marker.actionQueueRestoreIdentity,
          input.ownerUserId,
        );
      } catch {
        return hold(input, 'TERMINAL_EVIDENCE_INVALID');
      }
      if (!input.isCurrent()) return hold(input, 'OWNER_GENERATION_STALE');
      const receipt = requireTerminalReceipt(evidence, marker);
      if (!receipt) return hold(input, 'TERMINAL_EVIDENCE_INVALID');
      terminalResultDigest = receipt.resultDigest;
    }

    let finalMarker: LocalBackupUiRestoreMarker | null;
    try {
      finalMarker = await journal.read();
    } catch {
      return hold(input, 'MARKER_READ_FAILED');
    }
    if (!input.isCurrent()) return hold(input, 'OWNER_GENERATION_STALE');
    if (finalMarker !== null) return hold(input, 'MARKER_NOT_CLEAR');
    return {
      status: 'CLEAR',
      ownerUserId: input.ownerUserId,
      recovered: recovery.status === 'recovered',
      terminalResultDigest,
    };
  }
}

@Injectable({ providedIn: 'root' })
export class LocalBackupUiRestorePreActionQueueFenceService {
  private readonly recovery = inject(LocalBackupUiRestoreStartupRecoveryService);
  private readonly queueBackup = inject(QueueBackupService);
  private readonly controller = new LocalBackupUiRestorePreActionQueueFenceController({
    createJournal: ownerUserId => createLocalBackupUiRestoreJournal(ownerUserId),
    recover: ownerUserId => this.recovery.recover(ownerUserId),
    readIdentityState: (identity, ownerUserId) =>
      this.queueBackup.readPersonalRestoreIdentityState(identity, ownerUserId),
    readProviderEvidence: (identity, ownerUserId) =>
      this.queueBackup.readPersonalRestoreProviderEvidence(identity, ownerUserId),
  });

  run(
    input: LocalBackupUiRestorePreActionQueueFenceInput,
  ): Promise<LocalBackupUiRestorePreActionQueueFenceResult> {
    return this.controller.run(input);
  }
}

function hold(
  input: LocalBackupUiRestorePreActionQueueFenceInput,
  reason: Extract<LocalBackupUiRestorePreActionQueueFenceResult, { status: 'HOLD' }>['reason'],
): LocalBackupUiRestorePreActionQueueFenceResult {
  return { status: 'HOLD', ownerUserId: input.ownerUserId, reason };
}

function requireTerminalReceipt(
  evidence: QueueBackupRestoreProviderResult,
  marker: LocalBackupUiRestoreMarker,
): QueueBackupPersonalRestoreTerminalReceiptV2 | null {
  const identity = marker.actionQueueRestoreIdentity;
  if (evidence.status !== 'READABLE' || evidence.storage !== 'READBACK_CONFIRMED'
    || evidence.snapshotSignature === null || !sameIdentity(evidence.identity, identity)
    || evidence.catalog.status !== 'PRESENT_VALID'
    || evidence.receipt.status !== 'PRESENT_VALID'
    || evidence.terminal.status !== 'TERMINAL_CONFIRMED') return null;
  const receipt = evidence.terminal.receipt;
  const catalogReceipt = evidence.catalog.value.receipts[identity.receiptId];
  if (!catalogReceipt || !sameIdentity(receipt, identity)
    || receipt.id !== identity.receiptId || receipt.receiptId !== identity.receiptId
    || !isSha256(receipt.resultDigest)
    || evidence.terminal.resultDigest !== receipt.resultDigest
    || evidence.terminal.recordPresent !== receipt.recordPresent
    || !sameValue(receipt, evidence.receipt.value)
    || !sameValue(receipt, catalogReceipt)
    || !isExpectedOutcome(marker, receipt.outcome)) return null;
  return receipt;
}

function isExpectedOutcome(
  marker: LocalBackupUiRestoreMarker,
  outcome: QueueBackupPersonalRestoreTerminalReceiptV2['outcome'],
): boolean {
  if (marker.state === 'completed') return outcome === 'finalized';
  if (marker.state === 'prepared') {
    return outcome === 'rolled-back' || outcome === 'abandoned-before-prepare';
  }
  return outcome === 'rolled-back';
}

function sameIdentity(
  value: QueueBackupPersonalRestoreIdentityV2,
  expected: QueueBackupPersonalRestoreIdentityV2,
): boolean {
  return value.ownerUserId === expected.ownerUserId
    && value.restoreRunId === expected.restoreRunId
    && value.participant === expected.participant
    && value.sourceDigest === expected.sourceDigest
    && value.token === expected.token
    && value.recordId === expected.recordId
    && value.identityDigest === expected.identityDigest
    && value.receiptId === expected.receiptId;
}

function isSha256(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalizePersistedValue(left) === canonicalizePersistedValue(right);
}
