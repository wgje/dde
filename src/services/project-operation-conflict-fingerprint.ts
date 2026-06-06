/**
 * ProjectOperationService 的「冲突指纹 / 匹配」纯函数模块。
 *
 * 从 ProjectOperationService「下切」出的无状态冲突身份判定：把「已持久化冲突记录」与
 * 「当前活动冲突」归并成稳定指纹，并判断当前冲突是否仍与某指纹/快照同一身份，用于避免
 * 重复发布冲突 / 误清理他人冲突。
 *
 * 职责单一、纯函数（无 `this`、无副作用）：
 * - captureConflictFingerprint：stored + active 两路冲突归并出权威指纹（conflictedAt 新者优先）
 * - doesStoredConflictMatchFingerprint：当前持久化冲突是否匹配指纹（owner/版本/待删集逐项比较）
 * - doesActiveConflictMatchSnapshot：当前活动冲突是否与期望快照同一身份
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；ProjectOperationService 长期越界，
 * 这些纯判定自洽且零依赖服务态，适合先行下切。
 */
import { Project } from '../models';

/** 已持久化的冲突记录形态。 */
export interface StoredConflictSnapshot {
  projectId: string;
  ownerUserId?: string;
  conflictedAt: string;
  localVersion: number;
  remoteVersion?: number;
  pendingTaskDeleteIds?: string[];
}

/** 当前活动冲突形态（local/remote 与 localProject/remoteProject 双命名兼容）。 */
export interface ActiveConflictSnapshot {
  projectId?: string;
  conflictedAt?: string;
  local?: Project;
  remote?: Project;
  localProject?: Project;
  remoteProject?: Project;
  pendingTaskDeleteIds?: string[];
}

/** 归并后的冲突指纹。 */
export interface ConflictFingerprint {
  projectId: string;
  ownerUserId: string | null;
  conflictedAt?: string;
  localVersion?: number;
  remoteVersion?: number;
  pendingTaskDeleteIds?: string[];
}

export function captureConflictFingerprint(
  storedConflict: StoredConflictSnapshot | null,
  activeConflict: ActiveConflictSnapshot | null,
  ownerUserId: string | null,
): ConflictFingerprint {
  const activeFingerprint: ConflictFingerprint | null = activeConflict?.projectId
    ? {
        projectId: activeConflict.projectId,
        ownerUserId,
        conflictedAt: activeConflict.conflictedAt,
        localVersion: activeConflict.local?.version ?? activeConflict.localProject?.version,
        remoteVersion: activeConflict.remote?.version ?? activeConflict.remoteProject?.version,
        pendingTaskDeleteIds: [...(activeConflict.pendingTaskDeleteIds ?? [])],
      }
    : null;

  const storedFingerprint: ConflictFingerprint | null = storedConflict
    ? {
        projectId: storedConflict.projectId,
        ownerUserId: storedConflict.ownerUserId ?? ownerUserId,
        conflictedAt: storedConflict.conflictedAt,
        localVersion: storedConflict.localVersion,
        remoteVersion: storedConflict.remoteVersion,
        pendingTaskDeleteIds: [...(storedConflict.pendingTaskDeleteIds ?? [])],
      }
    : null;

  if (activeFingerprint && storedFingerprint) {
    if (!activeFingerprint.conflictedAt) {
      return storedFingerprint;
    }

    if (!storedFingerprint.conflictedAt) {
      return activeFingerprint;
    }

    return storedFingerprint.conflictedAt >= activeFingerprint.conflictedAt
      ? storedFingerprint
      : activeFingerprint;
  }

  if (storedFingerprint) {
    return storedFingerprint;
  }

  if (activeFingerprint) {
    return activeFingerprint;
  }

  return {
    projectId: activeConflict?.projectId ?? '',
    ownerUserId,
    conflictedAt: activeConflict?.conflictedAt,
    localVersion: activeConflict?.local?.version ?? activeConflict?.localProject?.version,
    remoteVersion: activeConflict?.remote?.version ?? activeConflict?.remoteProject?.version,
    pendingTaskDeleteIds: [...(activeConflict?.pendingTaskDeleteIds ?? [])],
  };
}

export function doesStoredConflictMatchFingerprint(
  currentConflict: StoredConflictSnapshot | null,
  fingerprint: ConflictFingerprint,
): boolean {
  if (!currentConflict || currentConflict.projectId !== fingerprint.projectId) {
    return false;
  }

  const currentPendingDeletes = [...(currentConflict.pendingTaskDeleteIds ?? [])].sort();
  const expectedPendingDeletes = [...(fingerprint.pendingTaskDeleteIds ?? [])].sort();

  return (currentConflict.ownerUserId ?? fingerprint.ownerUserId) === fingerprint.ownerUserId
    && (fingerprint.conflictedAt === undefined || currentConflict.conflictedAt === fingerprint.conflictedAt)
    && currentConflict.localVersion === (fingerprint.localVersion ?? currentConflict.localVersion)
    && (currentConflict.remoteVersion ?? 0) === (fingerprint.remoteVersion ?? 0)
    && currentPendingDeletes.length === expectedPendingDeletes.length
    && currentPendingDeletes.every((taskId, index) => taskId === expectedPendingDeletes[index]);
}

export function doesActiveConflictMatchSnapshot(
  currentConflict: ActiveConflictSnapshot | null,
  expectedConflict?: ActiveConflictSnapshot | null,
): boolean {
  if (!currentConflict || !expectedConflict || currentConflict.projectId !== expectedConflict.projectId) {
    return false;
  }

  if (currentConflict === expectedConflict) {
    return true;
  }

  const currentPendingDeletes = [...(currentConflict.pendingTaskDeleteIds ?? [])].sort();
  const expectedPendingDeletes = [...(expectedConflict.pendingTaskDeleteIds ?? [])].sort();
  const currentLocalVersion = currentConflict.local?.version ?? currentConflict.localProject?.version ?? 0;
  const currentRemoteVersion = currentConflict.remote?.version ?? currentConflict.remoteProject?.version ?? 0;
  const expectedLocalVersion = expectedConflict.local?.version ?? expectedConflict.localProject?.version ?? 0;
  const expectedRemoteVersion = expectedConflict.remote?.version ?? expectedConflict.remoteProject?.version ?? 0;

  return (expectedConflict.conflictedAt === undefined || currentConflict.conflictedAt === expectedConflict.conflictedAt)
    && currentLocalVersion === expectedLocalVersion
    && currentRemoteVersion === expectedRemoteVersion
    && currentPendingDeletes.length === expectedPendingDeletes.length
    && currentPendingDeletes.every((taskId, index) => taskId === expectedPendingDeletes[index]);
}
